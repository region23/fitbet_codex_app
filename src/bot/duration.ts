export type ChallengeDurationUnit = "hours" | "days" | "months";

export function formatChallengeDuration(value: number, unit: ChallengeDurationUnit): string {
  return `${value} ${formatRussianDurationUnit(value, unit)}`;
}

export function formatChallengeDurationUnit(unit: ChallengeDurationUnit): string {
  // Genitive plural — works for prompts like "Выберите длительность (…)".
  switch (unit) {
    case "hours":
      return "часов";
    case "days":
      return "дней";
    case "months":
      return "месяцев";
  }
}

function formatRussianDurationUnit(value: number, unit: ChallengeDurationUnit): string {
  const abs = Math.abs(value);
  const n100 = abs % 100;
  const n10 = abs % 10;

  const forms = (() => {
    switch (unit) {
      case "hours":
        return ["час", "часа", "часов"] as const;
      case "days":
        return ["день", "дня", "дней"] as const;
      case "months":
        return ["месяц", "месяца", "месяцев"] as const;
    }
  })();

  if (n100 >= 11 && n100 <= 14) return forms[2];
  if (n10 === 1) return forms[0];
  if (n10 >= 2 && n10 <= 4) return forms[1];
  return forms[2];
}

