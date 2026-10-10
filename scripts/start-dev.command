#!/bin/zsh
# 共作开发版启动：独立数据目录，避免与已安装的 共作.app 抢单实例锁
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")/.."
DEVDATA="$HOME/Library/Application Support/gongzuo-agent-dev"
mkdir -p "$DEVDATA"
exec ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --user-data-dir="$DEVDATA" 2>&1 | tee /tmp/gongzuo-dev.log
