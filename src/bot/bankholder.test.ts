import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { bankHolderElections, bankHolderVotes, challenges, participants } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("bank holder election", () => {
  it("runs /bankholder and finalizes after all votes", async () => {
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
          status: "draft",
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
        .get();
      const p2 = db
        .insert(participants)
        .values({
          challengeId,
          userId: 20,
          username: "u2",
          firstName: "U2",
          status: "pending_payment",
          joinedAt: 1_700_000_000_000
        })
        .returning({ id: participants.id })
        .get();

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -100, type: "group", title: "Test Chat" },
          from: { id: 1, is_bot: false, first_name: "Creator" },
          text: "/bankholder",
          entities: [{ offset: 0, length: 11, type: "bot_command" }]
        }
      });

      const election = db
        .select()
        .from(bankHolderElections)
        .where(eq(bankHolderElections.challengeId, challengeId))
        .get();
      expect(election?.status).toBe("in_progress");

      const dmToP1 = apiCalls.find(
        (c) => c.method === "sendMessage" && (c.payload as any).chat_id === 10
      );
      const dmToP2 = apiCalls.find(
        (c) => c.method === "sendMessage" && (c.payload as any).chat_id === 20
      );
      expect(dmToP1).toBeTruthy();
      expect(dmToP2).toBeTruthy();

      // Votes
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb_vote_1",
          from: { id: 10, is_bot: false, first_name: "U1" },
          chat_instance: "ci_vote",
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U1" },
            text: "vote"
          },
          data: `vote_${election!.id}_20`
        }
      });

      await bot.handleUpdate({
        update_id: 3,
        callback_query: {
          id: "cb_vote_2",
          from: { id: 20, is_bot: false, first_name: "U2" },
          chat_instance: "ci_vote",
          message: {
            message_id: 3,
            date: 1,
            chat: { id: 20, type: "private", first_name: "U2" },
            text: "vote"
          },
          data: `vote_${election!.id}_20`
        }
      });

      const votes = db
        .select()
        .from(bankHolderVotes)
        .where(eq(bankHolderVotes.electionId, election!.id))
        .all();
      expect(votes.length).toBe(2);

      const updatedChallenge = db.select().from(challenges).where(eq(challenges.id, challengeId)).get()!;
      expect(updatedChallenge.bankHolderId).toBe(20);
      expect(updatedChallenge.status).toBe("pending_payments");

      const finishedElection = db.select().from(bankHolderElections).where(eq(bankHolderElections.id, election!.id)).get()!;
      expect(finishedElection.status).toBe("completed");

      const groupMsg = apiCalls.find(
        (c) => c.method === "sendMessage" && (c.payload as any).chat_id === -100 && String((c.payload as any).text).includes("Bank Holder выбран")
      );
      expect(groupMsg).toBeTruthy();

      const payDm = apiCalls.find(
        (c) => c.method === "sendMessage" && (c.payload as any).chat_id === 10 && String((c.payload as any).text).includes("Пора оплатить")
      );
      expect(payDm).toBeTruthy();
      expect((payDm!.payload as any).reply_markup).toBeTruthy();
    } finally {
      close();
    }
  });
});
