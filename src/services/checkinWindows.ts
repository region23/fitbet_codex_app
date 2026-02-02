import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { checkinWindows } from "../db/schema.js";
import { eq } from "drizzle-orm";

export function generateCheckinWindowsForChallenge(opts: {
  db: BetterSQLite3Database;
  challengeId: number;
  startedAt: number;
  endsAt: number;
  checkinPeriodMs: number;
  checkinWindowMs: number;
}) {
  const { db, challengeId, startedAt, endsAt, checkinPeriodMs, checkinWindowMs } = opts;

  db.delete(checkinWindows).where(eq(checkinWindows.challengeId, challengeId)).run();

  let windowNumber = 1;
  let opensAt = startedAt + checkinPeriodMs;
  const rows: Array<{
    challengeId: number;
    windowNumber: number;
    opensAt: number;
    closesAt: number;
    status: string;
  }> = [];

  while (opensAt < endsAt) {
    rows.push({
      challengeId,
      windowNumber,
      opensAt,
      closesAt: opensAt + checkinWindowMs,
      status: "scheduled"
    });
    windowNumber += 1;
    opensAt += checkinPeriodMs;
  }

  if (rows.length > 0) db.insert(checkinWindows).values(rows).run();
  return rows.length;
}

