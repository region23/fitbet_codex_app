import type { Conversation } from "@grammyjs/conversations";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { InlineKeyboard, type Context } from "grammy";
import path from "node:path";
import { photosDirectory } from "../../constants.js";
import { checkinWindows, checkins, participants } from "../../db/schema.js";
import type { BotContext } from "../context.js";
import type { FileStore } from "../../services/fileStore.js";

type Deps = {
  db: BetterSQLite3Database;
  now: () => number;
  files: FileStore;
};

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

  await ctx.reply(`Чек-ин #${init.window.windowNumber}. Введите вес (кг), 30–150:`);
  const weight = await readNumber(conversation, ctx.from.id, 30, 150);

  await ctx.reply("Введите талию (см), 40–150:");
  const waist = await readNumber(conversation, ctx.from.id, 40, 150);

  const photoIds: Record<"front" | "left" | "right" | "back", string> = {
    front: await askPhoto(conversation, ctx, init.window.windowNumber, participantId, deps, "Фото 1/4 (анфас):", "front"),
    left: await askPhoto(conversation, ctx, init.window.windowNumber, participantId, deps, "Фото 2/4 (профиль слева):", "left"),
    right: await askPhoto(conversation, ctx, init.window.windowNumber, participantId, deps, "Фото 3/4 (профиль справа):", "right"),
    back: await askPhoto(conversation, ctx, init.window.windowNumber, participantId, deps, "Фото 4/4 (со спины):", "back")
  };

  const ts = await conversation.now();
  await conversation.external(() => {
    deps.db
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
      .run();

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
  });

  await ctx.reply(`Принято ✅\nВес: ${weight}\nТалия: ${waist}`);
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

