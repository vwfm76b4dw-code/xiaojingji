#!/usr/bin/env bash
# 质量门总入口 —— 一次跑完所有校验。
#
# 为什么要有这个脚本：门禁散在 9 个文件里，靠人记得逐个跑是防不住的
# （漏跑一个，它守的那类问题就静默回来了）。这里给出唯一的"改完代码该跑什么"。
#
# 用法：
#   bash tools/check_all.sh           # 全部跑一遍，有任何失败则退出码非 0
#   bash tools/check_all.sh --quick   # 跳过 runtime（最慢的一道）

set -u
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0
FAIL=0
FAILED_NAMES=()

run() {
  local name="$1"
  local file="$2"
  printf "%-34s" "$name"
  local out
  out=$(node "tools/$file" 2>&1)
  local rc=$?
  local stat
  stat=$(echo "$out" | grep -oE ">>> [0-9]+ 通过 / [0-9]+ 失败" | tail -1)
  if [ $rc -eq 0 ]; then
    echo "OK   ${stat:-通过}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${stat:-失败}"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$file")
    echo "$out" | grep -E "^FAIL|^  · " | head -8 | sed 's/^/      /'
  fi
}

echo "=============================================================="
echo " 小鲸记单词 · 质量门"
echo "=============================================================="
echo
echo "-- 算法层 --"
run "SM-2 核心"            verify-sm2.js
run "SM-2 应用层"          verify-sm2-app.js
echo
echo "-- AI 层 --"
run "AI 契约与降级"        verify-ai.js
run "AI 边界"              verify-edge.js
echo
echo "-- 页面层 --"
run "页面逻辑"             verify-pages.js
if [ $QUICK -eq 0 ]; then
  run "页面运行时冒烟"     verify-runtime.js
else
  printf "%-34s" "页面运行时冒烟"
  echo "SKIP (--quick)"
fi
echo
echo "-- 云函数契约 --"
run "云函数（ASR/问答）"     verify-cloudfn.js
echo
echo "-- 端上能力（离线可用性内核）--"
run "检索/分析/发音包"       verify-ondevice.js
echo
echo "-- 端到端 --"
run "跨页集成"             verify-integration.js
echo
echo "-- 真机/GUI 层（需开发者工具，缺环境自动跳过）--"
printf "%-34s" "开发者工具自动化"
out=$(node tools/verify-devtools.js 2>&1)
rc=$?
if echo "$out" | grep -q "^SKIP"; then
  echo "SKIP （未开自动化端口）"
elif [ $rc -eq 0 ]; then
  echo "OK   $(echo "$out" | grep -oE '>>> [0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
  PASS=$((PASS + 1))
else
  echo "FAIL $(echo "$out" | grep -oE '>>> [0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("verify-devtools.js")
fi
echo
echo "-- §6.2 十步冒烟（需开发者工具，缺环境自动跳过）--"
printf "%-34s" "用户路径冒烟"
out=$(node tools/smoke-10-steps.js 2>&1)
rc=$?
if echo "$out" | grep -q "^SKIP"; then
  echo "SKIP （未开自动化端口）"
elif [ $rc -eq 0 ]; then
  echo "OK   $(echo "$out" | grep -oE '>>> [0-9]+ 步通过 / [0-9]+ 步失败' | tail -1)"
  PASS=$((PASS + 1))
else
  echo "FAIL $(echo "$out" | grep -oE '>>> [0-9]+ 步通过 / [0-9]+ 步失败' | tail -1)"
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("smoke-10-steps.js")
  echo "$out" | grep -E "^FAIL" | head -8 | sed 's/^/      /'
fi
echo
echo "-- 包结构 --"
run "结构与红线"           verify-structure.js
run "包完整性（静态编译）" verify-package.js

echo
echo "=============================================================="
if [ $FAIL -eq 0 ]; then
  echo " >>> 全部通过（$PASS 道门禁）"
else
  echo " >>> $PASS 道通过 / $FAIL 道失败"
  echo "     失败：${FAILED_NAMES[*]}"
fi
echo "=============================================================="
exit $FAIL
