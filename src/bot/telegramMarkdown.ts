export function escapeTelegramMarkdown(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("_", "\\_")
    .replaceAll("*", "\\*")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`");
}

