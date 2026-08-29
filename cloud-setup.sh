#!/bin/bash
# cloud environment の Setup script に貼るもの。**1 つの環境に 1 回貼れば全プロジェクトで効く**。
#
# ## 要らないなら貼らない
#
# **1 プロジェクト = 1 リポジトリ (モノレポ) で回すなら、これは要らない。** 作業ディレクトリが
# リポジトリ直下のままになり、commit した `.mcp.json` と `.claude/settings.json` がそのまま
# 効くため。貼ったままでも cwd が違うので使われないが、`/home/user/.claude/settings.json` は
# ユーザースコープの設定としても読まれうるので、**同じフックが 2 回走る**可能性がある
# (実害は «同じ値を 2 回書く» だけだが、無駄なので外しておくのがよい)。
#
# 貼るのは **1 つの routine に 2 本以上のリポジトリを入れたときだけ**。
#
# ## なぜ要るか
#
# routine に **リポジトリを 2 本以上**入れると、作業ディレクトリがリポジトリの外
# (`/home/user`) へ上がる。実測:
#
#   1 本 … cwd = /home/user/knm_kanata   → リポジトリの .mcp.json が読まれる
#   2 本 … cwd = /home/user              → 読まれない (mcp__kanata__* が消える)
#
# プロジェクトスコープの `.mcp.json` と `.claude/settings.json` は **作業ディレクトリ**から
# 読まれるので、リポジトリに commit してあっても届かない。clone はされているのに、である。
# その結果 ask_human も report も使えず、kanata が成立しなくなる。
#
# ここで作業ディレクトリ側に置き直す。**中身はどのプロジェクトでも同じ**なので、環境に 1 回
# 貼れば済む (MCP の宛先は環境変数で解決し、フックの本体はリポジトリのものを使う)。
#
# リポジトリが 1 本の routine では cwd がリポジトリ直下になるので、ここで置いたファイルは
# 使われない。置いてあっても害はない。
#
# ## 注意
#
# Setup script は **clone の後・Claude Code の起動の前**に走り、結果はスナップショットに残る
# (次回以降は走らない)。だから中身は «どのリポジトリが来ても正しい» ものに限る。
set -u

mkdir -p /home/user/.claude || true

# MCP の宛先は環境変数で解決するので、プロジェクトによらず同じ内容でよい。
# `${...}` を展開させないため、ヒアドキュメントの区切りを引用符で囲む。
cat > /home/user/.mcp.json <<'JSON'
{
  "mcpServers": {
    "kanata": {
      "type": "http",
      "url": "${KANATA_URL}/mcp",
      "headers": { "Authorization": "Bearer ${KANATA_TOKEN}" },
      "timeout": 3600000
    }
  }
}
JSON

# フックの本体は **リポジトリに commit したものをそのまま使う** (二重管理にしない)。
# clone された中から kanata-hook.sh を 1 つ見つけて渡すだけ。
cat > /home/user/.claude/settings.json <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__kanata__ask_human|mcp__kanata__report",
        "hooks": [
          {
            "type": "command",
            "timeout": 15,
            "command": "for h in /home/user/*/.claude/hooks/kanata-hook.sh; do [ -f \"$h\" ] && exec bash \"$h\"; done"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 15,
            "command": "for h in /home/user/*/.claude/hooks/kanata-hook.sh; do [ -f \"$h\" ] && exec bash \"$h\"; done"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 30,
            "command": "for h in /home/user/*/.claude/hooks/kanata-hook.sh; do [ -f \"$h\" ] && exec bash \"$h\"; done"
          }
        ]
      }
    ]
  }
}
JSON

exit 0
