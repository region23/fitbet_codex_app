import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Bot } from "grammy";
import type Database from "better-sqlite3";
import { createAppDb } from "../db/client.js";
import { createFitbetBot } from "./createBot.js";
import type { AppEnv } from "../config.js";
import type { ApiClientOptions } from "grammy";
import type { BotContext } from "./context.js";

export type ApiCall = { method: string; payload: unknown };

export function createTestBot(opts?: {
  env?: Partial<AppEnv>;
  now?: () => number;
}): {
  bot: Bot<BotContext>;
  db: BetterSQLite3Database;
  sqlite: Database.Database;
  apiCalls: ApiCall[];
  close: () => void;
} {
  const apiCalls: ApiCall[] = [];
  const env: AppEnv = {
    BOT_TOKEN: "test",
    DATABASE_URL: ":memory:",
    NODE_ENV: "test",
    CHECKIN_PERIOD_DAYS: 14,
    CHECKIN_PERIOD_MINUTES: 0,
    CHALLENGE_DURATION_UNIT: "hours",
    ...opts?.env
  };

  const appDb = createAppDb(":memory:");
  const bot = createFitbetBot({
    token: "test",
    env,
    db: appDb.db,
    sqlite: appDb.sqlite,
    now: opts?.now,
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: "FitBet",
      username: "fitbet_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false
    },
    client: {
      fetch: createApiFetchStub(apiCalls)
    }
  });

  return {
    bot,
    db: appDb.db,
    sqlite: appDb.sqlite,
    apiCalls,
    close: appDb.close
  };
}

function createApiFetchStub(apiCalls: ApiCall[]): ApiClientOptions["fetch"] {
  return async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const payload = parseBody(init?.body);
    apiCalls.push({ method, payload });
    const json = fakeApiResponse(method, payload);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function parseBody(body: unknown): any {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  // multipart/form-data or streams (uploads) are irrelevant for unit tests
  return {};
}

function fakeApiResponse(method: string, payload: any) {
  if (method === "sendMessage") {
    return {
      ok: true,
      result: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: payload.chat_id,
          type:
            typeof payload.chat_id === "number" && payload.chat_id < 0 ? "group" : "private"
        },
        text: payload.text
      }
    };
  }
  if (method === "editMessageReplyMarkup") return { ok: true, result: true };
  if (method === "answerCallbackQuery") return { ok: true, result: true };
  return { ok: true, result: true };
}
