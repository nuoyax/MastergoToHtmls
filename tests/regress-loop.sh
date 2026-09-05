#!/bin/bash
# 冒烟回归循环：等新 ZIP 出现 → 跑 compare-zip + smoke → 输出结果
cd "$(dirname "$0")/.."
LAST=$(ls -t download/*.zip 2>/dev/null | head -1)
echo "等待新导出（当前最新: $(basename "$LAST")）… 导出后自动回归"
while true; do
  sleep 3
  NEW=$(ls -t download/*.zip 2>/dev/null | head -1)
  if [ "$NEW" != "$LAST" ]; then
    echo "=== 新导出: $(basename "$NEW") ==="
    node tests/compare-zip.mjs "$(basename "$NEW")"
    [ -f download/dsl-latest.json ] && node tests/smoke.mjs || echo "(无 dsl-latest.json，跳过 smoke)"
    LAST=$NEW
  fi
done
