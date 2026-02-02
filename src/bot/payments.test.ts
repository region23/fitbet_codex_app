import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { challenges, participants, payments } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("payments", () => {
  it("marks paid, confirms, and activates challenge", async () => {
    const { bot, db, apiCalls, close } = createTestBot({
      now: () => 1_700_000_000_000
    });
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
          bankHolderId: 20,
          bankHolderUsername: "bank",
          status: "pending_payments",
          createdAt: 1_700_000_000_000
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
          status: "pending_payment",
          joinedAt: 1_700_000_000_000
        })
        .returning({ id: participants.id })
        .get().id;

      const p2 = db
        .insert(participants)
        .values({
          challengeId,
          userId: 20,
          username: "bank",
          firstName: "Bank",
          status: "pending_payment",
          joinedAt: 1_700_000_000_000
        })
        .returning({ id: participants.id })
        .get().id;

      // User 10 marks paid
      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb_paid_1",
          from: { id: 10, is_bot: false, first_name: "U1" },
          chat_instance: "ci_paid",
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U1" },
            text: "dummy"
          },
          data: `paid_${p1}`
        }
      });

      const p1Row = db.select().from(participants).where(eq(participants.id, p1)).get()!;
      expect(p1Row.status).toBe("payment_marked");
      const pay1 = db.select().from(payments).where(eq(payments.participantId, p1)).get()!;
      expect(pay1.status).toBe("marked_paid");

      // Bank holder should receive a confirmation request
      const toBank = apiCalls.find(
        (c) => c.method === "sendMessage" && (c.payload as any).chat_id === 20
      );
      expect(toBank).toBeTruthy();
      expect((toBank!.payload as any).text).toContain("отметил оплату");

      // Bank holder marks paid for themselves (auto-confirm)
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb_paid_2",
          from: { id: 20, is_bot: false, first_name: "Bank" },
          chat_instance: "ci_paid",
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 20, type: "private", first_name: "Bank" },
            text: "dummy"
          },
          data: `paid_${p2}`
        }
      });

      const p2Row = db.select().from(participants).where(eq(participants.id, p2)).get()!;
      expect(p2Row.status).toBe("active");

      // Bank holder confirms user 10
      await bot.handleUpdate({
        update_id: 3,
        callback_query: {
          id: "cb_confirm",
          from: { id: 20, is_bot: false, first_name: "Bank" },
          chat_instance: "ci_confirm",
          message: {
            message_id: 3,
            date: 1,
            chat: { id: 20, type: "private", first_name: "Bank" },
            text: "dummy"
          },
          data: `confirm_${p1}`
        }
      });

      const p1After = db.select().from(participants).where(eq(participants.id, p1)).get()!;
      expect(p1After.status).toBe("active");
      const pay1After = db.select().from(payments).where(eq(payments.participantId, p1)).get()!;
      expect(pay1After.status).toBe("confirmed");

      const ch = db.select().from(challenges).where(eq(challenges.id, challengeId)).get()!;
      expect(ch.status).toBe("active");
      expect(ch.startedAt).toBe(1_700_000_000_000);
      expect(ch.endsAt).toBe(1_700_000_000_000 + 6 * 60 * 60 * 1000);
    } finally {
      close();
    }
  });
});

