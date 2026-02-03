import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import cron from "node-cron";
import type { AppEnv } from "../config.js";
import {
  closeCheckinWindows,
  finalizeOverdueBankHolderElections,
  finalizeEndedChallenges,
  handleOnboardingTimeouts,
  openCheckinWindows,
  sendCheckinReminders,
  sendHabitReminders
} from "./tasks.js";
import { captureException } from "../monitoring/sentry.js";

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
      await handleOnboardingTimeouts({ db: deps.db, api: deps.api, now });
      await finalizeOverdueBankHolderElections({ db: deps.db, api: deps.api, now });
      await openCheckinWindows({ db: deps.db, api: deps.api, now });
      await sendCheckinReminders({ db: deps.db, api: deps.api, now });
      await sendHabitReminders({ db: deps.db, api: deps.api, now });
      await closeCheckinWindows({ db: deps.db, api: deps.api, now });
      await finalizeEndedChallenges({ db: deps.db, api: deps.api, now });
    } catch (e) {
      console.error("[scheduler] error", e);
      captureException(e, { area: "scheduler" });
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
