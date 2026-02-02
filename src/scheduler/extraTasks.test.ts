import { describe, expect, it } from "vitest";
import { createTestBot } from "../bot/testkit.js";
import {
  bankHolderElections,
  bankHolderVotes,
  challenges,
  participants
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import { finalizeOverdueBankHolderElections, handleOnboardingTimeouts } from "./tasks.js";

describe("scheduler extra tasks", () => {
  it("drops onboarding participants after 48h", async () => {
    const now = 1_700_000_000_000;
    const { bot, db, close } = createTestBot({ now: () => now });
    try {
      const challengeId = db
        .insert(challenges)
        .values({
          chatId: -100,
          chatTitle: "Test Chat",
          creatorId: 1,
          durationMonths: 6,
          stakeAmount: 1000,
          disciplineThreshold: 0.8,
          maxSkips: 2,
          status: "draft",
          createdAt: now
        })
        .returning({ id: challenges.id })
        .get().id;

      const participantId = db
        .insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "onboarding",
          joinedAt: now - 49 * 60 * 60 * 1000
        })
        .returning({ id: participants.id })
        .get().id;

      await handleOnboardingTimeouts({ db, api: bot.api, now: () => now });
      const p = db.select().from(participants).where(eq(participants.id, participantId)).get()!;
      expect(p.status).toBe("dropped");
    } finally {
      close();
    }
  });

  it("finalizes bank holder election on timeout", async () => {
    const now = 1_700_000_000_000;
    const { bot, db, close } = createTestBot({ now: () => now });
    try {
      const challengeId = db
        .insert(challenges)
        .values({
          chatId: -100,
          chatTitle: "Test Chat",
          creatorId: 1,
          durationMonths: 6,
          stakeAmount: 1000,
          disciplineThreshold: 0.8,
          maxSkips: 2,
          status: "draft",
          createdAt: now
        })
        .returning({ id: challenges.id })
        .get().id;

      db.insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "pending_payment",
          joinedAt: now
        })
        .run();
      db.insert(participants)
        .values({
          challengeId,
          userId: 20,
          username: "u2",
          firstName: "U2",
          status: "pending_payment",
          joinedAt: now
        })
        .run();

      const electionId = db
        .insert(bankHolderElections)
        .values({
          challengeId,
          initiatedBy: 1,
          status: "in_progress",
          createdAt: now - 25 * 60 * 60 * 1000
        })
        .returning({ id: bankHolderElections.id })
        .get().id;

      // Only one vote
      db.insert(bankHolderVotes)
        .values({
          electionId,
          voterId: 10,
          votedForId: 20,
          votedAt: now
        })
        .run();

      await finalizeOverdueBankHolderElections({ db, api: bot.api, now: () => now });

      const ch = db.select().from(challenges).where(eq(challenges.id, challengeId)).get()!;
      expect(ch.bankHolderId).toBe(20);
      expect(ch.status).toBe("pending_payments");
    } finally {
      close();
    }
  });
});

