import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { challenges, goals, participantCommitments, participants, payments } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("onboarding", () => {
  it("collects metrics and start photos", async () => {
    const { bot, db, apiCalls, savedPhotos, close } = createTestBot({
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

      const participantId = db
        .insert(participants)
        .values({
          challengeId,
          userId: 10,
          firstName: "U",
          status: "onboarding",
          joinedAt: 1_700_000_000_000
        })
        .returning({ id: participants.id })
        .get().id;

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "/start",
          entities: [{ offset: 0, length: 6, type: "bot_command" }]
        }
      });

      const firstPrompt = apiCalls.find((c) => c.method === "sendMessage")!;
      expect((firstPrompt.payload as any).text).toContain("Выберите трек");

      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb_track",
          from: { id: 10, is_bot: false, first_name: "U" },
          chat_instance: "ci",
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U" },
            text: "dummy"
          },
          data: "onb_track_cut"
        }
      });

      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "80"
        }
      });
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "90"
        }
      });
      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 5,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "180"
        }
      });

      const sendPhotoUpdate = (updateId: number, fileId: string) =>
        bot.handleUpdate({
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U" },
            from: { id: 10, is_bot: false, first_name: "U" },
            photo: [
              { file_id: `${fileId}_s`, file_unique_id: `${fileId}_us`, width: 10, height: 10 },
              { file_id: fileId, file_unique_id: `${fileId}_u`, width: 100, height: 100 }
            ]
          }
        });

      await sendPhotoUpdate(6, "front_file");
      await sendPhotoUpdate(7, "left_file");
      await sendPhotoUpdate(8, "right_file");
      await sendPhotoUpdate(9, "back_file");

      await bot.handleUpdate({
        update_id: 10,
        callback_query: {
          id: "cb_goal_w",
          from: { id: 10, is_bot: false, first_name: "U" },
          chat_instance: "ci_goal",
          message: {
            message_id: 10,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U" },
            text: "dummy"
          },
          data: "onb_goal_weight_accept"
        }
      });

      await bot.handleUpdate({
        update_id: 11,
        callback_query: {
          id: "cb_goal_waist",
          from: { id: 10, is_bot: false, first_name: "U" },
          chat_instance: "ci_goal",
          message: {
            message_id: 11,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U" },
            text: "dummy"
          },
          data: "onb_goal_waist_accept"
        }
      });

      await bot.handleUpdate({
        update_id: 12,
        message: {
          message_id: 12,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "1 2"
        }
      });

      const p = db.select().from(participants).where(eq(participants.id, participantId)).get()!;
      expect(p.track).toBe("cut");
      expect(p.startWeight).toBe(80);
      expect(p.startWaist).toBe(90);
      expect(p.height).toBe(180);
      expect(p.startPhotoFrontId).toBe("front_file");
      expect(p.startPhotoBackId).toBe("back_file");
      expect(p.status).toBe("pending_payment");

      const g = db.select().from(goals).where(eq(goals.participantId, participantId)).get();
      expect(g?.targetWeight).toBeTypeOf("number");
      expect(g?.targetWaist).toBeTypeOf("number");

      const pay = db.select().from(payments).where(eq(payments.participantId, participantId)).get();
      expect(pay?.status).toBe("pending");

      const comm = db
        .select()
        .from(participantCommitments)
        .where(eq(participantCommitments.participantId, participantId))
        .all();
      expect(comm.length).toBe(2);

      expect(savedPhotos.map((s) => s.destinationPath)).toContain(
        `data/photos/${participantId}/start/front.jpg`
      );
      expect(savedPhotos.map((s) => s.destinationPath)).toContain(
        `data/photos/${participantId}/start/back.jpg`
      );

      const doneMsg = apiCalls
        .filter((c) => c.method === "sendMessage")
        .map((c) => (c.payload as any).text)
        .join("\n");
      expect(doneMsg).toContain("Онбординг завершён");
    } finally {
      close();
    }
  });
});
