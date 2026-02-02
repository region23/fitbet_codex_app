import "dotenv/config";
import { getEnv } from "./config.js";
import { createAppDb } from "./db/client.js";
import { createFitbetBot } from "./bot/createBot.js";

const env = getEnv();

if (!env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN не задан. Укажите BOT_TOKEN в окружении.");
}

const appDb = createAppDb(env.DATABASE_URL);
const bot = createFitbetBot({
  token: env.BOT_TOKEN,
  env,
  db: appDb.db,
  sqlite: appDb.sqlite
});

console.log("FitBet: bot starting…");
await bot.start();
