#!/usr/bin/env bash
# 実装計画を kanata へ置いて、依頼者が読む URL を 1 行だけ返す。
#
#   .claude/scripts/publish-plan.sh KANATA-0123456789abcdef plans/github-link
#   → https://kanata.example.workers.dev/p/<32hex>/
#
# ## なぜツールではなくシェルなのか
#
# 計画は 1 件 200KB を超える (実測 231,647 バイト / 7 ファイル)。**MCP ツールの引数に
# 載せると、その全部を Claude が再出力することになる。** ここが curl なら、本文は
# モデルの出力を 1 バイトも通らず、Claude が読むのは最後の URL の 1 行だけで済む。
#
# ## hook と違って、失敗したら黙って終わらない
#
# `kanata-hook.sh` は «保険» なので何があっても exit 0 する。こちらは逆で、握りつぶすと
# **Claude が死んだリンクを Discord に貼る**。失敗は必ず非 0 で落とす。
#
# ## 計画はリポジトリに入れない
#
# `plans/` は対象リポジトリの `.gitignore` に入れておくこと。使い捨ての計画が commit に
# 混ざると、実装とズレた文書が正史として残り続ける。
set -euo pipefail

die() {
  printf 'publish-plan: %s\n' "$1" >&2
  exit 1
}

session_key="${1:-}"
target="${2:-}"
if [ -z "$session_key" ] || [ -z "$target" ]; then
  die "使い方: publish-plan.sh <session_key> <計画のディレクトリ|ファイル>"
fi

[ -n "${KANATA_URL:-}" ] || die "KANATA_URL が環境変数にありません (cloud environment の設定)"
[ -n "${KANATA_TOKEN:-}" ] || die "KANATA_TOKEN が環境変数にありません (cloud environment の設定)"
command -v curl >/dev/null 2>&1 || die "curl がありません"
command -v jq >/dev/null 2>&1 || die "jq がありません"

base="${KANATA_URL%/}"

# ディレクトリなら丸ごと、ファイル 1 つなら «その 1 枚だけの計画» として扱う。
single=""
if [ -d "$target" ]; then
  root="${target%/}"
  name="$(basename "$root")"
elif [ -f "$target" ]; then
  root="$(dirname "$target")"
  single="$(basename "$target")"
  name="${single%.*}"
else
  die "見つかりません: $target"
fi

# 計画の名前。**同じスレッドの同じ名前は同じ URL に上書きされる** (直して出し直しても
# スレッドに貼ったリンクが古い方を指さない) ので、名前は安定させること。
slug="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-*//; s/-*$//')"
[ -n "$slug" ] || die "計画の名前を英数字にできません: $name"

files=()
if [ -n "$single" ]; then
  files=("$single")
else
  # ドットで始まるものと node_modules は送らない (置き場の規則でも弾かれる)。
  while IFS= read -r -d '' path; do
    files+=("${path#"$root"/}")
  done < <(find "$root" -type f -not -path '*/.*' -not -path '*/node_modules/*' -print0 | sort -z)
fi
[ "${#files[@]}" -gt 0 ] || die "送るファイルがありません: $target"

for rel in "${files[@]}"; do
  size="$(wc -c <"$root/$rel" | tr -d ' ')"
  [ "$size" -le 5242880 ] || die "大きすぎます (5MiB 超): $rel"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$base/plans/$slug/$rel" \
    -H "authorization: Bearer ${KANATA_TOKEN}" \
    -H "x-kanata-session: ${session_key}" \
    --data-binary "@$root/$rel")"
  [ "$status" = "200" ] || die "置けませんでした ($status): $rel"
done

# 置き終わり。**今回送らなかったファイルはここで消える** (名前を変えた古い計画が並びに
# 残らないように)。返ってくるのが依頼者に見せる URL。
payload="$(printf '%s\n' "${files[@]}" | jq -R . | jq -sc '{paths: .}')"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
status="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$base/plans/$slug/finish" \
  -H "authorization: Bearer ${KANATA_TOKEN}" \
  -H "x-kanata-session: ${session_key}" \
  -H 'content-type: application/json' \
  --data "$payload")"
[ "$status" = "200" ] || die "仕上げに失敗しました ($status)"

url="$(jq -r '.url // empty' <"$body")"
[ -n "$url" ] || die "URL が返りませんでした"
printf '%s\n' "$url"
