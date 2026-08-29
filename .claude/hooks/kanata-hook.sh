#!/usr/bin/env bash
# kanata へ通報する hook。1 本で 3 つのイベントを捌く (`hook_event_name` で振り分ける)。
#
#   PreToolUse (kanata のツールを呼ぶ直前) → コンテキスト使用量。**表示する直前の値**が要る
#   Stop       (ターンの終わり)            → コンテキスト使用量。質問を出さずに長く働くとき用
#   SessionEnd (セッションの終了)          → 完了通知の保険
#
# **Stop を «終了» とみなしてはいけない。** Stop は「Claude が応答を終えたとき」= 1 ターンごとに
# 鳴る。終了は SessionEnd。ここを間違えると会話の途中で «終了しました» が出る (実際に出た)。
#
# コンテキスト量は **転写ログからしか取れない**。どの hook の入力にもトークン数は入っておらず、
# ステータスラインは対話 UI 専用でクラウドセッションでは動かない。
#
# **何があっても exit 0** する。hook が失敗すると Claude 側に赤が出て、本題と無関係なノイズになる。
# どの実行かは指示文の 1 行目に置かれた KANATA-<16hex> を転写ログから拾って知る。
# 印の形は kanata の src/domain/ids.ts と対。片方だけ変えると黙って外れる。
set -uo pipefail

payload="$(cat || true)"

[ -n "${KANATA_URL:-}" ] || exit 0
[ -n "${KANATA_TOKEN:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

event="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
transcript="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0

key="$(grep -o 'KANATA-[0-9a-f]\{16\}' "$transcript" | head -1 || true)"
[ -n "$key" ] || exit 0

# 転写ログを後ろから読む。`tac` は GNU coreutils なので macOS には無い (手元で試すとき用の保険)。
# 後ろから読んで head -1 で止めるので、巨大な転写ログでも先頭まで舐めない。
rev_lines() {
  if command -v tac >/dev/null 2>&1; then tac "$1"; else tail -r "$1"; fi
}

post() {
  curl -sS -m 20 -X POST "${KANATA_URL%/}/hooks/$1" \
    -H "authorization: Bearer ${KANATA_TOKEN}" \
    -H "content-type: application/json" \
    --data "$2" >/dev/null 2>&1 || true
}

if [ "$event" = "SessionEnd" ]; then
  # 最後の assistant のテキストを要約代わりに添える。取れなくても構わない。
  summary="$(rev_lines "$transcript" 2>/dev/null \
    | jq -Rr 'fromjson? | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' 2>/dev/null \
    | head -20 || true)"
  [ -n "$summary" ] || summary="SessionEnd hook から通報しました。"
  post "session-end" "$(jq -nc --arg k "$key" --arg s "$summary" '{session_key:$k, summary:$s}')"
  exit 0
fi

# 直近の assistant の usage。`fromjson?` で壊れた行を黙って飛ばす (転写ログは追記中のことがある)。
usage="$(rev_lines "$transcript" 2>/dev/null \
  | jq -Rc 'fromjson? | select(.type=="assistant") | .message.usage // empty' 2>/dev/null \
  | head -1 || true)"
[ -n "$usage" ] || exit 0

post "context" "$(jq -nc --arg k "$key" --argjson u "$usage" \
  '{session_key:$k,
    input_tokens: ($u.input_tokens // 0),
    cache_creation_input_tokens: ($u.cache_creation_input_tokens // 0),
    cache_read_input_tokens: ($u.cache_read_input_tokens // 0),
    output_tokens: ($u.output_tokens // 0)}' 2>/dev/null || true)"

exit 0
