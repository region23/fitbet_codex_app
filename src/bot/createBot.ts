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
  goals,
  participantCommitments,
  participants
} from "../db/schema.js";
import { and, count, eq, inArray } from "drizzle-orm";
import type { UserFromGetMe } from "grammy/types";
import type { ApiClientOptions } from "grammy";
import { onboardingConversation } from "./conversations/onboardingConversation.js";
import { createTelegramFileStore, type FileStore } from "../services/fileStore.js";
import { payments } from "../db/schema.js";
import { checkinWindowHours } from "../constants.js";
import { generateCheckinWindowsForChallenge } from "../services/checkinWindows.js";
import { checkinConversation } from "./conversations/checkinConversation.js";
import { checkinWindows } from "../db/schema.js";
import { seedCommitmentTemplates } from "../db/seeds.js";
import { finalizeBankHolderElection } from "../services/bankholderElection.js";
import { createOpenRouterClient, type OpenRouterClient } from "../services/openRouter.js";
import { captureException } from "../monitoring/sentry.js";
import { formatChallengeDuration } from "./duration.js";

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
  const llm: OpenRouterClient | undefined = deps.env.OPENROUTER_API_KEY
    ? createOpenRouterClient({ apiKey: deps.env.OPENROUTER_API_KEY })
    : undefined;

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
          files,
          llm
        }),
      "onboarding"
    )
  );
  bot.use(
    createConversation(
      (conversation, ctx, participantId, windowId) =>
        checkinConversation(conversation, ctx, Number(participantId), Number(windowId), {
          db: deps.db,
          now,
          files,
          llm
        }),
      "checkin"
    )
  );

  bot.command("help", (ctx) => ctx.reply(helpText, { parse_mode: "Markdown" }));

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type === "private") {
      const pending = deps.db
        .select()
        .from(participants)
        .where(and(eq(participants.userId, ctx.from!.id), eq(participants.status, "active")))
        .get();
      if (pending?.pendingCheckinWindowId) {
        const win = deps.db
          .select()
          .from(checkinWindows)
          .where(eq(checkinWindows.id, pending.pendingCheckinWindowId))
          .get();
        if (win && win.status === "open") {
          await ctx.conversation.enter("checkin", pending.id, win.id);
          return;
        }
      }

      const participant = deps.db
        .select()
        .from(participants)
        .where(and(eq(participants.userId, ctx.from!.id), eq(participants.status, "onboarding")))
        .get();
      if (participant) {
        await ctx.conversation.enter("onboarding", participant.id);
        return;
      }

      const active = deps.db
        .select()
        .from(participants)
        .where(
          and(
            eq(participants.userId, ctx.from!.id),
            inArray(participants.status, ["pending_payment", "payment_marked", "active"])
          )
        )
        .get();
      if (active) {
        await ctx.reply("У вас уже есть активное участие. Напишите /status для подробностей.");
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
      if (!ctx.from) return;
      const rows = deps.db
        .select({
          participantId: participants.id,
          participantStatus: participants.status,
          track: participants.track,
          startWeight: participants.startWeight,
          startWaist: participants.startWaist,
          height: participants.height,
          completedCheckins: participants.completedCheckins,
          totalCheckins: participants.totalCheckins,
          skippedCheckins: participants.skippedCheckins,
          chatTitle: challenges.chatTitle,
          chatId: challenges.chatId,
          challengeStatus: challenges.status,
          startedAt: challenges.startedAt,
          endsAt: challenges.endsAt
        })
        .from(participants)
        .leftJoin(challenges, eq(participants.challengeId, challenges.id))
        .where(eq(participants.userId, ctx.from.id))
        .all();

      if (rows.length === 0) {
        await ctx.reply("У вас пока нет участий. Добавьте бота в группу и нажмите «Участвовать».");
        return;
      }

      const parts: string[] = ["*Ваши участия:*"];
      for (const r of rows) {
        const title = r.chatTitle ?? `чат ${r.chatId ?? "?"}`;
        const dates =
          r.startedAt && r.endsAt
            ? `\nПериод: ${new Date(r.startedAt).toLocaleDateString("ru-RU")} → ${new Date(r.endsAt).toLocaleDateString("ru-RU")}`
            : "";
        const goal = deps.db
          .select()
          .from(goals)
          .where(eq(goals.participantId, r.participantId))
          .get();
        const goalLine = goal ? `\nЦель: ${goal.targetWeight} кг / ${goal.targetWaist} см` : "";
        const metrics =
          r.startWeight != null && r.startWaist != null && r.height != null
            ? `\nСтарт: ${r.startWeight} кг / ${r.startWaist} см, рост ${r.height} см`
            : "";
        const checkinsLine = `\nЧек-ины: ${r.completedCheckins}/${r.totalCheckins}, пропуски ${r.skippedCheckins}`;
        const action =
          r.participantStatus === "onboarding"
            ? "\nДействие: напишите /start чтобы продолжить онбординг."
            : r.participantStatus === "pending_payment"
              ? "\nДействие: дождитесь выбора Bank Holder и оплатите участие."
              : r.participantStatus === "active"
                ? "\nДействие: ждите окна чек-ина или напишите /start если приглашены."
                : "";

        parts.push(
          `\n*${title}*\nСтатус участия: *${r.participantStatus}*\nСтатус челленджа: *${r.challengeStatus}*${dates}${metrics}${goalLine}${checkinsLine}${action}`
        );
      }
      await ctx.reply(parts.join("\n"), { parse_mode: "Markdown" });
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

    const list = deps.db
      .select()
      .from(participants)
      .where(eq(participants.challengeId, current.id))
      .all();
    const lines = list
      .sort((a, b) => a.userId - b.userId)
      .map((p) => {
        const name = p.username ? `@${p.username}` : p.firstName ?? String(p.userId);
        return `${name} — ${p.status} (чек-ины ${p.completedCheckins}/${p.totalCheckins}, пропуски ${p.skippedCheckins})`;
    });

    const thresholdPct = Math.round(current.disciplineThreshold * 100);
    const header = `*Челлендж в этом чате*\nСтатус: *${current.status}*\nДлительность: *${formatChallengeDuration(current.durationMonths, deps.env.CHALLENGE_DURATION_UNIT)}*\nСтавка: *${current.stakeAmount} ₽*\nПорог дисциплины: *${thresholdPct}%*\nМакс. пропусков: *${current.maxSkips}*`;
    const bank = current.bankHolderUsername
      ? `\nBank Holder: @${current.bankHolderUsername}`
      : current.bankHolderId
        ? `\nBank Holder: ${current.bankHolderId}`
        : "";

    await ctx.reply(`${header}${bank}\n\n*Участники:*\n${lines.join("\n") || "—"}`, { parse_mode: "Markdown" });
  });

  bot.command("create", async (ctx) => {
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("Команда /create доступна только в группе.");
      return;
    }
    const current = deps.db
      .select()
      .from(challenges)
      .where(and(eq(challenges.chatId, ctx.chat.id), inArray(challenges.status, ["draft", "pending_payments", "active"])))
      .get();
    if (current) {
      const thresholdPct = Math.round(current.disciplineThreshold * 100);
      const total = deps.db
        .select({ c: count() })
        .from(participants)
        .where(eq(participants.challengeId, current.id))
        .get()?.c ?? 0;
      const joinable = current.status === "draft" || current.status === "pending_payments";
      const kb = joinable
        ? new InlineKeyboard().text(`🙋 Участвовать (${total})`, `join_${current.id}`)
        : undefined;
      await ctx.reply(
        `Текущий челлендж:\nДлительность: ${formatChallengeDuration(current.durationMonths, deps.env.CHALLENGE_DURATION_UNIT)}\nСтавка: ${current.stakeAmount} ₽\nПорог дисциплины: ${thresholdPct}%\nМакс. пропусков: ${current.maxSkips}\nСтатус: ${current.status}`,
        kb ? { reply_markup: kb } : undefined
      );
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

    const blocking = deps.db
      .select({
        challengeId: participants.challengeId,
        participantStatus: participants.status,
        chatTitle: challenges.chatTitle
      })
      .from(participants)
      .innerJoin(challenges, eq(participants.challengeId, challenges.id))
      .where(
        and(
          eq(participants.userId, from.id),
          inArray(participants.status, ["onboarding", "pending_payment", "payment_marked", "active"]),
          inArray(challenges.status, ["draft", "pending_payments", "active"])
        )
      )
      .get();
    if (blocking && blocking.challengeId !== challengeId) {
      await ctx.answerCallbackQuery({
        text: `Вы уже участвуете в челлендже в группе «${blocking.chatTitle}» (статус: ${blocking.participantStatus}).`,
        show_alert: true
      });
      return;
    }

    const existing = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, challengeId), eq(participants.userId, from.id)))
      .get();

    if (existing && existing.status === "onboarding") {
      await ctx.answerCallbackQuery({ text: "Онбординг уже начат. Напишите /start в личку.", show_alert: true });
      try {
        await ctx.api.sendMessage(from.id, "Напишите /start, чтобы продолжить онбординг.");
      } catch {
        // ignore
      }
      return;
    }
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
      deps.db.delete(goals).where(eq(goals.participantId, existing.id)).run();
      deps.db
        .delete(participantCommitments)
        .where(eq(participantCommitments.participantId, existing.id))
        .run();
      deps.db.delete(payments).where(eq(payments.participantId, existing.id)).run();
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

  bot.callbackQuery(/^checkin_(\d+)$/, async (ctx) => {
    const windowId = Number(ctx.match?.[1]);
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;

    const window = deps.db.select().from(checkinWindows).where(eq(checkinWindows.id, windowId)).get();
    if (!window || window.status !== "open") {
      await ctx.answerCallbackQuery({ text: "Окно чек-ина закрыто.", show_alert: true });
      return;
    }
    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, window.challengeId)).get();
    if (!challenge || challenge.chatId !== chat.id) {
      await ctx.answerCallbackQuery({ text: "Неверный чат.", show_alert: true });
      return;
    }
    const participant = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, window.challengeId), eq(participants.userId, from.id)))
      .get();
    if (!participant || participant.status !== "active") {
      await ctx.answerCallbackQuery({ text: "Чек-ин доступен только активным участникам.", show_alert: true });
      return;
    }

    const ts = now();
    deps.db
      .update(participants)
      .set({ pendingCheckinWindowId: windowId, pendingCheckinRequestedAt: ts })
      .where(eq(participants.id, participant.id))
      .run();

    await ctx.answerCallbackQuery({ text: "Отлично! Перейдите в личку и напишите /start." });
    try {
      await ctx.api.sendMessage(from.id, "Чтобы сдать чек-ин, напишите /start.");
    } catch {
      // ignore
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

    await finalizeBankHolderElection({
      db: deps.db,
      api: ctx.api,
      electionId,
      now: ts,
      mode: "all_votes"
    });
  });

  bot.command("clear_db", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Команда /clear_db доступна только в личке.");
      return;
    }
    if (!ctx.from) return;
    if (!deps.env.ADMIN_TELEGRAM_ID || deps.env.ADMIN_TELEGRAM_ID !== ctx.from.id) {
      await ctx.reply("Нет доступа.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("Да", "clear_db_yes")
      .text("Нет", "clear_db_no");
    await ctx.reply("Точно очистить базу данных? Это удалит все челленджи и данные.", {
      reply_markup: kb
    });
  });

  bot.callbackQuery(["clear_db_yes", "clear_db_no"], async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Команда доступна только в личке.", show_alert: true });
      return;
    }
    if (!ctx.from) return;
    if (!deps.env.ADMIN_TELEGRAM_ID || deps.env.ADMIN_TELEGRAM_ID !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
      return;
    }

    if (ctx.callbackQuery.data === "clear_db_no") {
      await ctx.answerCallbackQuery();
      await ctx.reply("Ок, отменено.");
      return;
    }

    await ctx.answerCallbackQuery();
    deps.sqlite.exec("PRAGMA foreign_keys = OFF;");
    deps.sqlite.exec(`
      DELETE FROM checkin_recommendations;
      DELETE FROM bank_holder_votes;
      DELETE FROM bank_holder_elections;
      DELETE FROM payments;
      DELETE FROM participant_commitments;
      DELETE FROM checkins;
      DELETE FROM checkin_windows;
      DELETE FROM goals;
      DELETE FROM participants;
      DELETE FROM challenges;
      DELETE FROM commitment_templates;
      DELETE FROM bot_sessions;
    `);
    deps.sqlite.exec("PRAGMA foreign_keys = ON;");
    seedCommitmentTemplates(deps.db);

    await ctx.reply("База данных очищена ✅");
  });

  bot.catch(async (err) => {
    console.error("[bot error]", err.error);
    captureException(err.error, {
      update_id: err.ctx.update.update_id,
      chat_id: err.ctx.chat?.id,
      from_id: err.ctx.from?.id
    });
    try {
      if (err.ctx.chat) {
        await err.ctx.reply("Произошла ошибка. Попробуйте ещё раз позже.");
      }
    } catch {
      // ignore
    }
  });

  return bot;
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
  const endsAt =
    deps.env.CHALLENGE_DURATION_UNIT === "hours"
      ? startedAt + challenge.durationMonths * 60 * 60 * 1000
      : deps.env.CHALLENGE_DURATION_UNIT === "days"
        ? startedAt + challenge.durationMonths * 24 * 60 * 60 * 1000
        : addMonthsMs(startedAt, challenge.durationMonths);

  deps.db
    .update(challenges)
    .set({ status: "active", startedAt, endsAt })
    .where(eq(challenges.id, challengeId))
    .run();

  const checkinPeriodMs =
    deps.env.CHECKIN_PERIOD_MINUTES > 0
      ? deps.env.CHECKIN_PERIOD_MINUTES * 60 * 1000
      : deps.env.CHECKIN_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const checkinWindowMs = checkinWindowHours * 60 * 60 * 1000;
  generateCheckinWindowsForChallenge({
    db: deps.db,
    challengeId,
    startedAt,
    endsAt,
    checkinPeriodMs,
    checkinWindowMs
  });

  await api.sendMessage(challenge.chatId, "✅ Все оплаты подтверждены. Челлендж активирован!");
}

function addMonthsMs(startMs: number, months: number) {
  const d = new Date(startMs);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}
