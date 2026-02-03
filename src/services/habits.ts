import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, gte, lte } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import {
  challenges,
  commitmentTemplates,
  habitLogs,
  participantCommitments,
  participants
} from "../db/schema.js";
import { escapeTelegramMarkdown } from "../bot/telegramMarkdown.js";

export const habitsTimeZone = "Europe/Moscow";
export const habitReminderHour = 21;

type HabitTemplate = {
  id: number;
  name: string;
  cadence: "daily" | "weekly";
  targetPerWeek: number | null;
};

type HabitsMessage = {
  text: string;
  keyboard?: InlineKeyboard;
  dateKey: string;
};

export function getDateKey(ts: number, timeZone = habitsTimeZone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ts));
}

export function getLocalHour(ts: number, timeZone = habitsTimeZone): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false
  }).format(new Date(ts));
  return Number(hour);
}

export function getWeekStartKey(dateKey: string): string {
  const date = dateKeyToUtcDate(dateKey);
  const day = date.getUTCDay(); // 0 Sunday .. 6 Saturday
  const diff = (day + 6) % 7; // days since Monday
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const date = dateKeyToUtcDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(startKey: string, endKey: string): number {
  const start = dateKeyToUtcDate(startKey).getTime();
  const end = dateKeyToUtcDate(endKey).getTime();
  if (end < start) return 0;
  const diff = Math.floor((end - start) / 86_400_000);
  return diff + 1;
}

export function weeksBetween(startKey: string, endKey: string): number {
  const startWeek = getWeekStartKey(startKey);
  const endWeek = getWeekStartKey(endKey);
  const start = dateKeyToUtcDate(startWeek).getTime();
  const end = dateKeyToUtcDate(endWeek).getTime();
  if (end < start) return 0;
  const diffWeeks = Math.floor((end - start) / (7 * 86_400_000));
  return diffWeeks + 1;
}

export function buildHabitsMessage(opts: {
  db: BetterSQLite3Database;
  participantId: number;
  now: number;
}): HabitsMessage {
  const { db, participantId, now } = opts;
  const dateKey = getDateKey(now);
  const dateLabel = new Date(now).toLocaleDateString("ru-RU", {
    timeZone: habitsTimeZone,
    day: "2-digit",
    month: "2-digit"
  });

  const participant = db
    .select({
      id: participants.id,
      status: participants.status,
      startedAt: challenges.startedAt
    })
    .from(participants)
    .leftJoin(challenges, eq(participants.challengeId, challenges.id))
    .where(eq(participants.id, participantId))
    .get();

  if (!participant) {
    return { text: "Участник не найден.", dateKey };
  }

  const templates = db
    .select({
      id: commitmentTemplates.id,
      name: commitmentTemplates.name,
      cadence: commitmentTemplates.cadence,
      targetPerWeek: commitmentTemplates.targetPerWeek
    })
    .from(participantCommitments)
    .innerJoin(
      commitmentTemplates,
      eq(participantCommitments.templateId, commitmentTemplates.id)
    )
    .where(eq(participantCommitments.participantId, participantId))
    .orderBy(commitmentTemplates.id)
    .all() as HabitTemplate[];

  if (templates.length === 0) {
    return {
      text: "У вас нет выбранных привычек. Вернитесь в группу и пройдите онбординг заново.",
      dateKey
    };
  }

  const todayLogs = db
    .select({ templateId: habitLogs.templateId, status: habitLogs.status })
    .from(habitLogs)
    .where(and(eq(habitLogs.participantId, participantId), eq(habitLogs.dateKey, dateKey)))
    .all();
  const todayStatus = new Map<number, string>(
    todayLogs.map((row) => [row.templateId, row.status])
  );

  const weekStartKey = getWeekStartKey(dateKey);
  const weekEndKey = addDaysToDateKey(weekStartKey, 6);
  const weekDone = db
    .select({ templateId: habitLogs.templateId })
    .from(habitLogs)
    .where(
      and(
        eq(habitLogs.participantId, participantId),
        eq(habitLogs.status, "done"),
        gte(habitLogs.dateKey, weekStartKey),
        lte(habitLogs.dateKey, weekEndKey)
      )
    )
    .all();
  const weekCounts = new Map<number, number>();
  for (const row of weekDone) {
    weekCounts.set(row.templateId, (weekCounts.get(row.templateId) ?? 0) + 1);
  }

  let totalDays = 0;
  let totalWeeks = 0;
  const doneDailyCounts = new Map<number, number>();
  const doneWeeklyCounts = new Map<number, Map<string, number>>();
  if (participant.startedAt) {
    const startKey = getDateKey(participant.startedAt);
    totalDays = daysBetween(startKey, dateKey);
    totalWeeks = weeksBetween(startKey, dateKey);

    const doneLogs = db
      .select({ templateId: habitLogs.templateId, dateKey: habitLogs.dateKey })
      .from(habitLogs)
      .where(
        and(
          eq(habitLogs.participantId, participantId),
          eq(habitLogs.status, "done"),
          gte(habitLogs.dateKey, startKey),
          lte(habitLogs.dateKey, dateKey)
        )
      )
      .all();

    const cadenceById = new Map<number, "daily" | "weekly">(
      templates.map((t) => [t.id, t.cadence])
    );

    for (const row of doneLogs) {
      const cadence = cadenceById.get(row.templateId) ?? "daily";
      if (cadence === "daily") {
        doneDailyCounts.set(row.templateId, (doneDailyCounts.get(row.templateId) ?? 0) + 1);
        continue;
      }
      const weekKey = getWeekStartKey(row.dateKey);
      let perWeek = doneWeeklyCounts.get(row.templateId);
      if (!perWeek) {
        perWeek = new Map<string, number>();
        doneWeeklyCounts.set(row.templateId, perWeek);
      }
      perWeek.set(weekKey, (perWeek.get(weekKey) ?? 0) + 1);
    }
  }

  const lines = templates.map((template, idx) => {
    const name = escapeTelegramMarkdown(template.name);
    const status = todayStatus.get(template.id);
    const todayLabel =
      status === "done" ? "✅ сегодня" : status === "skipped" ? "❌ сегодня" : "⏳ сегодня";

    if (template.cadence === "weekly") {
      const target = template.targetPerWeek ?? 1;
      const weekCount = weekCounts.get(template.id) ?? 0;
      let totalLine = "";
      if (totalWeeks > 0) {
        const perWeek = doneWeeklyCounts.get(template.id);
        const doneWeeks = perWeek
          ? Array.from(perWeek.values()).filter((count) => count >= target).length
          : 0;
        totalLine = `; всего недель ${doneWeeks}/${totalWeeks}`;
      }
      return `${idx + 1}) ${name} — ${todayLabel}; неделя ${weekCount}/${target}${totalLine}`;
    }

    const doneDays = doneDailyCounts.get(template.id) ?? 0;
    const totalLine = totalDays > 0 ? `; всего дней ${doneDays}/${totalDays}` : "";
    return `${idx + 1}) ${name} — ${todayLabel}${totalLine}`;
  });

  const kb = new InlineKeyboard();
  templates.forEach((template) => {
    const safeName = template.name.length > 32 ? `${template.name.slice(0, 29)}...` : template.name;
    kb.text(`✅ ${safeName}`, `habit_done_${participantId}_${template.id}_${dateKey}`).text(
      `❌ ${safeName}`,
      `habit_skip_${participantId}_${template.id}_${dateKey}`
    ).row();
  });

  const text = [
    `*Привычки на сегодня (${dateLabel})*`,
    "",
    "Отмечайте выполнение за сегодня. Для недельных привычек считаем количество выполнений за неделю.",
    "",
    ...lines
  ].join("\n");

  return { text, keyboard: kb, dateKey };
}

function dateKeyToUtcDate(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map((n) => Number(n));
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}
