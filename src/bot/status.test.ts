import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { challenges, goals, participants } from "../db/schema.js";

describe("/status", () => {
  it("shows private status with goal", async () => {
    const { bot, db, apiCalls, close } = createTestBot();
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
          createdAt: 1
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
          joinedAt: 1
        })
        .returning({ id: participants.id })
        .get().id;

      db.insert(goals)
        .values({
          participantId,
          targetWeight: 75,
          targetWaist: 85,
          isValidated: true,
          createdAt: 1,
          updatedAt: 1
        })
        .run();

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U1" },
          from: { id: 10, is_bot: false, first_name: "U1" },
          text: "/status",
          entities: [{ offset: 0, length: 7, type: "bot_command" }]
        }
      });

      const sent = apiCalls.find((c) => c.method === "sendMessage")!;
      expect((sent.payload as any).text).toContain("Ваши участия");
      expect((sent.payload as any).text).toContain("Статус участия: *Активно*");
      expect((sent.payload as any).text).toContain("Статус челленджа: *Активен*");
      expect((sent.payload as any).text).toContain("Цель");
    } finally {
      close();
    }
  });

  it("uses Russian labels for statuses", async () => {
    const { bot, db, apiCalls, close } = createTestBot();
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
          createdAt: 1
        })
        .returning({ id: challenges.id })
        .get().id;

      db.insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "payment_marked",
          joinedAt: 1
        })
        .run();

      await bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 10,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U1" },
          from: { id: 10, is_bot: false, first_name: "U1" },
          text: "/status",
          entities: [{ offset: 0, length: 7, type: "bot_command" }]
        }
      });

      const sent = apiCalls.find((c) => c.method === "sendMessage")!;
      const text = (sent.payload as any).text as string;
      expect(text).toContain("Статус участия: *Оплата отмечена*");
      expect(text).toContain("Статус челленджа: *Набор участников*");
      expect(text).not.toContain("payment_marked");
      expect(text).not.toContain("draft");
    } finally {
      close();
    }
  });

  it("shows group status with participants list", async () => {
    const { bot, db, apiCalls, close } = createTestBot();
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
          createdAt: 1
        })
        .returning({ id: challenges.id })
        .get().id;

      db.insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "onboarding",
          joinedAt: 1
        })
        .run();
      db.insert(participants)
        .values({
          challengeId,
          userId: 20,
          username: "u2",
          firstName: "U2",
          status: "pending_payment",
          joinedAt: 1
        })
        .run();

      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: -100, type: "group", title: "Test Chat" },
          from: { id: 1, is_bot: false, first_name: "Creator" },
          text: "/status",
          entities: [{ offset: 0, length: 7, type: "bot_command" }]
        }
      });

      const sent = apiCalls.filter((c) => c.method === "sendMessage").at(-1)!;
      expect((sent.payload as any).text).toContain("Участники");
      expect((sent.payload as any).text).toContain("Статус: *Набор участников*");
      expect((sent.payload as any).text).toContain("@u1");
      expect((sent.payload as any).text).toContain("— Онбординг");
      expect((sent.payload as any).text).toContain("@u2");
      expect((sent.payload as any).text).toContain("— Ожидает оплату");
    } finally {
      close();
    }
  });
});
