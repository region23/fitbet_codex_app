import { describe, expect, it } from "vitest";
import { createTestBot } from "./testkit.js";

describe("bot basic commands", () => {
  it("responds to /help in private", async () => {
    const { bot, apiCalls, close } = createTestBot();
    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 10, type: "private", first_name: "U" },
          from: { id: 10, is_bot: false, first_name: "U" },
          text: "/help",
          entities: [{ offset: 0, length: 5, type: "bot_command" }]
        }
      });
      expect(apiCalls.some((c) => c.method === "sendMessage")).toBe(true);
      const call = apiCalls.find((c) => c.method === "sendMessage")!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((call.payload as any).text).toContain("FitBet");
    } finally {
      close();
    }
  });

  it("runs /create conversation in group", async () => {
    const { bot, apiCalls, close } = createTestBot({ now: () => 1_700_000_000_000 });
    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -100, type: "group", title: "Test Chat" },
          from: { id: 1, is_bot: false, first_name: "Creator" },
          text: "/create",
          entities: [{ offset: 0, length: 7, type: "bot_command" }]
        }
      });
      expect(apiCalls.at(-1)?.method).toBe("sendMessage");

      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb1",
          from: { id: 1, is_bot: false, first_name: "Creator" },
          chat_instance: "ci1",
          message: {
            message_id: 2,
            date: 1,
            chat: { id: -100, type: "group", title: "Test Chat" },
            text: "dummy"
          },
          data: "create_duration_6"
        }
      });
      expect(apiCalls.some((c) => c.method === "answerCallbackQuery")).toBe(true);

      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 1,
          chat: { id: -100, type: "group", title: "Test Chat" },
          from: { id: 1, is_bot: false, first_name: "Creator" },
          text: "1000"
        }
      });

      await bot.handleUpdate({
        update_id: 4,
        callback_query: {
          id: "cb2",
          from: { id: 1, is_bot: false, first_name: "Creator" },
          chat_instance: "ci2",
          message: {
            message_id: 4,
            date: 1,
            chat: { id: -100, type: "group", title: "Test Chat" },
            text: "dummy"
          },
          data: "create_threshold_80"
        }
      });

      await bot.handleUpdate({
        update_id: 5,
        callback_query: {
          id: "cb3",
          from: { id: 1, is_bot: false, first_name: "Creator" },
          chat_instance: "ci3",
          message: {
            message_id: 5,
            date: 1,
            chat: { id: -100, type: "group", title: "Test Chat" },
            text: "dummy"
          },
          data: "create_max_skips_2"
        }
      });

      const sent = apiCalls.filter((c) => c.method === "sendMessage");
      expect(sent.map((c) => (c.payload as any).text).join("\n")).toContain("Челлендж создан");
    } finally {
      close();
    }
  });
});
