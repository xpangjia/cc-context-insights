#!/bin/bash
# 一键启动:没装 bun 就提示怎么装;装了就直接跑,浏览器会自动打开
cd "$(dirname "$0")"
if ! command -v bun >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then export PATH="$HOME/.bun/bin:$PATH"; fi
if ! command -v bun >/dev/null 2>&1; then
  echo "需要先装 bun（一个 JavaScript 运行环境，装一次就行）："
  echo ""
  echo "  curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "装好后重新打开终端，再运行 ./start.sh"
  exit 1
fi
exec bun server/index.ts
