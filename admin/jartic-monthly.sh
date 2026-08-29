#!/bin/sh
#
# JARTIC の交通規制情報を、月に一度取り込む。
#
# ⚠️ **前月ぶんは取得できなくなる**（JARTIC のページに明記）。
#    取り逃すとその月は永久に取れず、規制が解除されたことを検知できなくなる。
#    ⚠️ **公開は月初**（実測: 2026年06月分が08月01日公開）。おおよそ2か月遅れ。
#
# ⚠️ **Mac が起きていないと走らない。** launchd の `StartCalendarInterval` は
#    寝ている時刻を過ぎると**次に起きたときに1回だけ**走る（溜めては走らない）。
#    月初に何日も電源が入らないときは、手で走らせること。
#
# 使い方（手で）:  ./jartic-monthly.sh
# 自動で:         launchd に載せる（README を読むこと）
set -eu

cd "$(dirname "$0")"
LOG_DIR="data/restriction-jartic/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"

# ⚠️ node の場所は launchd から見えない。PATH を明示する
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') 開始 ====="
  node fetchJarticRestrictions.js --all
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') 終了 ====="
} >> "$LOG" 2>&1

# 直近の増減だけ、終わりに読めるところへ出す
tail -30 "$LOG"
