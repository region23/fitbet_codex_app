import { describe, expect, it } from "vitest";
import { createTestBot } from "../bot/testkit.js";
import {
  challenges,
  checkinWindows,
  checkins,
  goals,
  participants,
  payments
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { finalizeEndedChallenges } from "./tasks.js";

describe("finale", () => {
  it("finalizes ended challenges and marks participants completed", async () => {
    const now = 1_700_000_000_000;
    const { bot, db, apiCalls, close } = createTestBot({ now: () => now });
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
          status: "active",
          createdAt: now - 10_000,
          startedAt: now - 10_000,
          endsAt: now - 1
        })
        .returning({ id: challenges.id })
        .get().id;

      const p1 = db
        .insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          track: "cut",
          startWeight: 100,
          startWaist: 100,
          height: 180,
          status: "active",
          joinedAt: now - 10_000,
          totalCheckins: 2,
          completedCheckins: 2,
          skippedCheckins: 0
        })
        .returning({ id: participants.id })
        .get().id;

      const p2 = db
        .insert(participants)
        .values({
          challengeId,
          userId: 20,
          username: "u2",
          firstName: "U2",
          track: "cut",
          startWeight: 100,
          startWaist: 100,
          height: 180,
          status: "active",
          joinedAt: now - 10_000,
          totalCheckins: 2,
          completedCheckins: 1,
          skippedCheckins: 1
        })
        .returning({ id: participants.id })
        .get().id;

      db.insert(goals)
        .values({
          participantId: p1,
          targetWeight: 90,
          targetWaist: 90,
          isValidated: true,
          createdAt: now,
          updatedAt: now
        })
        .run();
      db.insert(goals)
        .values({
          participantId: p2,
          targetWeight: 90,
          targetWaist: 90,
          isValidated: true,
          createdAt: now,
          updatedAt: now
        })
        .run();

      const windowId = db
        .insert(checkinWindows)
        .values({
          challengeId,
          windowNumber: 1,
          opensAt: now - 10_000,
          closesAt: now - 5_000,
          status: "closed"
        })
        .returning({ id: checkinWindows.id })
        .get().id;

      db.insert(checkins)
        .values({
          participantId: p1,
          windowId,
          weight: 89,
          waist: 89,
          submittedAt: now - 2
        })
        .run();
      db.insert(checkins)
        .values({
          participantId: p2,
          windowId,
          weight: 95,
          waist: 95,
          submittedAt: now - 2
        })
        .run();

      db.insert(payments).values({ participantId: p1, status: "confirmed" }).run();
      db.insert(payments).values({ participantId: p2, status: "confirmed" }).run();

      await finalizeEndedChallenges({ db, api: bot.api, now: () => now });

      const ch = db.select().from(challenges).where(eq(challenges.id, challengeId)).get()!;
      expect(ch.status).toBe("completed");

      const p1After = db.select().from(participants).where(eq(participants.id, p1)).get()!;
      const p2After = db.select().from(participants).where(eq(participants.id, p2)).get()!;
      expect(p1After.status).toBe("completed");
      expect(p2After.status).toBe("completed");

      const groupMsg = apiCalls.find(
        (c) =>
          c.method === "sendMessage" &&
          (c.payload as any).chat_id === -100 &&
          String((c.payload as any).text).includes("Челлендж завершён")
      );
      expect(groupMsg).toBeTruthy();
    } finally {
      close();
    }
  });
});
