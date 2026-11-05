#!/bin/bash
# macOS: ダブルクリックで起動
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"
  open "https://nodejs.org/" 2>/dev/null
  read -n 1 -s -r -p "何かキーを押すと終了します"
  exit 1
fi
node server/server.js
