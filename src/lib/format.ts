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
  return relativeFrom(then);
}

/// Format a Unix epoch milliseconds value as a relative Chinese label.
export function formatRelativeMs(ms: number | null): string {
  if (ms == null) {
    return "未知时间";
  }
  return relativeFrom(ms);
}

/// Format a SQLite UTC timestamp in the current user's local timezone.
export function formatUtcDateTime(value: string): string {
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

/// Extract a semver-like `x.y.z` from a noisy version string (e.g.
/// "2.1.150 (Claude Code)" or "codex-cli 0.133.0").
export function extractSemver(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

/// Compare two `x.y.z` strings numerically. Returns >0 if a is newer than b.
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/// Decide whether an update is available given the current and latest strings.
/// Returns null when it cannot be determined (missing data). Only reports true
/// when latest is strictly newer, so a local pre-release is not "downgraded".
export function hasUpdate(
  current: string | null,
  latest: string | null,
): boolean | null {
  const latestSemver = extractSemver(latest);
  const currentSemver = extractSemver(current);
  if (!latestSemver || !currentSemver) {
    return null;
  }
  return compareSemver(latestSemver, currentSemver) > 0;
}

function relativeFrom(then: number): string {
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
  return new Date(then).toLocaleDateString("zh-CN");
}
