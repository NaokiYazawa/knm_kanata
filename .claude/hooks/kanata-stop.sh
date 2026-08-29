#!/usr/bin/env bash
# セッションが終わったことを kanata へ通報する保険。
#
# 主経路は Claude が report(kind:"done") を呼ぶこと。これは «呼び忘れ» と «途中で力尽きた» を
# 拾うためだけに在る。だから **何があっても exit 0** する (hook が失敗すると Claude 側に赤が出て、
# 本題と無関係なノイズになる)。
#
# どの実行かは指示文の 1 行目に置かれた KANATA-<16hex> を転写ログから拾って知る。
# 印の形は kanata の src/domain/ids.ts と対。片方だけ変えると黙って外れる。
set -uo pipefail

payload="$(cat || true)"

transcript=""
if command -v jq >/dev/null 2>&1; then
  transcript="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
else
  transcript="$(printf '%s' "$payload" \
    | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi

key=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  key="$(grep -o 'KANATA-[0-9a-f]\{16\}' "$transcript" | head -1 || true)"
fi

[ -n "$key" ] || exit 0
[ -n "${KANATA_URL:-}" ] || exit 0
[ -n "${KANATA_TOKEN:-}" ] || exit 0

summary="Stop hook から通報しました。"
if command -v jq >/dev/null 2>&1 && [ -f "$transcript" ]; then
  # 最後の assistant のテキストを要約代わりに添える。取れなくても構わない。
  last="$(tac "$transcript" 2>/dev/null \
    | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' 2>/dev/null \
    | head -20 || true)"
  [ -n "$last" ] && summary="$last"
fi

body="$(jq -nc --arg k "$key" --arg s "$summary" '{session_key:$k, summary:$s}' 2>/dev/null \
  || printf '{"session_key":"%s"}' "$key")"

curl -sS -m 20 -X POST "${KANATA_URL%/}/hooks/stop" \
  -H "authorization: Bearer ${KANATA_TOKEN}" \
  -H "content-type: application/json" \
  --data "$body" >/dev/null 2>&1 || true

exit 0
