import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import cron from "node-cron";
import type { AppEnv } from "../config.js";
import { closeCheckinWindows, openCheckinWindows, sendCheckinReminders } from "./tasks.js";

type Deps = {
  env: AppEnv;
  db: BetterSQLite3Database;
  api: Api;
  now?: () => number;
};

export function startScheduler(deps: Deps) {
  const now = deps.now ?? (() => Date.now());
  const tick = async () => {
    try {
      await openCheckinWindows({ db: deps.db, api: deps.api, now });
      await sendCheckinReminders({ db: deps.db, api: deps.api, now });
      await closeCheckinWindows({ db: deps.db, api: deps.api, now });
    } catch (e) {
      console.error("[scheduler] error", e);
    }
  };

  const scheduleEveryMinute =
    deps.env.CHECKIN_PERIOD_MINUTES > 0 && deps.env.CHECKIN_PERIOD_MINUTES < 60;
  const expression = scheduleEveryMinute ? "* * * * *" : "0 * * * *";

  const task = cron.schedule(expression, () => void tick(), {
    timezone: "Europe/Moscow"
  });

  setTimeout(() => void tick(), 5000);

  return {
    stop: () => task.stop()
  };
}

