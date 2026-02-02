import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";
import { challenges, commitmentTemplates } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("/clear_db", () => {
  it("clears all tables for admin after confirmation", async () => {
    const { bot, db, close } = createTestBot({
      env: { ADMIN_TELEGRAM_ID: 123 }
    });
    try {
      db.insert(challenges)
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
        .run();

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 123, type: "private", first_name: "Admin" },
          from: { id: 123, is_bot: false, first_name: "Admin" },
          text: "/clear_db",
          entities: [{ offset: 0, length: 9, type: "bot_command" }]
        }
      });

      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb_yes",
          from: { id: 123, is_bot: false, first_name: "Admin" },
          chat_instance: "ci",
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 123, type: "private", first_name: "Admin" },
            text: "confirm"
          },
          data: "clear_db_yes"
        }
      });

      const anyChallenge = db.select().from(challenges).where(eq(challenges.chatId, -100)).get();
      expect(anyChallenge).toBeUndefined();

      const templates = db.select().from(commitmentTemplates).all();
      expect(templates.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});

