import { describe, expect, it } from "vitest";
import { createTestBot } from "../bot/testkit.js";
import { challenges, checkinWindows, participants } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { closeCheckinWindows, openCheckinWindows, sendCheckinReminders } from "./tasks.js";

describe("scheduler tasks", () => {
  it("opens, reminds and closes check-in windows", async () => {
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
          maxSkips: 0,
          status: "active",
          createdAt: now,
          startedAt: now,
          endsAt: now + 6 * 60 * 60 * 1000
        })
        .returning({ id: challenges.id })
        .get().id;

      db.insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "active",
          joinedAt: now
        })
        .run();

      const windowId = db
        .insert(checkinWindows)
        .values({
          challengeId,
          windowNumber: 1,
          opensAt: now - 60_000,
          closesAt: now + 60_000,
          status: "scheduled"
        })
        .returning({ id: checkinWindows.id })
        .get().id;

      await openCheckinWindows({ db, api: bot.api, now: () => now });
      const w1 = db.select().from(checkinWindows).where(eq(checkinWindows.id, windowId)).get()!;
      expect(w1.status).toBe("open");
      expect(apiCalls.some((c) => c.method === "sendMessage" && (c.payload as any).chat_id === -100)).toBe(true);

      // Reminder: set closesAt within 12 hours and reminderSentAt null
      db.update(checkinWindows)
        .set({ closesAt: now + 1_000 })
        .where(eq(checkinWindows.id, windowId))
        .run();
      await sendCheckinReminders({ db, api: bot.api, now: () => now });
      const w2 = db.select().from(checkinWindows).where(eq(checkinWindows.id, windowId)).get()!;
      expect(w2.reminderSentAt).toBe(now);

      // Close: move closesAt to the past
      db.update(checkinWindows)
        .set({ closesAt: now - 1 })
        .where(eq(checkinWindows.id, windowId))
        .run();
      await closeCheckinWindows({ db, api: bot.api, now: () => now });
      const w3 = db.select().from(checkinWindows).where(eq(checkinWindows.id, windowId)).get()!;
      expect(w3.status).toBe("closed");

      const p = db.select().from(participants).where(eq(participants.userId, 10)).get()!;
      expect(p.totalCheckins).toBe(1);
      expect(p.skippedCheckins).toBe(1);
      expect(p.status).toBe("disqualified"); // maxSkips = 0
    } finally {
      close();
    }
  });

  it("auto-closes previous open window when a new one opens", async () => {
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
          status: "active",
          createdAt: now,
          startedAt: now,
          endsAt: now + 6 * 60 * 60 * 1000
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
          status: "active",
          joinedAt: now
        })
        .returning({ id: participants.id })
        .get().id;

      const w1Id = db
        .insert(checkinWindows)
        .values({
          challengeId,
          windowNumber: 1,
          opensAt: now - 10 * 60 * 1000,
          closesAt: now + 48 * 60 * 60 * 1000,
          status: "open"
        })
        .returning({ id: checkinWindows.id })
        .get().id;

      const w2Id = db
        .insert(checkinWindows)
        .values({
          challengeId,
          windowNumber: 2,
          opensAt: now - 60_000,
          closesAt: now + 48 * 60 * 60 * 1000,
          status: "scheduled"
        })
        .returning({ id: checkinWindows.id })
        .get().id;

      await openCheckinWindows({ db, api: bot.api, now: () => now });

      const w1 = db.select().from(checkinWindows).where(eq(checkinWindows.id, w1Id)).get()!;
      const w2 = db.select().from(checkinWindows).where(eq(checkinWindows.id, w2Id)).get()!;
      expect(w1.status).toBe("closed");
      expect(w2.status).toBe("open");

      const p = db.select().from(participants).where(eq(participants.id, participantId)).get()!;
      expect(p.totalCheckins).toBe(1);
      expect(p.skippedCheckins).toBe(1);
      expect(p.status).toBe("active");
    } finally {
      close();
    }
  });
});
