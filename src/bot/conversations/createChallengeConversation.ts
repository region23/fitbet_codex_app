import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { challenges } from "../../db/schema.js";
import type { AppEnv } from "../../config.js";
import type { BotContext } from "../context.js";

type Deps = {
  db: BetterSQLite3Database;
  env: AppEnv;
  now: () => number;
};

export async function createChallengeConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context,
  deps: Deps
) {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.reply("Команда /create доступна только в группе.");
    return;
  }
  if (!ctx.from) {
    await ctx.reply("Не удалось определить пользователя.");
    return;
  }

  const creatorId = ctx.from.id;

  const durationKeyboard = new InlineKeyboard()
    .text("6", "create_duration_6")
    .text("12", "create_duration_12");

  await ctx.reply(
    `Выберите длительность (${deps.env.CHALLENGE_DURATION_UNIT === "hours" ? "часов" : "месяцев"}):`,
    { reply_markup: durationKeyboard }
  );

  const durationCtx = await conversation
    .waitForCallbackQuery(/^create_duration_(6|12)$/)
    .andFrom(creatorId);
  await durationCtx.answerCallbackQuery();

  const duration = Number(durationCtx.match?.[1]);

  await durationCtx.reply("Введите ставку в рублях (например, 1000):");

  const stake = await readPositiveFloat(conversation, creatorId);

  const thresholdKeyboard = new InlineKeyboard()
    .text("70", "create_threshold_70")
    .text("80", "create_threshold_80")
    .text("90", "create_threshold_90");

  await durationCtx.reply("Выберите порог дисциплины (%):", {
    reply_markup: thresholdKeyboard
  });

  const thresholdCtx = await conversation
    .waitForCallbackQuery(/^create_threshold_(70|80|90)$/)
    .andFrom(creatorId);
  await thresholdCtx.answerCallbackQuery();
  const disciplineThreshold = Number(thresholdCtx.match?.[1]) / 100;

  const maxSkipsKeyboard = new InlineKeyboard()
    .text("1", "create_max_skips_1")
    .text("2", "create_max_skips_2")
    .text("3", "create_max_skips_3");

  await thresholdCtx.reply("Макс. пропусков:", { reply_markup: maxSkipsKeyboard });
  const skipsCtx = await conversation
    .waitForCallbackQuery(/^create_max_skips_(1|2|3)$/)
    .andFrom(creatorId);
  await skipsCtx.answerCallbackQuery();
  const maxSkips = Number(skipsCtx.match?.[1]);

  const now = deps.now();

  const created = deps.db
    .insert(challenges)
    .values({
      chatId: ctx.chat.id,
      chatTitle: "title" in ctx.chat ? (ctx.chat.title ?? "Чат") : "Чат",
      creatorId,
      durationMonths: duration,
      stakeAmount: stake,
      disciplineThreshold,
      maxSkips,
      status: "draft",
      createdAt: now
    })
    .returning({ id: challenges.id })
    .get();

  const joinKeyboard = new InlineKeyboard().text("🙋 Участвовать (0)", `join_${created.id}`);

  await skipsCtx.reply(formatChallengeCreatedMessage(duration, stake, disciplineThreshold, maxSkips), {
    parse_mode: "Markdown",
    reply_markup: joinKeyboard
  });
}

async function readPositiveFloat(
  conversation: Conversation<BotContext, Context>,
  creatorId: number
) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msgCtx = await conversation.waitFor("message:text").andFrom(creatorId);
    const raw = msgCtx.msg.text.trim().replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    await msgCtx.reply("Пожалуйста, введите число больше 0 (например, 1000).");
  }
}

function formatChallengeCreatedMessage(
  duration: number,
  stake: number,
  disciplineThreshold: number,
  maxSkips: number
) {
  const thresholdPct = Math.round(disciplineThreshold * 100);
  return `*Челлендж создан (черновик)*
Длительность: *${duration}*
Ставка: *${stake} ₽*
Порог дисциплины: *${thresholdPct}%*
Макс. пропусков: *${maxSkips}*`;
}
