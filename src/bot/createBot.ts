import { conversations, createConversation } from "@grammyjs/conversations";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Bot, InlineKeyboard, session } from "grammy";
import type { AppEnv } from "../config.js";
import { helpText } from "./helpText.js";
import type { BotContext, SessionData } from "./context.js";
import { SqliteSessionStorage } from "./sessionStorage.js";
import { createChallengeConversation } from "./conversations/createChallengeConversation.js";
import { challenges, participants } from "../db/schema.js";
import { and, count, eq, inArray } from "drizzle-orm";
import type { UserFromGetMe } from "grammy/types";
import type { ApiClientOptions } from "grammy";

type CreateBotDeps = {
  token: string;
  env: AppEnv;
  db: BetterSQLite3Database;
  sqlite: Database.Database;
  now?: () => number;
  botInfo?: UserFromGetMe;
  client?: ApiClientOptions;
};

export function createFitbetBot(deps: CreateBotDeps) {
  const bot = new Bot<BotContext>(deps.token, {
    botInfo: deps.botInfo,
    client: deps.client
  });
  const now = deps.now ?? (() => Date.now());

  if (deps.env.NODE_ENV !== "test") {
    bot.use(async (ctx, next) => {
      const kind =
        Object.keys(ctx.update).filter((k) => k !== "update_id")[0] ?? "update";
      const chatId = ctx.chat?.id ?? "-";
      console.log(`[update] ${kind} chat=${chatId} from=${ctx.from?.id ?? "-"}`);
      await next();
    });
  }

  bot.use(
    session({
      initial: (): SessionData => ({}),
      getSessionKey: (ctx) => {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!chat || !from) return undefined;
        if (chat.type === "private") return `u:${from.id}`;
        if (chat.type === "group" || chat.type === "supergroup") return `g:${chat.id}`;
        return undefined;
      },
      storage: new SqliteSessionStorage<SessionData>(deps.sqlite)
    })
  );

  bot.use(conversations());
  bot.use(
    createConversation(
      (conversation, ctx) =>
        createChallengeConversation(conversation, ctx, { db: deps.db, env: deps.env, now }),
      "createChallenge"
    )
  );

  bot.command("help", (ctx) => ctx.reply(helpText, { parse_mode: "Markdown" }));

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply(
        "Привет! Добавьте меня в групповой чат и создайте челлендж через /create.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    await ctx.reply("Бот активирован. Используйте /create чтобы создать челлендж.");
  });

  bot.command("status", async (ctx) => {
    if (!ctx.chat) return;
    if (ctx.chat.type === "private") {
      await ctx.reply("Статус: пока нет активных участий. Напишите /start.");
      return;
    }
    const current = deps.db
      .select()
      .from(challenges)
      .where(and(eq(challenges.chatId, ctx.chat.id), inArray(challenges.status, ["draft", "pending_payments", "active"])))
      .get();
    if (!current) {
      await ctx.reply("В этом чате пока нет активного челленджа. Создайте через /create.");
      return;
    }
    const total = deps.db
      .select({ c: count() })
      .from(participants)
      .where(eq(participants.challengeId, current.id))
      .get()?.c ?? 0;
    await ctx.reply(
      `Текущий челлендж: статус *${current.status}*, участников: *${total}*`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("create", async (ctx) => {
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("Команда /create доступна только в группе.");
      return;
    }
    await ctx.conversation.enter("createChallenge");
  });

  bot.callbackQuery(/^join_(\d+)$/, async (ctx) => {
    const challengeId = Number(ctx.match?.[1]);
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;

    const challenge = deps.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .get();
    if (!challenge || challenge.chatId !== chat.id) {
      await ctx.answerCallbackQuery({ text: "Челлендж не найден.", show_alert: true });
      return;
    }
    if (!["draft", "pending_payments"].includes(challenge.status)) {
      await ctx.answerCallbackQuery({ text: "Набор участников закрыт.", show_alert: true });
      return;
    }

    const existing = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, challengeId), eq(participants.userId, from.id)))
      .get();

    if (existing && existing.status !== "dropped") {
      await ctx.answerCallbackQuery({ text: "Вы уже участвуете.", show_alert: true });
      return;
    }

    if (existing && existing.status === "dropped") {
      deps.db
        .update(participants)
        .set({
          status: "onboarding",
          track: null,
          startWeight: null,
          startWaist: null,
          height: null,
          startPhotoFrontId: null,
          startPhotoLeftId: null,
          startPhotoRightId: null,
          startPhotoBackId: null,
          onboardingCompletedAt: null
        })
        .where(eq(participants.id, existing.id))
        .run();
    } else {
      deps.db
        .insert(participants)
        .values({
          challengeId,
          userId: from.id,
          username: from.username ?? null,
          firstName: from.first_name ?? null,
          status: "onboarding",
          joinedAt: now()
        })
        .run();
    }

    const total = deps.db
      .select({ c: count() })
      .from(participants)
      .where(eq(participants.challengeId, challengeId))
      .get()?.c ?? 0;

    const keyboard = new InlineKeyboard().text(`🙋 Участвовать (${total})`, `join_${challengeId}`);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch {
      // ignore
    }

    await ctx.answerCallbackQuery({ text: "Вы записаны! Напишите боту /start в личку." });
  });

  bot.command("bankholder", async (ctx) => {
    await ctx.reply("Команда /bankholder будет доступна после реализации голосования.");
  });

  bot.command("clear_db", async (ctx) => {
    await ctx.reply("Команда /clear_db будет реализована позже.");
  });

  bot.catch((err) => {
    console.error("[bot error]", err.error);
  });

  return bot;
}
