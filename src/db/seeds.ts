import { count, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { commitmentTemplates } from "./schema.js";

type CommitmentTemplateSeed = {
  name: string;
  description: string;
  category: "nutrition" | "exercise" | "lifestyle";
  cadence: "daily" | "weekly";
  targetPerWeek?: number | null;
};

const defaultTemplates: CommitmentTemplateSeed[] = [
  {
    name: "Белок в каждый приём пищи",
    description: "Стараться добавлять источник белка в каждый приём пищи.",
    category: "nutrition",
    cadence: "daily"
  },
  {
    name: "Овощи 400 г",
    description: "Съедать минимум 400 г овощей/зелени в день.",
    category: "nutrition",
    cadence: "daily"
  },
  {
    name: "Без сладких напитков",
    description: "Не пить сладкие напитки (соки, газировка, энергетики).",
    category: "nutrition",
    cadence: "daily"
  },
  {
    name: "Тренировка 3× в неделю",
    description: "Сделать минимум 3 тренировки в неделю (зал/дом/улица).",
    category: "exercise",
    cadence: "weekly",
    targetPerWeek: 3
  },
  {
    name: "Шаги 8k",
    description: "Проходить минимум 8000 шагов в день.",
    category: "exercise",
    cadence: "daily"
  },
  {
    name: "Растяжка 10 минут",
    description: "Делать растяжку/мобилити 10 минут в день.",
    category: "exercise",
    cadence: "daily"
  },
  {
    name: "Сон 7+ часов",
    description: "Стараться спать не меньше 7 часов.",
    category: "lifestyle",
    cadence: "daily"
  },
  {
    name: "Вода 2 л",
    description: "Пить около 2 литров воды в день.",
    category: "lifestyle",
    cadence: "daily"
  },
  {
    name: "Без алкоголя в будни",
    description: "Не употреблять алкоголь с понедельника по четверг.",
    category: "lifestyle",
    cadence: "weekly",
    targetPerWeek: 4
  }
];

export function seedCommitmentTemplates(db: BetterSQLite3Database) {
  const row = db.select({ c: count() }).from(commitmentTemplates).get();
  if ((row?.c ?? 0) > 0) return;
  db.insert(commitmentTemplates).values(defaultTemplates).run();
}

export function normalizeCommitmentTemplates(db: BetterSQLite3Database) {
  db.update(commitmentTemplates)
    .set({ cadence: "daily" })
    .where(sql`${commitmentTemplates.cadence} IS NULL`)
    .run();

  db.update(commitmentTemplates)
    .set({ cadence: "weekly", targetPerWeek: 3 })
    .where(eq(commitmentTemplates.name, "Тренировка 3× в неделю"))
    .run();
  db.update(commitmentTemplates)
    .set({ cadence: "weekly", targetPerWeek: 4 })
    .where(eq(commitmentTemplates.name, "Без алкоголя в будни"))
    .run();
}
