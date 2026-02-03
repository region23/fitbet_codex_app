import { describe, expect, it } from "vitest";
import { createAppDb } from "../db/client.js";
import {
  challenges,
  commitmentTemplates,
  habitLogs,
  participantCommitments,
  participants
} from "../db/schema.js";
import { buildHabitsMessage } from "./habits.js";
import { eq } from "drizzle-orm";

describe("habits", () => {
  it("counts weekly habits by week and shows weekly stats", () => {
    const now = Date.UTC(2026, 0, 15, 18, 0, 0); // 21:00 MSK
    const { db, close } = createAppDb(":memory:");
    try {
      const challengeId = db
        .insert(challenges)
        .values({
          chatId: -100,
          chatTitle: "Test Chat",
          creatorId: 1,
          durationMonths: 1,
          stakeAmount: 1000,
          disciplineThreshold: 0.8,
          maxSkips: 2,
          status: "active",
          createdAt: now,
          startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
          endsAt: Date.UTC(2026, 1, 1, 0, 0, 0)
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

      const template = db
        .select()
        .from(commitmentTemplates)
        .where(eq(commitmentTemplates.name, "Тренировка 3× в неделю"))
        .get();
      if (!template) throw new Error("Template not found");

      db.insert(participantCommitments)
        .values({
          participantId,
          templateId: template.id,
          createdAt: now
        })
        .run();

      const dates = ["2026-01-12", "2026-01-13", "2026-01-15"];
      for (const dateKey of dates) {
        db.insert(habitLogs)
          .values({
            participantId,
            templateId: template.id,
            dateKey,
            status: "done",
            createdAt: now,
            updatedAt: now
          })
          .run();
      }

      const msg = buildHabitsMessage({ db, participantId, now });
      expect(msg.text).toContain("неделя 3/3");
      expect(msg.text).toContain("всего недель 1/3");
    } finally {
      close();
    }
  });
});
