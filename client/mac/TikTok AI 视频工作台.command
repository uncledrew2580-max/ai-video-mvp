#!/bin/bash
# TikTok AI 视频工作台 — 双击启动脚本 (Phase 2.1 Mac MVP)
# 双击此文件会在 Terminal 中运行，自动启动 n8n + 工作台 UI 并打开浏览器。

# ─── 定位项目根目录 ───────────────────────────────────────────────────────────
# 本脚本位于 client/mac/，向上两级为项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "================================================"
echo "  TikTok AI 视频工作台 — 启动中"
echo "================================================"
echo "  项目目录: $PROJECT_ROOT"
echo ""

# ─── 检查 node 是否可用 ───────────────────────────────────────────────────────
# 加载常见 Node.js 路径（nvm / Homebrew / 官方安装）
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH="$HOME/.npm-global/bin:$PATH"

if ! command -v node &>/dev/null; then
  echo "❌ 找不到 node 命令。"
  echo ""
  echo "   请先安装 Node.js（v18 或更高版本）："
  echo "   https://nodejs.org/"
  echo ""
  echo "   安装完成后重新双击此文件。"
  echo ""
  echo "按回车键退出..."
  read -r
  exit 1
fi

NODE_VER="$(node --version)"
echo "  Node.js $NODE_VER ✓"
echo ""

# ─── 切换到项目根目录并启动 ──────────────────────────────────────────────────
cd "$PROJECT_ROOT" || {
  echo "❌ 无法进入项目目录: $PROJECT_ROOT"
  echo "按回车键退出..."
  read -r
  exit 1
}

node client/launcher.mjs
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "================================================"
  echo "  ❌ 启动器异常退出（错误码: $EXIT_CODE）"
  echo "  请查看上方错误信息或日志："
  echo "  $PROJECT_ROOT/logs/launcher/"
  echo "================================================"
  echo ""
  echo "按回车键退出..."
  read -r
fi
