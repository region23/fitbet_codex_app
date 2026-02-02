import type { Conversation } from "@grammyjs/conversations";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { InlineKeyboard, type Context } from "grammy";
import path from "node:path";
import { photosDirectory } from "../../constants.js";
import { goals, participantCommitments, participants } from "../../db/schema.js";
import type { AppEnv } from "../../config.js";
import type { BotContext } from "../context.js";
import type { FileStore } from "../../services/fileStore.js";

type Deps = {
  db: BetterSQLite3Database;
  env: AppEnv;
  now: () => number;
  files: FileStore;
};

export async function onboardingConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  participantId: number,
  deps: Deps
) {
  if (!ctx.chat || ctx.chat.type !== "private") {
    await ctx.reply("Онбординг доступен только в личке с ботом.");
    return;
  }
  if (!ctx.from) {
    await ctx.reply("Не удалось определить пользователя.");
    return;
  }

  const initialParticipant = await conversation.external(() =>
    deps.db.select().from(participants).where(eq(participants.id, participantId)).get()
  );

  if (!initialParticipant || initialParticipant.userId !== ctx.from.id) {
    await ctx.reply("Не удалось найти вашу анкету участия. Вернитесь в группу и нажмите «Участвовать».");
    return;
  }
  if (initialParticipant.status !== "onboarding") {
    await ctx.reply("Онбординг уже завершён. Напишите /status.");
    return;
  }

  const state: {
    track: "cut" | "bulk" | null;
    startWeight: number | null;
    startWaist: number | null;
    height: number | null;
    startPhotoFrontId: string | null;
    startPhotoLeftId: string | null;
    startPhotoRightId: string | null;
    startPhotoBackId: string | null;
  } = {
    track: (initialParticipant.track as any) ?? null,
    startWeight: initialParticipant.startWeight ?? null,
    startWaist: initialParticipant.startWaist ?? null,
    height: initialParticipant.height ?? null,
    startPhotoFrontId: initialParticipant.startPhotoFrontId ?? null,
    startPhotoLeftId: initialParticipant.startPhotoLeftId ?? null,
    startPhotoRightId: initialParticipant.startPhotoRightId ?? null,
    startPhotoBackId: initialParticipant.startPhotoBackId ?? null
  };

  const hasAnyData =
    state.track ||
    state.startWeight != null ||
    state.startWaist != null ||
    state.height != null ||
    state.startPhotoFrontId ||
    state.startPhotoLeftId ||
    state.startPhotoRightId ||
    state.startPhotoBackId;

  let prefillText: string | undefined;
  if (hasAnyData) {
    const kb = new InlineKeyboard()
      .text("▶️ Продолжить", "onb_resume_continue")
      .text("🔄 Начать заново", "onb_resume_restart");
    await ctx.reply("Похоже, онбординг уже начат. Продолжить или начать заново?", {
      reply_markup: kb
    });

    const resume = await conversation
      .waitFor(["callback_query:data", "message:text"])
      .andFrom(ctx.from.id);

    if (resume.callbackQuery?.data === "onb_resume_restart") {
      await resume.answerCallbackQuery();
      await conversation.external(() => {
        deps.db
          .update(participants)
          .set({
            track: null,
            startWeight: null,
            startWaist: null,
            height: null,
            startPhotoFrontId: null,
            startPhotoLeftId: null,
            startPhotoRightId: null,
            startPhotoBackId: null
          })
          .where(eq(participants.id, participantId))
          .run();
        deps.db.delete(goals).where(eq(goals.participantId, participantId)).run();
        deps.db
          .delete(participantCommitments)
          .where(eq(participantCommitments.participantId, participantId))
          .run();
      });
      state.track = null;
      state.startWeight = null;
      state.startWaist = null;
      state.height = null;
      state.startPhotoFrontId = null;
      state.startPhotoLeftId = null;
      state.startPhotoRightId = null;
      state.startPhotoBackId = null;
    } else if (resume.callbackQuery?.data === "onb_resume_continue") {
      await resume.answerCallbackQuery();
    } else if (resume.message?.text) {
      prefillText = resume.message.text.trim();
    }
  }

  // 1) Track
  if (!state.track) {
    const track = await askTrack(conversation, ctx, prefillText);
    prefillText = undefined;
    state.track = track;
    await conversation.external(() => {
      deps.db.update(participants).set({ track }).where(eq(participants.id, participantId)).run();
    });
  }

  // 2) Weight
  if (state.startWeight == null) {
    await ctx.reply("Введите вес (кг), 30–150:");
    const weight = await readNumber(conversation, ctx.from.id, 30, 150, prefillText);
    prefillText = undefined;
    state.startWeight = weight;
    await conversation.external(() => {
      deps.db.update(participants).set({ startWeight: weight }).where(eq(participants.id, participantId)).run();
    });
  }

  // 3) Waist
  if (state.startWaist == null) {
    await ctx.reply("Введите талию (см), 40–150:");
    const waist = await readNumber(conversation, ctx.from.id, 40, 150);
    state.startWaist = waist;
    await conversation.external(() => {
      deps.db.update(participants).set({ startWaist: waist }).where(eq(participants.id, participantId)).run();
    });
  }

  // 4) Height
  if (state.height == null) {
    await ctx.reply("Введите рост (см), 140–220:");
    const height = await readNumber(conversation, ctx.from.id, 140, 220);
    state.height = height;
    await conversation.external(() => {
      deps.db.update(participants).set({ height }).where(eq(participants.id, participantId)).run();
    });
  }

  // 5-8) Photos
  await askStartPhoto(
    conversation,
    ctx,
    participantId,
    deps,
    state,
    "Фото 1/4 (анфас). Отправьте фото:",
    "front",
    "startPhotoFrontId"
  );
  await askStartPhoto(
    conversation,
    ctx,
    participantId,
    deps,
    state,
    "Фото 2/4 (профиль слева). Отправьте фото:",
    "left",
    "startPhotoLeftId"
  );
  await askStartPhoto(
    conversation,
    ctx,
    participantId,
    deps,
    state,
    "Фото 3/4 (профиль справа). Отправьте фото:",
    "right",
    "startPhotoRightId"
  );
  await askStartPhoto(
    conversation,
    ctx,
    participantId,
    deps,
    state,
    "Фото 4/4 (со спины). Отправьте фото:",
    "back",
    "startPhotoBackId"
  );

  // Goal + commitments будут добавлены отдельными задачами (следующие коммиты).
  await ctx.reply("Отлично! Дальше — постановка цели и обязательства (в следующем шаге).");
}

async function askTrack(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  prefillText?: string
): Promise<"cut" | "bulk"> {
  const kb = new InlineKeyboard()
    .text("Похудеть", "onb_track_cut")
    .text("Набрать", "onb_track_bulk");
  await ctx.reply("Выберите трек:", { reply_markup: kb });

  // If пользователь уже прислал текст на шаге «Продолжить» — попробуем использовать его.
  if (prefillText) {
    const normalized = prefillText.toLowerCase();
    if (normalized.includes("похуд")) return "cut";
    if (normalized.includes("наб")) return "bulk";
  }

  const trackCtx = await conversation
    .waitForCallbackQuery(/^onb_track_(cut|bulk)$/)
    .andFrom(ctx.from!.id);
  await trackCtx.answerCallbackQuery();
  return trackCtx.match?.[1] === "bulk" ? "bulk" : "cut";
}

async function readNumber(
  conversation: Conversation<BotContext, Context>,
  userId: number,
  min: number,
  max: number,
  prefillText?: string
): Promise<number> {
  if (prefillText) {
    const maybe = parseFloat(prefillText.replace(",", "."));
    if (Number.isFinite(maybe) && maybe >= min && maybe <= max) return maybe;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msgCtx = await conversation.waitFor("message:text").andFrom(userId);
    const raw = msgCtx.msg.text.trim().replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    await msgCtx.reply(`Введите число в диапазоне ${min}–${max}.`);
  }
}

async function askStartPhoto(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  participantId: number,
  deps: Deps,
  state: {
    startPhotoFrontId: string | null;
    startPhotoLeftId: string | null;
    startPhotoRightId: string | null;
    startPhotoBackId: string | null;
  },
  prompt: string,
  name: "front" | "left" | "right" | "back",
  column:
    | "startPhotoFrontId"
    | "startPhotoLeftId"
    | "startPhotoRightId"
    | "startPhotoBackId"
) {
  if (state[column] != null) return;

  await ctx.reply(prompt);
  const photoCtx = await conversation.waitFor("message:photo").andFrom(ctx.from!.id);
  const photo = photoCtx.msg.photo?.at(-1);
  if (!photo) {
    await photoCtx.reply("Не вижу фото. Попробуйте ещё раз.");
    return askStartPhoto(conversation, ctx, participantId, deps, state, prompt, name, column);
  }

  const fileId = photo.file_id;
  const dest = path.join(photosDirectory, String(participantId), "start", `${name}.jpg`);
  const file = await photoCtx.api.getFile(fileId);
  if (!file.file_path) {
    await photoCtx.reply("Не удалось получить файл из Telegram. Попробуйте ещё раз.");
    return askStartPhoto(conversation, ctx, participantId, deps, state, prompt, name, column);
  }
  const url = `https://api.telegram.org/file/bot${photoCtx.api.token}/${file.file_path}`;
  await conversation.external(async () => {
    await deps.files.downloadToFile(url, dest);
    deps.db
      .update(participants)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ [column]: fileId } as any)
      .where(eq(participants.id, participantId))
      .run();
  });
  state[column] = fileId;
}
