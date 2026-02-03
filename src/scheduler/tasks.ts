import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import {
  bankHolderElections,
  challenges,
  checkinDmNotifications,
  checkinGroupNotifications,
  checkinWindows,
  checkins,
  goals,
  habitReminderSends,
  payments,
  participantCommitments,
  participants
} from "../db/schema.js";
import { reminderHoursBeforeClose } from "../constants.js";
import { finalizeBankHolderElection } from "../services/bankholderElection.js";
import { buildHabitsMessage, getDateKey, getLocalHour, habitReminderHour } from "../services/habits.js";

type Deps = {
  db: BetterSQLite3Database;
  api: Api;
  now: () => number;
};

export async function openCheckinWindows(deps: Deps) {
  const ts = deps.now();
  const due = deps.db
    .select()
    .from(checkinWindows)
    .where(and(eq(checkinWindows.status, "scheduled"), lte(checkinWindows.opensAt, ts)))
    .orderBy(checkinWindows.opensAt)
    .all();

  for (const w of due) {
    const nextWindow = deps.db
      .select()
      .from(checkinWindows)
      .where(and(eq(checkinWindows.challengeId, w.challengeId), gt(checkinWindows.opensAt, w.opensAt)))
      .orderBy(checkinWindows.opensAt)
      .get();
    if (nextWindow && w.closesAt > nextWindow.opensAt) {
      deps.db
        .update(checkinWindows)
        .set({ closesAt: nextWindow.opensAt })
        .where(eq(checkinWindows.id, w.id))
        .run();
      w.closesAt = nextWindow.opensAt;
    }

    const overlapping = deps.db
      .select()
      .from(checkinWindows)
      .where(
        and(
          eq(checkinWindows.challengeId, w.challengeId),
          eq(checkinWindows.status, "open"),
          lt(checkinWindows.opensAt, w.opensAt)
        )
      )
      .all();
    for (const prev of overlapping) {
      await closeCheckinWindow(deps, prev, { notify: false, closedAtOverride: w.opensAt });
    }

    deps.db.update(checkinWindows).set({ status: "open" }).where(eq(checkinWindows.id, w.id)).run();
    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, w.challengeId)).get();
    if (!challenge) continue;

    const durationLabel = formatWindowDuration(w.closesAt - w.opensAt);
    const kb = new InlineKeyboard().text("📋 Сделать чек-ин", `checkin_${w.id}`);
    const prevGroup = deps.db
      .select()
      .from(checkinGroupNotifications)
      .where(eq(checkinGroupNotifications.challengeId, w.challengeId))
      .get();
    if (prevGroup) {
      try {
        await deps.api.deleteMessage(challenge.chatId, prevGroup.messageId);
      } catch {
        // ignore
      }
    }

    const groupMsg = await deps.api.sendMessage(
      challenge.chatId,
      `Открыто окно чек-ина #${w.windowNumber} (${durationLabel}).`,
      { reply_markup: kb }
    );

    deps.db
      .insert(checkinGroupNotifications)
      .values({ challengeId: w.challengeId, messageId: groupMsg.message_id, windowId: w.id })
      .onConflictDoUpdate({
        target: checkinGroupNotifications.challengeId,
        set: { messageId: groupMsg.message_id, windowId: w.id }
      })
      .run();

    const active = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, w.challengeId), eq(participants.status, "active")))
      .all();
    for (const p of active) {
      try {
        const prev = deps.db
          .select()
          .from(checkinDmNotifications)
          .where(eq(checkinDmNotifications.participantId, p.id))
          .get();
        if (prev) {
          try {
            await deps.api.deleteMessage(p.userId, prev.messageId);
          } catch {
            // ignore
          }
        }

        const dmKb = new InlineKeyboard().text("📋 Сдать чек-ин", `checkin_${w.id}`);
        const dmMsg = await deps.api.sendMessage(
          p.userId,
          `Открыто окно чек-ина #${w.windowNumber} (${durationLabel}). Нажмите «Сдать чек-ин».`,
          { reply_markup: dmKb }
        );
        deps.db
          .insert(checkinDmNotifications)
          .values({ participantId: p.id, messageId: dmMsg.message_id, windowId: w.id })
          .onConflictDoUpdate({
            target: checkinDmNotifications.participantId,
            set: { messageId: dmMsg.message_id, windowId: w.id }
          })
          .run();
      } catch {
        // ignore
      }
    }

  }
}

export async function sendCheckinReminders(deps: Deps) {
  const ts = deps.now();
  const threshold = ts + reminderHoursBeforeClose * 60 * 60 * 1000;
  const windows = deps.db
    .select()
    .from(checkinWindows)
    .where(
      and(
        eq(checkinWindows.status, "open"),
        lte(checkinWindows.closesAt, threshold),
        sql`${checkinWindows.reminderSentAt} IS NULL`
      )
    )
    .all();

  for (const w of windows) {
    const windowDurationMs = w.closesAt - w.opensAt;
    if (windowDurationMs <= reminderHoursBeforeClose * 60 * 60 * 1000) {
      deps.db
        .update(checkinWindows)
        .set({ reminderSentAt: ts })
        .where(eq(checkinWindows.id, w.id))
        .run();
      continue;
    }

    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, w.challengeId)).get();
    if (!challenge) continue;

    const active = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, w.challengeId), eq(participants.status, "active")))
      .all();
    if (active.length === 0) continue;

    const submitted = new Set(
      deps.db
        .select({ pid: checkins.participantId })
        .from(checkins)
        .where(eq(checkins.windowId, w.id))
        .all()
        .map((r) => r.pid)
    );

    const missing = active.filter((p) => !submitted.has(p.id));
    if (missing.length === 0) {
      deps.db
        .update(checkinWindows)
        .set({ reminderSentAt: ts })
        .where(eq(checkinWindows.id, w.id))
        .run();
      continue;
    }

    const list = missing
      .map((p) => (p.username ? `@${p.username}` : p.firstName ?? `id ${p.userId}`))
      .join(", ");

    await deps.api.sendMessage(
      challenge.chatId,
      `Напоминание: до закрытия чек-ина #${w.windowNumber} осталось ~${reminderHoursBeforeClose} ч.\nНе сдали: ${list}`
    );

    for (const p of missing) {
      try {
        await deps.api.sendMessage(p.userId, `Напоминание: сдайте чек-ин #${w.windowNumber} до закрытия окна.`);
      } catch {
        // ignore
      }
    }

    deps.db
      .update(checkinWindows)
      .set({ reminderSentAt: ts })
      .where(eq(checkinWindows.id, w.id))
      .run();
  }
}

export async function sendHabitReminders(deps: Deps) {
  const ts = deps.now();
  if (getLocalHour(ts) !== habitReminderHour) return;

  const dateKey = getDateKey(ts);
  const rows = deps.db
    .select({
      participantId: participantCommitments.participantId,
      userId: participants.userId
    })
    .from(participantCommitments)
    .innerJoin(participants, eq(participantCommitments.participantId, participants.id))
    .where(eq(participants.status, "active"))
    .all();

  const unique = new Map<number, number>();
  for (const row of rows) {
    unique.set(row.participantId, row.userId);
  }

  for (const [participantId, userId] of unique) {
    const alreadySent = deps.db
      .select()
      .from(habitReminderSends)
      .where(and(eq(habitReminderSends.participantId, participantId), eq(habitReminderSends.dateKey, dateKey)))
      .get();
    if (alreadySent) continue;

    const msg = buildHabitsMessage({ db: deps.db, participantId, now: ts });
    try {
      await deps.api.sendMessage(userId, msg.text, {
        parse_mode: "Markdown",
        reply_markup: msg.keyboard
      });
      deps.db
        .insert(habitReminderSends)
        .values({ participantId, dateKey, sentAt: ts })
        .run();
    } catch {
      // ignore
    }
  }
}

export async function closeCheckinWindows(deps: Deps) {
  const ts = deps.now();
  const due = deps.db
    .select()
    .from(checkinWindows)
    .where(and(eq(checkinWindows.status, "open"), lte(checkinWindows.closesAt, ts)))
    .all();

  for (const w of due) {
    await closeCheckinWindow(deps, w, { notify: true });
  }
}

export async function handleOnboardingTimeouts(deps: Deps, timeoutMs = 48 * 60 * 60 * 1000) {
  const ts = deps.now();
  const limit = ts - timeoutMs;

  const stale = deps.db
    .select()
    .from(participants)
    .where(and(eq(participants.status, "onboarding"), lte(participants.joinedAt, limit)))
    .all();

  for (const p of stale) {
    deps.db.update(participants).set({ status: "dropped" }).where(eq(participants.id, p.id)).run();
    const ch = deps.db.select().from(challenges).where(eq(challenges.id, p.challengeId)).get();
    if (!ch) continue;
    const label = p.username ? `@${p.username}` : p.firstName ?? `id ${p.userId}`;
    try {
      await deps.api.sendMessage(ch.chatId, `⏳ ${label} не завершил(а) онбординг за 48 часов и выбыл(а) из челленджа.`);
    } catch {
      // ignore
    }
    try {
      await deps.api.sendMessage(
        p.userId,
        "Онбординг не завершён за 48 часов, вы исключены из текущего челленджа. Присоединитесь к следующему."
      );
    } catch {
      // ignore
    }
  }
}

export async function finalizeOverdueBankHolderElections(
  deps: Deps,
  timeoutMs = 24 * 60 * 60 * 1000
) {
  const ts = deps.now();
  const limit = ts - timeoutMs;

  const overdue = deps.db
    .select()
    .from(bankHolderElections)
    .where(and(eq(bankHolderElections.status, "in_progress"), lte(bankHolderElections.createdAt, limit)))
    .all();

  for (const e of overdue) {
    await finalizeBankHolderElection({
      db: deps.db,
      api: deps.api,
      electionId: e.id,
      now: ts,
      mode: "timeout",
      timeoutMs
    });
  }
}

export async function finalizeEndedChallenges(deps: Deps) {
  const ts = deps.now();
  const ended = deps.db
    .select()
    .from(challenges)
    .where(and(eq(challenges.status, "active"), lte(challenges.endsAt, ts)))
    .all();

  for (const ch of ended) {
    const openWindows = deps.db
      .select()
      .from(checkinWindows)
      .where(and(eq(checkinWindows.challengeId, ch.id), eq(checkinWindows.status, "open")))
      .all();
    for (const w of openWindows) {
      await closeCheckinWindow(deps, w, { notify: false, closedAtOverride: ts });
    }

    const paid = deps.db
      .select({
        participantId: participants.id,
        userId: participants.userId,
        username: participants.username,
        firstName: participants.firstName,
        status: participants.status,
        track: participants.track,
        startWeight: participants.startWeight,
        startWaist: participants.startWaist,
        height: participants.height,
        totalCheckins: participants.totalCheckins,
        completedCheckins: participants.completedCheckins,
        skippedCheckins: participants.skippedCheckins
      })
      .from(participants)
      .innerJoin(payments, eq(payments.participantId, participants.id))
      .where(and(eq(participants.challengeId, ch.id), eq(payments.status, "confirmed")))
      .all();

    if (paid.length === 0) {
      deps.db.update(challenges).set({ status: "completed" }).where(eq(challenges.id, ch.id)).run();
      continue;
    }

    const results = paid.map((p) => {
      const goal = deps.db.select().from(goals).where(eq(goals.participantId, p.participantId)).get();
      const latest = deps.db
        .select()
        .from(checkins)
        .where(eq(checkins.participantId, p.participantId))
        .orderBy(desc(checkins.submittedAt))
        .get();

      const currentWeight = latest?.weight ?? p.startWeight ?? 0;
      const currentWaist = latest?.waist ?? p.startWaist ?? 0;

      const disciplineScore =
        p.totalCheckins > 0 ? (p.completedCheckins / p.totalCheckins) * 100 : 100;

      const goalAchievement = goal
        ? computeGoalAchievement({
            track: (p.track as any) ?? "cut",
            startWeight: p.startWeight ?? 0,
            startWaist: p.startWaist ?? 0,
            targetWeight: goal.targetWeight,
            targetWaist: goal.targetWaist,
            currentWeight,
            currentWaist
          })
        : 0;

      const totalScore = 0.7 * goalAchievement + 0.3 * disciplineScore;

      const isWinner =
        (p.status === "active" || p.status === "completed") &&
        disciplineScore >= ch.disciplineThreshold * 100 &&
        goalAchievement >= 100;

      return {
        participantId: p.participantId,
        userId: p.userId,
        label: p.username ? `@${p.username}` : p.firstName ?? `id ${p.userId}`,
        isWinner,
        disciplineScore,
        goalAchievement,
        totalScore
      };
    });

    const winners = results.filter((r) => r.isWinner);
    const losers = results.filter((r) => !r.isWinner);

    const stake = ch.stakeAmount;
    const pool = losers.length * stake;
    const extraPerWinner = winners.length > 0 ? pool / winners.length : 0;

    const payout = (r: (typeof results)[number]) => {
      if (winners.length === 0) return stake; // всем возврат
      if (losers.length === 0) return stake; // все победили
      return r.isWinner ? stake + extraPerWinner : 0;
    };

    const ranking = [...results].sort((a, b) => b.totalScore - a.totalScore);
    const lines = ranking.map((r, i) => {
      const badge = r.isWinner ? "🏆" : "—";
      return `${i + 1}. ${badge} ${r.label} — ${r.totalScore.toFixed(1)} (цель ${r.goalAchievement.toFixed(
        1
      )} / дисциплина ${r.disciplineScore.toFixed(1)})`;
    });

    await deps.api.sendMessage(
      ch.chatId,
      `🏁 Челлендж завершён!\n\nРейтинг:\n${lines.join("\n")}`
    );

    for (const r of results) {
      const money = payout(r);
      const msg = `🏁 Челлендж завершён.\n\nРезультат: ${
        r.isWinner ? "победа 🏆" : "не выполнено"
      }\nЦель: ${r.goalAchievement.toFixed(1)}%\nДисциплина: ${r.disciplineScore.toFixed(
        1
      )}%\nИтог: ${r.totalScore.toFixed(1)}\n\nВыплата: ${money.toFixed(0)} ₽`;
      try {
        await deps.api.sendMessage(r.userId, msg);
      } catch {
        // ignore
      }
    }

    deps.db.update(challenges).set({ status: "completed" }).where(eq(challenges.id, ch.id)).run();
    deps.db
      .update(participants)
      .set({ status: "completed" })
      .where(and(eq(participants.challengeId, ch.id), eq(participants.status, "active")))
      .run();
  }
}

async function closeCheckinWindow(
  deps: Deps,
  w: typeof checkinWindows.$inferSelect,
  opts: { notify: boolean; closedAtOverride?: number }
) {
  const closedAt =
    typeof opts.closedAtOverride === "number" ? Math.min(w.closesAt, opts.closedAtOverride) : w.closesAt;
  deps.db
    .update(checkinWindows)
    .set({ status: "closed", closesAt: closedAt })
    .where(eq(checkinWindows.id, w.id))
    .run();

  const challenge = deps.db.select().from(challenges).where(eq(challenges.id, w.challengeId)).get();
  if (!challenge) return;

  const active = deps.db
    .select()
    .from(participants)
    .where(and(eq(participants.challengeId, w.challengeId), eq(participants.status, "active")))
    .all();

  const submitted = new Set(
    deps.db
      .select({ pid: checkins.participantId })
      .from(checkins)
      .where(eq(checkins.windowId, w.id))
      .all()
      .map((r) => r.pid)
  );

  const ok: string[] = [];
  const skipped: string[] = [];

  for (const p of active) {
    const label = p.username ? `@${p.username}` : p.firstName ?? `id ${p.userId}`;
    if (submitted.has(p.id)) {
      ok.push(label);
      continue;
    }
    skipped.push(label);
    const nextSkipped = p.skippedCheckins + 1;
    const nextTotal = p.totalCheckins + 1;
    deps.db
      .update(participants)
      .set({
        skippedCheckins: nextSkipped,
        totalCheckins: nextTotal,
        pendingCheckinWindowId: null,
        pendingCheckinRequestedAt: null,
        status: nextSkipped > challenge.maxSkips ? "disqualified" : "active"
      })
      .where(eq(participants.id, p.id))
      .run();
  }

  if (!opts.notify) return;

  await deps.api.sendMessage(
    challenge.chatId,
    `Окно чек-ина #${w.windowNumber} закрыто.\nСдали: ${ok.length ? ok.join(", ") : "—"}\nПропустили: ${
      skipped.length ? skipped.join(", ") : "—"
    }`
  );
}

function formatWindowDuration(ms: number) {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} мин.`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours <= 48) return `${totalHours} ч.`;
  const totalDays = Math.round(totalHours / 24);
  return `${totalDays} дн.`;
}

function computeGoalAchievement(opts: {
  track: "cut" | "bulk";
  startWeight: number;
  startWaist: number;
  targetWeight: number;
  targetWaist: number;
  currentWeight: number;
  currentWaist: number;
}) {
  const clamp0 = (x: number) => (Number.isFinite(x) ? Math.max(0, x) : 0);
  if (opts.track === "bulk") {
    const denom = opts.targetWeight - opts.startWeight;
    const weightProgress = denom > 0 ? ((opts.currentWeight - opts.startWeight) / denom) * 100 : 0;
    return 0.7 * clamp0(weightProgress) + 0.3 * 100;
  }
  const wDenom = opts.startWeight - opts.targetWeight;
  const waistDenom = opts.startWaist - opts.targetWaist;
  const weightProgress = wDenom > 0 ? ((opts.startWeight - opts.currentWeight) / wDenom) * 100 : 0;
  const waistProgress = waistDenom > 0 ? ((opts.startWaist - opts.currentWaist) / waistDenom) * 100 : 0;
  return 0.7 * clamp0(weightProgress) + 0.3 * clamp0(waistProgress);
}
