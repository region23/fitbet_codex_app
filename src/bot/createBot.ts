import { conversations, createConversation } from "@grammyjs/conversations";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Bot, InlineKeyboard, session } from "grammy";
import type { AppEnv } from "../config.js";
import { helpText } from "./helpText.js";
import type { BotContext, SessionData } from "./context.js";
import { SqliteSessionStorage } from "./sessionStorage.js";
import { createChallengeConversation } from "./conversations/createChallengeConversation.js";
import {
  bankHolderElections,
  bankHolderVotes,
  challenges,
  participants
} from "../db/schema.js";
import { and, count, eq, inArray } from "drizzle-orm";
import type { UserFromGetMe } from "grammy/types";
import type { ApiClientOptions } from "grammy";
import { onboardingConversation } from "./conversations/onboardingConversation.js";
import { createTelegramFileStore, type FileStore } from "../services/fileStore.js";
import { payments } from "../db/schema.js";

type CreateBotDeps = {
  token: string;
  env: AppEnv;
  db: BetterSQLite3Database;
  sqlite: Database.Database;
  now?: () => number;
  botInfo?: UserFromGetMe;
  client?: ApiClientOptions;
  files?: FileStore;
};

export function createFitbetBot(deps: CreateBotDeps) {
  const bot = new Bot<BotContext>(deps.token, {
    botInfo: deps.botInfo,
    client: deps.client
  });
  const now = deps.now ?? (() => Date.now());
  const files = deps.files ?? createTelegramFileStore();

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
  bot.use(
    createConversation(
      (conversation, ctx, participantId) =>
        onboardingConversation(conversation, ctx, Number(participantId), {
          db: deps.db,
          env: deps.env,
          now,
          files
        }),
      "onboarding"
    )
  );

  bot.command("help", (ctx) => ctx.reply(helpText, { parse_mode: "Markdown" }));

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type === "private") {
      const participant = deps.db
        .select()
        .from(participants)
        .where(and(eq(participants.userId, ctx.from!.id), eq(participants.status, "onboarding")))
        .get();
      if (participant) {
        await ctx.conversation.enter("onboarding", participant.id);
        return;
      }

      await ctx.reply("Привет! Добавьте меня в групповой чат и создайте челлендж через /create.");
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

    try {
      await ctx.api.sendMessage(
        from.id,
        `Вы присоединились к челленджу в группе «${challenge.chatTitle}».\n\nНапишите /start, чтобы начать онбординг.`
      );
    } catch {
      // Пользователь мог не начать диалог с ботом
    }
  });

  bot.callbackQuery(/^paid_(\d+)$/, async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Оплата подтверждается в личке с ботом.", show_alert: true });
      return;
    }
    const participantId = Number(ctx.match?.[1]);
    const from = ctx.from;
    if (!from) return;

    const participant = deps.db.select().from(participants).where(eq(participants.id, participantId)).get();
    if (!participant || participant.userId !== from.id) {
      await ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
      return;
    }
    if (participant.status !== "pending_payment") {
      await ctx.answerCallbackQuery({ text: "Оплата уже отмечена или подтверждена.", show_alert: true });
      return;
    }

    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, participant.challengeId)).get();
    if (!challenge) {
      await ctx.answerCallbackQuery({ text: "Челлендж не найден.", show_alert: true });
      return;
    }

    const ts = now();
    const isBankHolder = challenge.bankHolderId != null && challenge.bankHolderId === participant.userId;

    if (isBankHolder) {
      deps.db
        .insert(payments)
        .values({
          participantId,
          status: "confirmed",
          markedPaidAt: ts,
          confirmedAt: ts,
          confirmedBy: participant.userId
        })
        .onConflictDoUpdate({
          target: payments.participantId,
          set: { status: "confirmed", markedPaidAt: ts, confirmedAt: ts, confirmedBy: participant.userId }
        })
        .run();
      deps.db.update(participants).set({ status: "active" }).where(eq(participants.id, participantId)).run();
      await ctx.answerCallbackQuery({ text: "Оплата подтверждена (вы Bank Holder)." });
      await ctx.reply("Оплата подтверждена ✅");
      await maybeActivateChallenge(deps, ctx.api, challenge.id, ts);
      return;
    }

    deps.db
      .insert(payments)
      .values({ participantId, status: "marked_paid", markedPaidAt: ts })
      .onConflictDoUpdate({
        target: payments.participantId,
        set: { status: "marked_paid", markedPaidAt: ts }
      })
      .run();
    deps.db.update(participants).set({ status: "payment_marked" }).where(eq(participants.id, participantId)).run();

    await ctx.answerCallbackQuery({ text: "Отлично! Ждём подтверждение от Bank Holder." });

    if (challenge.bankHolderId) {
      const who = participant.username ? `@${participant.username}` : participant.firstName ?? `id ${participant.userId}`;
      const kb = new InlineKeyboard().text("✅ Подтвердить оплату", `confirm_${participantId}`);
      try {
        await ctx.api.sendMessage(
          challenge.bankHolderId,
          `Участник ${who} отметил оплату. Подтвердите, пожалуйста:`,
          { reply_markup: kb }
        );
      } catch {
        // ignore
      }
    }
  });

  bot.callbackQuery(/^confirm_(\d+)$/, async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Подтверждение оплаты доступно только в личке.", show_alert: true });
      return;
    }
    const participantId = Number(ctx.match?.[1]);
    const from = ctx.from;
    if (!from) return;

    const participant = deps.db.select().from(participants).where(eq(participants.id, participantId)).get();
    if (!participant) {
      await ctx.answerCallbackQuery({ text: "Участник не найден.", show_alert: true });
      return;
    }
    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, participant.challengeId)).get();
    if (!challenge) {
      await ctx.answerCallbackQuery({ text: "Челлендж не найден.", show_alert: true });
      return;
    }
    if (!challenge.bankHolderId || challenge.bankHolderId !== from.id) {
      await ctx.answerCallbackQuery({ text: "Только Bank Holder может подтверждать оплаты.", show_alert: true });
      return;
    }
    if (participant.status !== "payment_marked") {
      await ctx.answerCallbackQuery({ text: "Оплата ещё не отмечена участником.", show_alert: true });
      return;
    }

    const ts = now();
    deps.db
      .insert(payments)
      .values({
        participantId,
        status: "confirmed",
        confirmedAt: ts,
        confirmedBy: from.id
      })
      .onConflictDoUpdate({
        target: payments.participantId,
        set: { status: "confirmed", confirmedAt: ts, confirmedBy: from.id }
      })
      .run();
    deps.db.update(participants).set({ status: "active" }).where(eq(participants.id, participantId)).run();

    await ctx.answerCallbackQuery({ text: "Оплата подтверждена." });
    await ctx.reply("Готово ✅");

    const who = participant.username ? `@${participant.username}` : participant.firstName ?? `id ${participant.userId}`;
    try {
      await ctx.api.sendMessage(participant.userId, "Оплата подтверждена ✅");
    } catch {
      // ignore
    }
    try {
      await ctx.api.sendMessage(challenge.chatId, `✅ Оплата подтверждена: ${who}`);
    } catch {
      // ignore
    }

    await maybeActivateChallenge(deps, ctx.api, challenge.id, ts);
  });

  bot.command("bankholder", async (ctx) => {
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("Команда /bankholder доступна только в группе.");
      return;
    }
    if (!ctx.from) return;

    const challenge = deps.db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.chatId, ctx.chat.id),
          inArray(challenges.status, ["draft", "pending_payments", "active"])
        )
      )
      .get();
    if (!challenge) {
      await ctx.reply("В этом чате нет активного челленджа. Создайте через /create.");
      return;
    }
    if (challenge.status === "completed" || challenge.status === "cancelled") {
      await ctx.reply("Челлендж уже завершён.");
      return;
    }
    if (challenge.creatorId !== ctx.from.id) {
      await ctx.reply("Только создатель челленджа может запускать голосование за Bank Holder.");
      return;
    }
    if (challenge.bankHolderId) {
      await ctx.reply("Bank Holder уже выбран.");
      return;
    }

    const eligible = deps.db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.challengeId, challenge.id),
          inArray(participants.status, ["pending_payment", "payment_marked", "active"])
        )
      )
      .all();
    if (eligible.length < 2) {
      await ctx.reply("Нужно минимум 2 участника, завершивших онбординг.");
      return;
    }

    const existingElection = deps.db
      .select()
      .from(bankHolderElections)
      .where(and(eq(bankHolderElections.challengeId, challenge.id), eq(bankHolderElections.status, "in_progress")))
      .get();
    if (existingElection) {
      await ctx.reply("Голосование уже идёт.");
      return;
    }

    const ts = now();
    const election = deps.db
      .insert(bankHolderElections)
      .values({
        challengeId: challenge.id,
        initiatedBy: ctx.from.id,
        status: "in_progress",
        createdAt: ts
      })
      .returning({ id: bankHolderElections.id })
      .get();

    await ctx.reply("🗳️ Старт голосования за Bank Holder! Длительность: 24 часа.");

    const buttons = new InlineKeyboard();
    eligible.forEach((p) => {
      const label = p.username ? `@${p.username}` : p.firstName ?? String(p.userId);
      buttons.text(label, `vote_${election.id}_${p.userId}`).row();
    });

    for (const p of eligible) {
      try {
        await ctx.api.sendMessage(
          p.userId,
          "Выберите Bank Holder (можно проголосовать один раз):",
          { reply_markup: buttons }
        );
      } catch {
        // ignore
      }
    }
  });

  bot.callbackQuery(/^vote_(\d+)_(\d+)$/, async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Голосование доступно в личке с ботом.", show_alert: true });
      return;
    }
    if (!ctx.from) return;

    const electionId = Number(ctx.match?.[1]);
    const candidateUserId = Number(ctx.match?.[2]);

    const election = deps.db.select().from(bankHolderElections).where(eq(bankHolderElections.id, electionId)).get();
    if (!election || election.status !== "in_progress") {
      await ctx.answerCallbackQuery({ text: "Голосование уже завершено.", show_alert: true });
      return;
    }

    const voter = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, election.challengeId), eq(participants.userId, ctx.from.id)))
      .get();
    if (!voter || voter.status === "onboarding") {
      await ctx.answerCallbackQuery({ text: "Вы не можете голосовать.", show_alert: true });
      return;
    }

    const candidate = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, election.challengeId), eq(participants.userId, candidateUserId)))
      .get();
    if (!candidate || candidate.status === "onboarding") {
      await ctx.answerCallbackQuery({ text: "Кандидат недоступен.", show_alert: true });
      return;
    }

    const ts = now();
    try {
      deps.db
        .insert(bankHolderVotes)
        .values({
          electionId,
          voterId: ctx.from.id,
          votedForId: candidateUserId,
          votedAt: ts
        })
        .run();
    } catch {
      await ctx.answerCallbackQuery({ text: "Вы уже голосовали.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Голос учтён!" });
    try {
      await ctx.editMessageText("Ваш голос учтён ✅");
    } catch {
      // ignore
    }

    await maybeFinalizeElection(deps, ctx.api, electionId, ts);
  });

  bot.command("clear_db", async (ctx) => {
    await ctx.reply("Команда /clear_db будет реализована позже.");
  });

  bot.catch((err) => {
    console.error("[bot error]", err.error);
  });

  return bot;
}

async function maybeFinalizeElection(
  deps: CreateBotDeps,
  api: BotContext["api"],
  electionId: number,
  ts: number
) {
  const election = deps.db.select().from(bankHolderElections).where(eq(bankHolderElections.id, electionId)).get();
  if (!election || election.status !== "in_progress") return;

  const eligible = deps.db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.challengeId, election.challengeId),
        inArray(participants.status, ["pending_payment", "payment_marked", "active"])
      )
    )
    .all();
  if (eligible.length === 0) return;

  const votes = deps.db
    .select()
    .from(bankHolderVotes)
    .where(eq(bankHolderVotes.electionId, electionId))
    .all();

  const voterIds = new Set(votes.map((v) => v.voterId));
  if (voterIds.size < eligible.length) return; // ждём остальных

  // Подсчёт голосов
  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v.votedForId, (counts.get(v.votedForId) ?? 0) + 1);

  const eligibleUserIds = eligible.map((p) => p.userId).sort((a, b) => a - b);
  const creatorId = deps.db.select({ creatorId: challenges.creatorId }).from(challenges).where(eq(challenges.id, election.challengeId)).get()?.creatorId;

  let winnerUserId: number;
  if (counts.size === 0) {
    winnerUserId = creatorId && eligibleUserIds.includes(creatorId) ? creatorId : eligibleUserIds[0]!;
  } else {
    let bestVotes = -1;
    let bestUserId = eligibleUserIds[0]!;
    for (const uid of eligibleUserIds) {
      const c = counts.get(uid) ?? 0;
      if (c > bestVotes) {
        bestVotes = c;
        bestUserId = uid;
      }
    }
    // при равенстве — минимальный user_id, поэтому порядок eligibleUserIds
    winnerUserId = bestUserId;
  }

  const winner = eligible.find((p) => p.userId === winnerUserId);
  deps.db
    .update(challenges)
    .set({
      bankHolderId: winnerUserId,
      bankHolderUsername: winner?.username ?? null,
      status: "pending_payments"
    })
    .where(eq(challenges.id, election.challengeId))
    .run();
  deps.db
    .update(bankHolderElections)
    .set({ status: "completed", completedAt: ts })
    .where(eq(bankHolderElections.id, electionId))
    .run();

  const challenge = deps.db.select().from(challenges).where(eq(challenges.id, election.challengeId)).get();
  if (!challenge) return;

  const label = winner?.username ? `@${winner.username}` : winner?.firstName ?? String(winnerUserId);
  await api.sendMessage(challenge.chatId, `🏦 Bank Holder выбран: ${label}`);
  try {
    await api.sendMessage(winnerUserId, "Вы выбраны Bank Holder. Вам будут приходить запросы на подтверждение оплат.");
  } catch {
    // ignore
  }

  const payKb = (pid: number) => new InlineKeyboard().text("💳 Я оплатил", `paid_${pid}`);
  for (const p of eligible) {
    if (p.status !== "pending_payment") continue;
    try {
      await api.sendMessage(p.userId, "Пора оплатить участие. Нажмите кнопку после оплаты:", {
        reply_markup: payKb(p.id)
      });
    } catch {
      // ignore
    }
  }
}

async function maybeActivateChallenge(
  deps: CreateBotDeps,
  api: BotContext["api"],
  challengeId: number,
  ts: number
) {
  const challenge = deps.db.select().from(challenges).where(eq(challenges.id, challengeId)).get();
  if (!challenge) return;
  if (challenge.status === "active" || challenge.status === "completed") return;

  const blocking = deps.db
    .select({ c: count() })
    .from(participants)
    .where(
      and(
        eq(participants.challengeId, challengeId),
        inArray(participants.status, ["onboarding", "pending_payment", "payment_marked"])
      )
    )
    .get()?.c ?? 0;

  if (blocking > 0) return;

  const startedAt = ts;
  const endsAt = deps.env.CHALLENGE_DURATION_UNIT === "hours"
    ? startedAt + challenge.durationMonths * 60 * 60 * 1000
    : addMonthsMs(startedAt, challenge.durationMonths);

  deps.db
    .update(challenges)
    .set({ status: "active", startedAt, endsAt })
    .where(eq(challenges.id, challengeId))
    .run();

  await api.sendMessage(challenge.chatId, "✅ Все оплаты подтверждены. Челлендж активирован!");
}

function addMonthsMs(startMs: number, months: number) {
  const d = new Date(startMs);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}
