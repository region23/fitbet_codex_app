import { count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { commitmentTemplates } from "./schema.js";

type CommitmentTemplateSeed = {
  name: string;
  description: string;
  category: "nutrition" | "exercise" | "lifestyle";
};

const defaultTemplates: CommitmentTemplateSeed[] = [
  {
    name: "Белок в каждый приём пищи",
    description: "Стараться добавлять источник белка в каждый приём пищи.",
    category: "nutrition"
  },
  {
    name: "Овощи 400 г",
    description: "Съедать минимум 400 г овощей/зелени в день.",
    category: "nutrition"
  },
  {
    name: "Без сладких напитков",
    description: "Не пить сладкие напитки (соки, газировка, энергетики).",
    category: "nutrition"
  },
  {
    name: "Тренировка 3× в неделю",
    description: "Сделать минимум 3 тренировки в неделю (зал/дом/улица).",
    category: "exercise"
  },
  {
    name: "Шаги 8k",
    description: "Проходить минимум 8000 шагов в день.",
    category: "exercise"
  },
  {
    name: "Растяжка 10 минут",
    description: "Делать растяжку/мобилити 10 минут в день.",
    category: "exercise"
  },
  {
    name: "Сон 7+ часов",
    description: "Стараться спать не меньше 7 часов.",
    category: "lifestyle"
  },
  {
    name: "Вода 2 л",
    description: "Пить около 2 литров воды в день.",
    category: "lifestyle"
  },
  {
    name: "Без алкоголя в будни",
    description: "Не употреблять алкоголь с понедельника по четверг.",
    category: "lifestyle"
  }
];

export function seedCommitmentTemplates(db: BetterSQLite3Database) {
  const row = db.select({ c: count() }).from(commitmentTemplates).get();
  if ((row?.c ?? 0) > 0) return;
  db.insert(commitmentTemplates).values(defaultTemplates).run();
}

