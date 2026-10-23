#!/usr/bin/env bash
set -euo pipefail

baseline_file="scripts/ci/rust-test-antipattern-baseline.txt"

actual=$(git ls-files -z -- 'src-tauri/src/*.rs' \
  | xargs -0 awk '
      FNR == 1 { in_tests = 0 }
      /^[ \t]*(pub(\([a-z]+\))?[ \t]+)?mod [a-z_]*tests?[ \t]*[{]/ { in_tests = 1 }
      in_tests && /if let Ok\(/ {
        line = $0
        sub(/^[ \t]+/, "", line)
        print FILENAME "\t" line
      }
    ' \
  | LC_ALL=C sort)
expected=$(grep -v -e '^#' -e '^[[:space:]]*$' "$baseline_file" | LC_ALL=C sort || true)

new_hits=$(LC_ALL=C comm -13 <(printf '%s\n' "$expected" | sed '/^$/d') <(printf '%s\n' "$actual" | sed '/^$/d') || true)
stale=$(LC_ALL=C comm -23 <(printf '%s\n' "$expected" | sed '/^$/d') <(printf '%s\n' "$actual" | sed '/^$/d') || true)

status=0
if [ -n "$new_hits" ]; then
  echo "新增的测试反模式（测试中禁止用 if let Ok 静默通过，请改成 unwrap、expect 或 assert）：" >&2
  printf '%s\n' "$new_hits" >&2
  status=1
fi
if [ -n "$stale" ]; then
  echo "基线中的条目已不再命中，请从 $baseline_file 删除：" >&2
  printf '%s\n' "$stale" >&2
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "anti-pattern check passed: hits=$(printf '%s\n' "$actual" | sed '/^$/d' | wc -l | tr -d ' ') all recorded in baseline"
fi
exit "$status"
