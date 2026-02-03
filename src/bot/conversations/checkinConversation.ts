import type { Conversation } from "@grammyjs/conversations";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { type Context } from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import { photosDirectory } from "../../constants.js";
import { checkinRecommendations, checkinWindows, checkins, goals, participants } from "../../db/schema.js";
import type { BotContext } from "../context.js";
import type { FileStore } from "../../services/fileStore.js";
import type { OpenRouterClient } from "../../services/openRouter.js";

type Deps = {
  db: BetterSQLite3Database;
  now: () => number;
  files: FileStore;
  llm?: OpenRouterClient;
};

type PhotoKey = "front" | "left" | "right" | "back";

export async function checkinConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  participantId: number,
  windowId: number,
  deps: Deps
) {
  if (!ctx.chat || ctx.chat.type !== "private") {
    await ctx.reply("Чек-ин сдаётся только в личке с ботом.");
    return;
  }
  if (!ctx.from) {
    await ctx.reply("Не удалось определить пользователя.");
    return;
  }

  const init = await conversation.external(() => {
    const participant = deps.db.select().from(participants).where(eq(participants.id, participantId)).get();
    const window = deps.db.select().from(checkinWindows).where(eq(checkinWindows.id, windowId)).get();
    const existing = deps.db
      .select()
      .from(checkins)
      .where(and(eq(checkins.participantId, participantId), eq(checkins.windowId, windowId)))
      .get();
    return { participant, window, existing };
  });

  if (!init.participant || init.participant.userId !== ctx.from.id) {
    await ctx.reply("Нет доступа.");
    return;
  }
  if (!init.window || init.window.challengeId !== init.participant.challengeId) {
    await ctx.reply("Окно чек-ина не найдено.");
    return;
  }
  if (init.window.status !== "open") {
    await ctx.reply("Окно чек-ина сейчас закрыто.");
    return;
  }
  if (init.existing) {
    await ctx.reply("Вы уже сдали чек-ин в этом окне ✅");
    await conversation.external(() => {
      deps.db
        .update(participants)
        .set({ pendingCheckinWindowId: null, pendingCheckinRequestedAt: null })
        .where(eq(participants.id, participantId))
        .run();
    });
    return;
  }
  if (init.participant.status !== "active") {
    await ctx.reply("Чек-ин доступен только активным участникам.");
    return;
  }

  const window = init.window;

  await ctx.reply(`Чек-ин #${window.windowNumber}. Введите вес (кг), 30–150:`);
  const weight = await readNumber(conversation, ctx.from.id, 30, 150);

  await ctx.reply("Введите талию (см), 40–150:");
  const waist = await readNumber(conversation, ctx.from.id, 40, 150);

  const photoPrompts: Record<PhotoKey, string> = {
    front: "Фото 1/4 (анфас):",
    left: "Фото 2/4 (профиль слева):",
    right: "Фото 3/4 (профиль справа):",
    back: "Фото 4/4 (со спины):"
  };

  const photoIds: Record<PhotoKey, string> = {
    front: await askPhoto(
      conversation,
      ctx,
      window.windowNumber,
      participantId,
      deps,
      photoPrompts.front,
      "front"
    ),
    left: await askPhoto(
      conversation,
      ctx,
      window.windowNumber,
      participantId,
      deps,
      photoPrompts.left,
      "left"
    ),
    right: await askPhoto(
      conversation,
      ctx,
      window.windowNumber,
      participantId,
      deps,
      photoPrompts.right,
      "right"
    ),
    back: await askPhoto(
      conversation,
      ctx,
      window.windowNumber,
      participantId,
      deps,
      photoPrompts.back,
      "back"
    )
  };

  let allowRecommendations = true;
  if (deps.llm?.validateCheckinPhotos) {
    const maxAttempts = 2;
    let valid = false;
    let attempted = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const validation = await conversation.external(async () => {
          const photosBase64 = await loadCheckinPhotosBase64(
            participantId,
            window.windowNumber
          );
          return deps.llm!.validateCheckinPhotos({ photosBase64Jpeg: photosBase64 });
        });
        attempted = true;

        if (validation.isValid) {
          valid = true;
          break;
        }

        const labels: Record<PhotoKey, string> = {
          front: "анфас",
          left: "профиль слева",
          right: "профиль справа",
          back: "со спины"
        };
        const invalidList = validation.invalidPhotos.map((k) => labels[k]).join(", ");
        await ctx.reply(
          `На фото не видно человека: ${invalidList}. Пришлите эти фото ещё раз, пожалуйста.`
        );

        if (attempt === maxAttempts - 1) break;

        for (const key of validation.invalidPhotos) {
          photoIds[key] = await askPhoto(
            conversation,
            ctx,
            init.window.windowNumber,
            participantId,
            deps,
            photoPrompts[key],
            key
          );
        }
      } catch {
        break;
      }
    }

    if (attempted && !valid) {
      allowRecommendations = false;
      await ctx.reply(
        "Чек-ин принят, но рекомендации не сформированы — фото распознаны неуверенно. В следующий раз пришлите фото с человеком в полный рост."
      );
    }
  }

  const ts = await conversation.now();
  const checkinId = await conversation.external(() => {
    const inserted = deps.db
      .insert(checkins)
      .values({
        participantId,
        windowId,
        weight,
        waist,
        photoFrontId: photoIds.front,
        photoLeftId: photoIds.left,
        photoRightId: photoIds.right,
        photoBackId: photoIds.back,
        submittedAt: ts
      })
      .returning({ id: checkins.id })
      .get();

    const p = deps.db.select().from(participants).where(eq(participants.id, participantId)).get();
    if (p) {
      deps.db
        .update(participants)
        .set({
          completedCheckins: p.completedCheckins + 1,
          totalCheckins: p.totalCheckins + 1,
          pendingCheckinWindowId: null,
          pendingCheckinRequestedAt: null
        })
        .where(eq(participants.id, participantId))
        .run();
    }

    return inserted.id;
  });

  await ctx.reply(`Принято ✅\nВес: ${weight}\nТалия: ${waist}`);

  if (deps.llm && allowRecommendations) {
    try {
      const rec = await conversation.external(async () => {
        const p = deps.db.select().from(participants).where(eq(participants.id, participantId)).get();
        const goal = deps.db.select().from(goals).where(eq(goals.participantId, participantId)).get();
        if (!p || !goal) return null;

        const history = deps.db
          .select()
          .from(checkins)
          .where(eq(checkins.participantId, participantId))
          .orderBy(checkins.submittedAt)
          .all();

        const historyText = history
          .slice(-5)
          .map((c) => `${new Date(c.submittedAt).toLocaleDateString("ru-RU")}: ${c.weight} кг, ${c.waist} см`)
          .join("\n");

        const photosBase64Map = await loadCheckinPhotosBase64(participantId, init.window!.windowNumber);
        const photosBase64 = [
          photosBase64Map.front,
          photosBase64Map.left,
          photosBase64Map.right,
          photosBase64Map.back
        ];

        const analysis = await deps.llm!.analyzeCheckin({
          track: (p.track as any) ?? "cut",
          goalWeight: goal.targetWeight,
          goalWaist: goal.targetWaist,
          startWeight: p.startWeight ?? 0,
          startWaist: p.startWaist ?? 0,
          heightCm: p.height ?? 0,
          currentWeight: weight,
          currentWaist: waist,
          historyText,
          photosBase64Jpeg: photosBase64
        });

        deps.db
          .insert(checkinRecommendations)
          .values({
            checkinId,
            participantId,
            progressAssessment: analysis.recommendation.progress_assessment,
            bodyCompositionNotes: analysis.recommendation.body_composition_notes,
            nutritionAdvice: analysis.recommendation.nutrition_advice,
            trainingAdvice: analysis.recommendation.training_advice,
            motivationalMessage: analysis.recommendation.motivational_message,
            warningFlags: JSON.stringify(analysis.recommendation.warning_flags),
            llmModel: analysis.llmModel,
            tokensUsed: analysis.tokensUsed ?? null,
            processingTimeMs: analysis.processingTimeMs,
            createdAt: ts
          })
          .onConflictDoNothing()
          .run();

        return analysis.recommendation;
      });

      if (rec) {
        const msg = `*Рекомендации по чек-ину:*
\n*Прогресс:* ${rec.progress_assessment}
\n*Визуально:* ${rec.body_composition_notes}
\n*Питание:* ${rec.nutrition_advice}
\n*Тренировки:* ${rec.training_advice}
\n*Мотивация:* ${rec.motivational_message}`;
        await ctx.reply(msg, { parse_mode: "Markdown" });
      }
    } catch {
      await ctx.reply("Отличная работа! Продолжайте в том же духе 💪");
    }
  } else if (!deps.llm) {
    await ctx.reply("Отличная работа! Продолжайте в том же духе 💪");
  }
}

async function readNumber(
  conversation: Conversation<BotContext, Context>,
  userId: number,
  min: number,
  max: number
): Promise<number> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msgCtx = await conversation.waitFor("message:text").andFrom(userId);
    const raw = msgCtx.msg.text.trim().replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    await msgCtx.reply(`Введите число в диапазоне ${min}–${max}.`);
  }
}

async function loadCheckinPhotosBase64(
  participantId: number,
  windowNumber: number
): Promise<Record<PhotoKey, string>> {
  const baseDir = path.join(photosDirectory, String(participantId), `checkin-${windowNumber}`);
  const files: Record<PhotoKey, string> = {
    front: path.join(baseDir, "front.jpg"),
    left: path.join(baseDir, "left.jpg"),
    right: path.join(baseDir, "right.jpg"),
    back: path.join(baseDir, "back.jpg")
  };

  const result: Record<PhotoKey, string> = {
    front: "",
    left: "",
    right: "",
    back: ""
  };

  const keys: PhotoKey[] = ["front", "left", "right", "back"];
  for (const key of keys) {
    const buf = await fs.readFile(files[key]);
    result[key] = `data:image/jpeg;base64,${buf.toString("base64")}`;
  }

  return result;
}

async function askPhoto(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  windowNumber: number,
  participantId: number,
  deps: Deps,
  prompt: string,
  name: "front" | "left" | "right" | "back"
): Promise<string> {
  await ctx.reply(prompt);
  const photoCtx = await conversation.waitFor("message:photo").andFrom(ctx.from!.id);
  const photo = photoCtx.msg.photo?.at(-1);
  if (!photo) {
    await photoCtx.reply("Не вижу фото. Попробуйте ещё раз.");
    return askPhoto(conversation, ctx, windowNumber, participantId, deps, prompt, name);
  }
  const fileId = photo.file_id;
  const file = await photoCtx.api.getFile(fileId);
  if (!file.file_path) {
    await photoCtx.reply("Не удалось получить файл из Telegram. Попробуйте ещё раз.");
    return askPhoto(conversation, ctx, windowNumber, participantId, deps, prompt, name);
  }
  const url = `https://api.telegram.org/file/bot${photoCtx.api.token}/${file.file_path}`;
  const dest = path.join(photosDirectory, String(participantId), `checkin-${windowNumber}`, `${name}.jpg`);
  await conversation.external(() => deps.files.downloadToFile(url, dest));
  return fileId;
}
