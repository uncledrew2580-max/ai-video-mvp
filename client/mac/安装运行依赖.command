#!/bin/bash
# TikTok AI 视频工作台 — 安装/更新运行依赖

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "================================================"
echo "  TikTok AI 视频工作台 — 安装运行依赖"
echo "================================================"
echo "  项目目录: $PROJECT_ROOT"
echo ""

export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH="$HOME/.npm-global/bin:$PATH"

if ! command -v node &>/dev/null; then
  echo "❌ 找不到 Node.js。请先安装 Node.js 18 或更高版本："
  echo "   https://nodejs.org/"
  echo ""
  echo "按回车键退出..."
  read -r
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "❌ 找不到 npm。请重新安装 Node.js。"
  echo ""
  echo "按回车键退出..."
  read -r
  exit 1
fi

cd "$PROJECT_ROOT" || exit 1

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo ""
echo "正在安装依赖，第一次可能需要几分钟..."
echo ""

npm install
EXIT_CODE=$?

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
  chmod +x "$PROJECT_ROOT/client/mac/TikTok AI 视频工作台.command" 2>/dev/null || true
  echo "✅ 依赖安装完成。"
  echo "现在可以双击：TikTok AI 视频工作台.command"
else
  echo "❌ 依赖安装失败。请检查网络，或把上方错误信息发给售后。"
fi

echo ""
echo "按回车键退出..."
read -r
