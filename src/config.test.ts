import { describe, expect, it } from "vitest";
import { getEnv } from "./config.js";

describe("config", () => {
  it("parses defaults", () => {
    const env = getEnv({
      NODE_ENV: "test",
      BOT_TOKEN: "x",
      ADMIN_TELEGRAM_ID: "123"
    });
    expect(env.DATABASE_URL).toBe("file:./data/fitbet.db");
    expect(env.CHECKIN_PERIOD_DAYS).toBe(14);
    expect(env.CHECKIN_PERIOD_MINUTES).toBe(0);
    expect(env.ADMIN_TELEGRAM_ID).toBe(123);
  });
});

