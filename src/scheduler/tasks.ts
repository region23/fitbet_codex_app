import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import {
  bankHolderElections,
  challenges,
  checkinWindows,
  checkins,
  participants
} from "../db/schema.js";
import { reminderHoursBeforeClose } from "../constants.js";
import { finalizeBankHolderElection } from "../services/bankholderElection.js";

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
    .all();

  for (const w of due) {
    deps.db.update(checkinWindows).set({ status: "open" }).where(eq(checkinWindows.id, w.id)).run();
    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, w.challengeId)).get();
    if (!challenge) continue;

    const kb = new InlineKeyboard().text("📋 Сделать чек-ин", `checkin_${w.id}`);
    await deps.api.sendMessage(
      challenge.chatId,
      `Открыто окно чек-ина #${w.windowNumber} (48 часов).`,
      { reply_markup: kb }
    );

    const active = deps.db
      .select()
      .from(participants)
      .where(and(eq(participants.challengeId, w.challengeId), eq(participants.status, "active")))
      .all();
    for (const p of active) {
      try {
        await deps.api.sendMessage(
          p.userId,
          `Открыто окно чек-ина #${w.windowNumber}. Перейдите в группу и нажмите «Сделать чек-ин».`
        );
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

export async function closeCheckinWindows(deps: Deps) {
  const ts = deps.now();
  const due = deps.db
    .select()
    .from(checkinWindows)
    .where(and(eq(checkinWindows.status, "open"), lte(checkinWindows.closesAt, ts)))
    .all();

  for (const w of due) {
    deps.db.update(checkinWindows).set({ status: "closed" }).where(eq(checkinWindows.id, w.id)).run();

    const challenge = deps.db.select().from(challenges).where(eq(challenges.id, w.challengeId)).get();
    if (!challenge) continue;

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

    await deps.api.sendMessage(
      challenge.chatId,
      `Окно чек-ина #${w.windowNumber} закрыто.\nСдали: ${ok.length ? ok.join(", ") : "—"}\nПропустили: ${
        skipped.length ? skipped.join(", ") : "—"
      }`
    );
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
