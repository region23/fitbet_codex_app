import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, inArray } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { bankHolderElections, bankHolderVotes, challenges, participants, payments } from "../db/schema.js";

export type FinalizeElectionMode = "all_votes" | "timeout";

export async function finalizeBankHolderElection(opts: {
  db: BetterSQLite3Database;
  api: Api;
  electionId: number;
  now: number;
  mode: FinalizeElectionMode;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;

  const election = opts.db
    .select()
    .from(bankHolderElections)
    .where(eq(bankHolderElections.id, opts.electionId))
    .get();
  if (!election || election.status !== "in_progress") return { finalized: false as const };

  if (opts.mode === "timeout" && opts.now - election.createdAt < timeoutMs) {
    return { finalized: false as const };
  }

  const challenge = opts.db.select().from(challenges).where(eq(challenges.id, election.challengeId)).get();
  if (!challenge) return { finalized: false as const };

  const eligible = opts.db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.challengeId, election.challengeId),
        inArray(participants.status, ["pending_payment", "payment_marked", "active"])
      )
    )
    .all();
  if (eligible.length === 0) return { finalized: false as const };

  const votes = opts.db
    .select()
    .from(bankHolderVotes)
    .where(eq(bankHolderVotes.electionId, opts.electionId))
    .all();

  const voterIds = new Set(votes.map((v) => v.voterId));
  if (opts.mode === "all_votes" && voterIds.size < eligible.length) {
    return { finalized: false as const };
  }

  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v.votedForId, (counts.get(v.votedForId) ?? 0) + 1);

  const eligibleUserIds = eligible.map((p) => p.userId).sort((a, b) => a - b);
  const creatorId = challenge.creatorId;

  let winnerUserId: number;
  if (counts.size === 0) {
    winnerUserId = eligibleUserIds.includes(creatorId) ? creatorId : eligibleUserIds[0]!;
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
    winnerUserId = bestUserId;
  }

  const winner = eligible.find((p) => p.userId === winnerUserId);

  opts.db
    .update(challenges)
    .set({
      bankHolderId: winnerUserId,
      bankHolderUsername: winner?.username ?? null,
      status: "pending_payments"
    })
    .where(eq(challenges.id, election.challengeId))
    .run();
  opts.db
    .update(bankHolderElections)
    .set({ status: "completed", completedAt: opts.now })
    .where(eq(bankHolderElections.id, opts.electionId))
    .run();

  const label = winner?.username ? `@${winner.username}` : winner?.firstName ?? String(winnerUserId);
  await opts.api.sendMessage(challenge.chatId, `🏦 Bank Holder выбран: ${label}`);
  try {
    await opts.api.sendMessage(
      winnerUserId,
      "Вы выбраны Bank Holder. Вам будут приходить запросы на подтверждение оплат."
    );
  } catch {
    // ignore
  }

  for (const p of eligible) {
    if (p.status !== "pending_payment") continue;
    const kb = new InlineKeyboard().text("💳 Я оплатил", `paid_${p.id}`);
    try {
      await opts.api.sendMessage(p.userId, "Пора оплатить участие. Нажмите кнопку после оплаты:", {
        reply_markup: kb
      });
    } catch {
      // ignore
    }
  }

  // If кто-то отметил оплату ДО выбора Bank Holder — после завершения выборов попросим подтвердить.
  for (const p of eligible) {
    if (p.status !== "payment_marked") continue;

    // Если это сам Bank Holder — подтверждаем сразу (как в обычном paid flow).
    if (p.userId === winnerUserId) {
      opts.db
        .insert(payments)
        .values({
          participantId: p.id,
          status: "confirmed",
          markedPaidAt: opts.now,
          confirmedAt: opts.now,
          confirmedBy: winnerUserId
        })
        .onConflictDoUpdate({
          target: payments.participantId,
          set: { status: "confirmed", markedPaidAt: opts.now, confirmedAt: opts.now, confirmedBy: winnerUserId }
        })
        .run();
      opts.db.update(participants).set({ status: "active" }).where(eq(participants.id, p.id)).run();
      try {
        await opts.api.sendMessage(p.userId, "Оплата подтверждена ✅ (вы Bank Holder).");
      } catch {
        // ignore
      }
      continue;
    }

    const who = p.username ? `@${p.username}` : p.firstName ?? `id ${p.userId}`;
    const kb = new InlineKeyboard().text("✅ Подтвердить оплату", `confirm_${p.id}`);
    try {
      await opts.api.sendMessage(
        winnerUserId,
        `Участник ${who} ранее отметил оплату. Подтвердите, пожалуйста:`,
        { reply_markup: kb }
      );
    } catch {
      // ignore
    }
  }

  return { finalized: true as const, winnerUserId };
}
