const participantStatusRu: Record<string, string> = {
  onboarding: "Онбординг",
  pending_payment: "Ожидает оплату",
  payment_marked: "Оплата отмечена",
  active: "Активно",
  dropped: "Вышел",
  disqualified: "Дисквалифицирован",
  completed: "Завершено"
};

const challengeStatusRu: Record<string, string> = {
  draft: "Набор участников",
  pending_payments: "Сбор оплат",
  active: "Активен",
  completed: "Завершён",
  cancelled: "Отменён"
};

export function formatParticipantStatusRu(status: string | null | undefined): string {
  if (!status) return "—";
  return participantStatusRu[status] ?? status.replaceAll("_", " ");
}

export function formatChallengeStatusRu(status: string | null | undefined): string {
  if (!status) return "—";
  return challengeStatusRu[status] ?? status.replaceAll("_", " ");
}

