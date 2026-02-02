import type { AppEnv } from "../config.js";

let sentry: typeof import("@sentry/node") | null = null;

export function initSentry(env: AppEnv) {
  if (!env.SENTRY_DSN) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore ESM/CJS interop handled by Node
  // We keep a dynamic import to avoid hard dependency at runtime if DSN is not set.
  return import("@sentry/node").then((mod) => {
    sentry = mod;
    sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV
    });
  });
}

export function captureException(err: unknown, extra?: Record<string, unknown>) {
  if (!sentry) return;
  try {
    sentry.captureException(err, extra ? { extra } : undefined);
  } catch {
    // ignore
  }
}

