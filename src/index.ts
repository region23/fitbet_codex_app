import "dotenv/config";
import { getEnv } from "./config.js";

const env = getEnv();

if (!env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN не задан. Укажите BOT_TOKEN в окружении.");
}

console.log("FitBet: booting…");
