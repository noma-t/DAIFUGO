#!/bin/bash
# Linux / macOS 用
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"
  (xdg-open "https://nodejs.org/" || open "https://nodejs.org/") >/dev/null 2>&1
  read -n 1 -s -r -p "何かキーを押すと終了します"
  exit 1
fi
node server/server.js
