import type { Conversation } from "@grammyjs/conversations";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { InlineKeyboard, type Context } from "grammy";
import path from "node:path";
import { photosDirectory } from "../../constants.js";
import {
  bankHolderElections,
  commitmentTemplates,
  goals,
  participantCommitments,
  participants,
  payments
} from "../../db/schema.js";
import type { AppEnv } from "../../config.js";
import type { BotContext } from "../context.js";
import type { FileStore } from "../../services/fileStore.js";
import type { OpenRouterClient } from "../../services/openRouter.js";

type Deps = {
  db: BetterSQLite3Database;
  env: AppEnv;
  now: () => number;
  files: FileStore;
  llm?: OpenRouterClient;
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
        deps.db.delete(payments).where(eq(payments.participantId, participantId)).run();
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

  // 9) Goal (+ LLM validation, если доступна)
  const goalWithValidation = await askGoalWithValidation(conversation, ctx, state, deps);
  const now = await conversation.now();
  await conversation.external(() => {
    deps.db.delete(goals).where(eq(goals.participantId, participantId)).run();
    deps.db
      .insert(goals)
      .values({
        participantId,
        targetWeight: goalWithValidation.targetWeight,
        targetWaist: goalWithValidation.targetWaist,
        isValidated: goalWithValidation.isValidated,
        validationResult: goalWithValidation.validationResult,
        validationFeedback: goalWithValidation.validationFeedback,
        validatedAt: goalWithValidation.isValidated ? now : null,
        createdAt: now,
        updatedAt: now
      })
      .run();
  });

  // 10) Commitments
  const selectedTemplateIds = await askCommitments(conversation, ctx, deps);
  await conversation.external(() => {
    deps.db
      .delete(participantCommitments)
      .where(eq(participantCommitments.participantId, participantId))
      .run();
    deps.db
      .insert(participantCommitments)
      .values(selectedTemplateIds.map((templateId) => ({ participantId, templateId, createdAt: now })))
      .run();
  });

  // 11) Finish
  await conversation.external(() => {
    deps.db
      .update(participants)
      .set({ status: "pending_payment", onboardingCompletedAt: now })
      .where(eq(participants.id, participantId))
      .run();
    deps.db
      .insert(payments)
      .values({ participantId, status: "pending" })
      .onConflictDoUpdate({
        target: payments.participantId,
        set: { status: "pending", markedPaidAt: null, confirmedAt: null, confirmedBy: null }
      })
      .run();
  });

  const election = await conversation.external(() =>
    deps.db
      .select()
      .from(bankHolderElections)
      .where(and(eq(bankHolderElections.challengeId, initialParticipant.challengeId), eq(bankHolderElections.status, "in_progress")))
      .get()
  );
  if (election) {
    const eligible = await conversation.external(() =>
      deps.db
        .select()
        .from(participants)
        .where(and(eq(participants.challengeId, initialParticipant.challengeId), eq(participants.status, "pending_payment")))
        .all()
    );
    if (eligible.length >= 2) {
      const kb = new InlineKeyboard();
      eligible.forEach((p) => {
        const label = p.username ? `@${p.username}` : p.firstName ?? String(p.userId);
        kb.text(label, `vote_${election.id}_${p.userId}`).row();
      });
      await ctx.reply("Голосование за Bank Holder уже идёт — проголосуйте:", { reply_markup: kb });
    }
  }

  const payKb = new InlineKeyboard().text("💳 Я оплатил", `paid_${participantId}`);
  await ctx.reply("Онбординг завершён! После оплаты нажмите кнопку:", { reply_markup: payKb });
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

async function askGoal(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  state: {
    track: "cut" | "bulk" | null;
    startWeight: number | null;
    startWaist: number | null;
    height: number | null;
  }
): Promise<{ targetWeight: number; targetWaist: number }> {
  const startWeight = state.startWeight!;
  const startWaist = state.startWaist!;
  const heightCm = state.height!;

  const heightM = heightCm / 100;
  const recommendedWeight = round1(22 * heightM * heightM);
  const recommendedWaist = round1(0.45 * heightCm);

  const targetWeight = await askGoalNumber(
    conversation,
    ctx,
    `Цель по весу. Рекомендация: *${recommendedWeight} кг*.\nНажмите «Принять» или введите своё значение:`,
    "onb_goal_weight",
    recommendedWeight,
    30,
    150,
    (w) => {
      if (state.track === "cut") return w < startWeight;
      return w > startWeight;
    }
  );

  const targetWaist = await askGoalNumber(
    conversation,
    ctx,
    `Цель по талии. Рекомендация: *${recommendedWaist} см*.\nНажмите «Принять» или введите своё значение:`,
    "onb_goal_waist",
    recommendedWaist,
    40,
    150,
    (waist) => {
      if (state.track === "cut") return waist < startWaist;
      // Для "Набрать" строгой проверки нет
      return true;
    }
  );

  return { targetWeight, targetWaist };
}

async function askGoalWithValidation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  state: {
    track: "cut" | "bulk" | null;
    startWeight: number | null;
    startWaist: number | null;
    height: number | null;
  },
  deps: Deps
): Promise<{
  targetWeight: number;
  targetWaist: number;
  isValidated: boolean;
  validationResult: "realistic" | "too_aggressive" | "too_easy" | null;
  validationFeedback: string | null;
}> {
  let revisions = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const goal = await askGoal(conversation, ctx, state);
    if (!deps.llm) {
      return {
        ...goal,
        isValidated: true,
        validationResult: "realistic",
        validationFeedback: null
      };
    }

    let validation: { result: "realistic" | "too_aggressive" | "too_easy"; feedback: string } | null = null;
    try {
      const res = await conversation.external(() =>
        deps.llm!.validateGoal({
          track: state.track ?? "cut",
          startWeight: state.startWeight!,
          startWaist: state.startWaist!,
          heightCm: state.height!,
          targetWeight: goal.targetWeight,
          targetWaist: goal.targetWaist
        })
      );
      validation = { result: res.result, feedback: res.feedback };
    } catch {
      // LLM недоступен — принимаем цель автоматически
      return {
        ...goal,
        isValidated: false,
        validationResult: null,
        validationFeedback: null
      };
    }

    if (validation.result === "realistic") {
      return {
        ...goal,
        isValidated: true,
        validationResult: "realistic",
        validationFeedback: validation.feedback || null
      };
    }

    revisions += 1;
    if (revisions >= 3) {
      await ctx.reply("Я вижу, что цель спорная, но принимаю её (лимит пересмотров исчерпан).");
      return {
        ...goal,
        isValidated: true,
        validationResult: validation.result,
        validationFeedback: validation.feedback || null
      };
    }

    const kb = new InlineKeyboard()
      .text("🔄 Пересмотреть", "onb_goal_revise")
      .text("✅ Оставить", "onb_goal_keep");
    await ctx.reply(
      `Проверка цели: *${validation.result}*\n${validation.feedback}\n\nПересмотреть цель?`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    const choice = await conversation
      .waitForCallbackQuery(["onb_goal_revise", "onb_goal_keep"])
      .andFrom(ctx.from!.id);
    await choice.answerCallbackQuery();
    if (choice.callbackQuery.data === "onb_goal_keep") {
      return {
        ...goal,
        isValidated: true,
        validationResult: validation.result,
        validationFeedback: validation.feedback || null
      };
    }
  }
}

async function askGoalNumber(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  prompt: string,
  prefix: "onb_goal_weight" | "onb_goal_waist",
  recommendedValue: number,
  min: number,
  max: number,
  isValid: (n: number) => boolean
): Promise<number> {
  const kb = new InlineKeyboard()
    .text(`✅ Принять ${recommendedValue}`, `${prefix}_accept`)
    .row()
    .text("✍️ Ввести своё", `${prefix}_custom`);

  await ctx.reply(prompt, { parse_mode: "Markdown", reply_markup: kb });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = await conversation
      .waitFor(["callback_query:data", "message:text"])
      .andFrom(ctx.from!.id);

    if (next.callbackQuery?.data === `${prefix}_accept`) {
      await next.answerCallbackQuery();
      if (!isValid(recommendedValue)) {
        await ctx.reply("Эта цель не подходит для вашего трека. Введите значение вручную.");
        continue;
      }
      return recommendedValue;
    }

    if (next.callbackQuery?.data === `${prefix}_custom`) {
      await next.answerCallbackQuery();
      await ctx.reply("Введите число:");
      const val = await readNumber(conversation, ctx.from!.id, min, max);
      if (!isValid(val)) {
        await ctx.reply("Эта цель не подходит для вашего трека. Попробуйте другое значение.");
        continue;
      }
      return val;
    }

    if (next.message?.text) {
      const val = parseFloat(next.message.text.trim().replace(",", "."));
      if (!Number.isFinite(val)) {
        await ctx.reply("Введите число.");
        continue;
      }
      if (val < min || val > max) {
        await ctx.reply(`Введите число в диапазоне ${min}–${max}.`);
        continue;
      }
      if (!isValid(val)) {
        await ctx.reply("Эта цель не подходит для вашего трека. Попробуйте другое значение.");
        continue;
      }
      return val;
    }
  }
}

async function askCommitments(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  deps: Deps
): Promise<number[]> {
  const templates = await conversation.external(() =>
    deps.db
      .select({
        id: commitmentTemplates.id,
        name: commitmentTemplates.name,
        description: commitmentTemplates.description
      })
      .from(commitmentTemplates)
      .where(eq(commitmentTemplates.isActive, true))
      .all()
  );

  const lines = templates.map((t, i) => `${i + 1}) ${t.name} — ${t.description}`);
  await ctx.reply(
    `Выберите 2–3 обязательства (номера через пробел или запятую):\n\n${lines.join("\n")}`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msgCtx = await conversation.waitFor("message:text").andFrom(ctx.from!.id);
    const raw = msgCtx.msg.text.trim();
    const nums = raw
      .split(/[\s,]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n));
    const unique = Array.from(new Set(nums));
    const okCount = unique.length === 2 || unique.length === 3;
    const okRange = unique.every((n) => n >= 1 && n <= templates.length);
    if (!okCount || !okRange) {
      await msgCtx.reply("Введите 2 или 3 номера из списка (например: 1 3 5).");
      continue;
    }
    return unique.map((n) => templates[n - 1]!.id);
  }
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
