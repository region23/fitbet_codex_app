import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN обязателен").optional(),
  DATABASE_URL: z.string().min(1).default("file:./data/fitbet.db"),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  SENTRY_DSN: z.string().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_TELEGRAM_ID: z
    .string()
    .transform((v) => (v ? Number(v) : undefined))
    .pipe(z.number().int().positive().optional()),
  CHALLENGE_DURATION_UNIT: z.enum(["months", "days", "hours"]).default("months"),
  CHECKIN_PERIOD_DAYS: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().int().positive())
    .default("14"),
  CHECKIN_PERIOD_MINUTES: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().int().nonnegative())
    .default("0")
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(overrides?: Record<string, string | undefined>): AppEnv {
  const input: Record<string, string | undefined> = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    SENTRY_DSN: process.env.SENTRY_DSN,
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_TELEGRAM_ID: process.env.ADMIN_TELEGRAM_ID,
    CHALLENGE_DURATION_UNIT: process.env.CHALLENGE_DURATION_UNIT,
    CHECKIN_PERIOD_DAYS: process.env.CHECKIN_PERIOD_DAYS,
    CHECKIN_PERIOD_MINUTES: process.env.CHECKIN_PERIOD_MINUTES,
    ...overrides
  };
  return envSchema.parse(input);
}
