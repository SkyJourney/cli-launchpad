/// Format a SQLite `datetime('now')` UTC timestamp as a relative Chinese label.
export function formatRelative(value: string | null): string {
  if (!value) {
    return "未曾启动";
  }
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T") + "Z";
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) {
    return value;
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 60) {
    return "刚刚";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}分钟前`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}小时前`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}天前`;
  }
  return new Date(normalized).toLocaleDateString("zh-CN");
}
