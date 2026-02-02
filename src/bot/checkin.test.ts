import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { challenges, checkinWindows, checkins, participants } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

describe("check-in", () => {
  it("sets pending window from group button and submits in private", async () => {
    const { bot, db, savedPhotos, close } = createTestBot({
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
          status: "active",
          createdAt: 1_700_000_000_000,
          startedAt: 1_700_000_000_000,
          endsAt: 1_700_000_000_000 + 6 * 60 * 60 * 1000
        })
        .returning({ id: challenges.id })
        .get().id;

      const windowId = db
        .insert(checkinWindows)
        .values({
          challengeId,
          windowNumber: 1,
          opensAt: 1_699_999_000_000,
          closesAt: 1_700_100_000_000,
          status: "open"
        })
        .returning({ id: checkinWindows.id })
        .get().id;

      const participantId = db
        .insert(participants)
        .values({
          challengeId,
          userId: 10,
          username: "u1",
          firstName: "U1",
          status: "active",
          joinedAt: 1_700_000_000_000
        })
        .returning({ id: participants.id })
        .get().id;

      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb_checkin",
          from: { id: 10, is_bot: false, first_name: "U1" },
          chat_instance: "ci_group",
          message: {
            message_id: 1,
            date: 1,
            chat: { id: -100, type: "group", title: "Test Chat" },
            text: "checkin"
          },
          data: `checkin_${windowId}`
        }
      });

      const pending = db
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get()!;
      expect(pending.pendingCheckinWindowId).toBe(windowId);

      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U1" },
          from: { id: 10, is_bot: false, first_name: "U1" },
          text: "/start",
          entities: [{ offset: 0, length: 6, type: "bot_command" }]
        }
      });

      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U1" },
          from: { id: 10, is_bot: false, first_name: "U1" },
          text: "80"
        }
      });
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U1" },
          from: { id: 10, is_bot: false, first_name: "U1" },
          text: "90"
        }
      });

      const sendPhotoUpdate = (updateId: number, fileId: string) =>
        bot.handleUpdate({
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1,
            chat: { id: 10, type: "private", first_name: "U1" },
            from: { id: 10, is_bot: false, first_name: "U1" },
            photo: [
              { file_id: `${fileId}_s`, file_unique_id: `${fileId}_us`, width: 10, height: 10 },
              { file_id: fileId, file_unique_id: `${fileId}_u`, width: 100, height: 100 }
            ]
          }
        });

      await sendPhotoUpdate(5, "cfront");
      await sendPhotoUpdate(6, "cleft");
      await sendPhotoUpdate(7, "cright");
      await sendPhotoUpdate(8, "cback");

      const checkin = db
        .select()
        .from(checkins)
        .where(and(eq(checkins.participantId, participantId), eq(checkins.windowId, windowId)))
        .get();
      expect(checkin).toBeTruthy();
      expect(checkin?.weight).toBe(80);

      const after = db.select().from(participants).where(eq(participants.id, participantId)).get()!;
      expect(after.totalCheckins).toBe(1);
      expect(after.completedCheckins).toBe(1);
      expect(after.pendingCheckinWindowId).toBeNull();

      expect(savedPhotos.map((s) => s.destinationPath)).toContain(
        `data/photos/${participantId}/checkin-1/front.jpg`
      );
    } finally {
      close();
    }
  });
});

