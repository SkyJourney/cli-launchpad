/// Format a SQLite `datetime('now')` UTC timestamp as a relative label.
export function formatRelative(
  value: string | null,
  language = "zh",
  emptyLabel = "—",
): string {
  if (!value) {
    return emptyLabel;
  }
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T") + "Z";
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) {
    return value;
  }
  return relativeFrom(then, language);
}

/// Format a Unix epoch milliseconds value as a relative Chinese label.
export function formatRelativeMs(
  ms: number | null,
  language = "zh",
  emptyLabel = "—",
): string {
  if (ms == null) {
    return emptyLabel;
  }
  return relativeFrom(ms, language);
}

/// Format a SQLite UTC timestamp in the current user's local timezone.
export function formatUtcDateTime(value: string, language = "zh"): string {
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  const locale = getIntlLocale(language);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function relativeFrom(then: number, language = "zh"): string {
  const locale = getIntlLocale(language);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 60) {
    return formatter.format(-diffSeconds, "second");
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return formatter.format(-diffMinutes, "minute");
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return formatter.format(-diffHours, "hour");
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return formatter.format(-diffDays, "day");
  }
  return new Date(then).toLocaleDateString(locale);
}

function getIntlLocale(language: string): string {
  if (language.startsWith("zh")) return "zh-CN";
  if (language.startsWith("pt")) return "pt-BR";
  return language || "en-US";
}
