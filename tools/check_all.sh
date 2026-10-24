#!/usr/bin/env bash
# 质量门总入口 —— 一次跑完所有校验。
#
# 为什么要有这个脚本：门禁散在 9 个文件里，靠人记得逐个跑是防不住的
# （漏跑一个，它守的那类问题就静默回来了）。这里给出唯一的"改完代码该跑什么"。
#
# 用法：
#   bash tools/check_all.sh              # 全部跑一遍；失败→1，有 SKIP→2（无 GUI 时用下行）
#   bash tools/check_all.sh --allow-skip # 本机日常：接受「真机门禁未跑」的结论（交付前禁用）
#   bash tools/check_all.sh --quick      # 跳过 runtime（最慢的一道）

set -u
cd "$(dirname "$0")/.."

QUICK=0
ALLOW_SKIP=0
[ "${1:-}" = "--quick" ] && QUICK=1
# --allow-skip：本机日常开发用 —— 无 GUI 时真机门禁恒 SKIP，严格模式会让
# 每次都 exit 2。此开关显式承认「这次只要 Node/静态层结论」，横幅仍声明 SKIP 数。
# CI / 交付前禁用该开关 —— 交付结论必须全跑。
for a in "$@"; do [ "$a" = "--allow-skip" ] && ALLOW_SKIP=1; done

PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()

# ---------------- 同步守卫（先同步 → 再跑门禁）----------------
#
# 为什么需要：最后两道门禁（开发者工具自动化 / 十步冒烟）跑的是**部署镜像** ——
# 开发者工具加载的那个目录，而不是本仓的 miniprogram/。
# 改了 miniprogram/ 却忘了同步，这两道跑的就是**旧代码**：它们会一路报 OK，
# 而你真正想验证的那次改动根本没被执行到。2026-09-18 工程师踩过一次
# （真机报 OK，同一次 wx-sync-check.py 却报 SYNC FAIL）。
#
# 为什么不做成硬失败：本仓要作为公开资源发布，仓规**禁止**把任何人的本机镜像路径
# 写进受版本控制的文件（见 wx-sync-check.py 文件头），所以守卫只能靠 WX_TARGET
# 定位镜像；而"我就是要单独跑 Node 门禁"同样是合理诉求，不该被一个环境变量挡住。
# 折中：定位不到镜像 → 只提示，照常跑；
#       定位到且不一致 → 那两道**不记分**（降级为 SKIP + 醒目警告）。
#       假绿正是要消灭的东西，但消灭它的代价不该是阻断 Node 层。
#
# 镜像路径从哪来（优先级从高到低）：
#   ① 环境变量 WX_TARGET
#   ② tools/.wx-target —— **本机私有**配置文件（单行文本，内容就是镜像绝对路径；
#      空行与 # 开头的行会被忽略，行尾 # 注释也支持），已 gitignore，不进公开仓
#   ③ 都没有 → 只提示，不拦（与加这个 fallback 之前的行为完全一致）
#
# 为什么非要有 ②：大家的习惯命令是 `bash tools/check_all.sh`（不带变量）。
# 只认环境变量的守卫在这种跑法下**等于没有** —— 它打印一行提示就过去了，假绿照旧。
# 而仓规禁止把本机路径写进受版本控制的文件，所以路径只能放在一个本机私有文件里由脚本读；
# 让它读不到时只提示（而不是报错），就不会因为少配一个文件而挡住任何人。
#
# 用法（本机一次性配置，文件由使用者自己创建）：
#   printf '%s\n' 'C:/Users/<你的用户名>/WeChatProjects/miniprogram-2' > tools/.wx-target
#
# 状态：1 = 已校验通过；0 = 镜像不一致；-1 = 无法定位镜像
#   （未设 WX_TARGET 且无本机配置 / 该目录不存在 / 缺 python —— 都不该阻断 Node 门禁）
WX_TARGET_FILE="tools/.wx-target"
if [ -z "${WX_TARGET:-}" ] && [ -f "$WX_TARGET_FILE" ]; then
  # 这个文件是人手写的，所以读的时候要容忍几种常见写法，否则会掉进本守卫最想消灭的
  # 那个坑 —— "看着配了其实没生效"（路径没解析出来 → 静默退回"只提示" → 假绿）：
  #   · CRLF：记事本存的行尾会让 -d 判断必然失败
  #   · 反斜杠：从资源管理器复制来的是 C:\Users\...，在 bash 里 -d 认不出来
  #   · 引号：从终端或聊天里复制来时常带一对引号
  WX_TARGET=$(tr -d '\r' < "$WX_TARGET_FILE" \
    | sed -e 's/#.*//' \
      -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
      -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" \
      -e 's|\\|/|g' \
    | grep -m1 '[^[:space:]]')
  export WX_TARGET
fi

GUI_SYNC=-1
if [ -n "${WX_TARGET:-}" ] && [ -d "${WX_TARGET:-}" ] && command -v python >/dev/null 2>&1; then
  if python tools/wx-sync-check.py --quiet >/dev/null 2>&1; then
    GUI_SYNC=1
  else
    GUI_SYNC=0
  fi
fi

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
    echo "$out" | grep -E "^FAIL|^  · |^      " | head -8 | sed 's/^/      /'
  fi
}

echo "=============================================================="
echo " 小鲸记单词 · 质量门"
echo "=============================================================="
echo
if [ $GUI_SYNC -eq 0 ]; then
  echo "⚠  部署镜像与编辑源不一致 —— 最后两道真机门禁本次将被跳过。"
  echo "   它们跑的是镜像而不是本仓：不同步就跑，等于在测旧代码（假绿）。"
  echo "   修复：WX_TARGET=<镜像目录> python tools/wx-sync-apply.py --prune"
  echo
elif [ $GUI_SYNC -eq -1 ]; then
  echo "提示：无法定位部署镜像（WX_TARGET 未设，且 tools/.wx-target 不存在或为空），"
  echo "      无法校验镜像与编辑源是否一致。"
  echo "      最后两道真机门禁跑的是**镜像**而不是本仓 —— 若刚改过 miniprogram/"
  echo "      又忘了同步，那两道可能是假绿。"
  echo "      修复：设 WX_TARGET=<镜像目录> 重跑；或写一次本机私有配置（已 gitignore，不进仓），"
  echo "            之后不带变量的 bash tools/check_all.sh 也会自动校验："
  echo "            printf '%s\\n' '<镜像目录>' > tools/.wx-target"
  echo
fi
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
  SKIP=$((SKIP + 1))
fi
echo
echo "-- 云函数契约 --"
run "云函数（ASR/问答）"     verify-cloudfn.js
run "社交云函数（好友/宠物）" verify-social.js
# 子进程重试判别式是 verify-cloudfn 的 EBUSY 修复的安全边界：
# 它的"只对没起来的进程重试"一旦被破坏，门禁会静默假绿，且没有任何其它用例能拦。
run "子进程重试防假绿"       verify-spawn-retry.js
# verify-semantic.js 需要本机先装 onnxruntime-node（~47MB Node 原生绑定，
# 慢于 CI 门禁不会采用它；01-28 起改用本地单词级测试路径的前提/dedupe），
# 未装时本门禁自身 SKIP， check_all 不把它当失败
if node -e "
try { require('onnxruntime-node'); process.exit(0); } catch(e) { process.exit(1); }
" 2>/dev/null; then
  run "语义检索校准"      verify-semantic.js
else
  printf "%-34s" "语义检索校准"
  echo "SKIP（需先装 onnxruntime-node：npm i onnxruntime-node）"
fi
echo
echo "-- 端上能力（离线可用性内核）--"
run "检索/分析/发音包"       verify-ondevice.js
run "端上语音判定(MFCC+DTW)" verify-dtw.js
run "端上判定链路(WAV/加载)" verify-acoustic.js
run "云资源缓存(下载/降级)"  verify-resources.js
run "朗读后端选择与文案"     verify-voice.js
run "启动资源管线"          verify-boot.js
run "增长看板内核"         verify-growth.js
run "音效递进与静音"       verify-sfx.js
run "单元测验内核"         verify-quiz.js
run "音节划分与词表卫生"   verify-syllable.js
echo
echo
echo "-- 教材与输入层 --"
run "教材注册与增删改"      verify-textbooks.js
run "自带键盘与记忆技巧"    verify-keyboard.js
run "学习量自适应"      verify-learn-advisor.js
run "我的页与底部导航"      verify-profile.js
run "主题配色与对比度"      verify-theme.js
run "复习交互与触感"        verify-reviewUX.js
echo
echo "-- 端到端 --"
run "跨页集成"             verify-integration.js
echo
echo "-- 真机/GUI 层（需开发者工具，缺环境自动跳过）--"
printf "%-34s" "开发者工具自动化"
if [ $GUI_SYNC -eq 0 ]; then
  # 镜像没同步：这一道跑的就是旧代码，报 OK 才是灾难。宁可不记分。
  echo "SKIP （部署镜像未同步，跑它等于测旧代码）"
  SKIP=$((SKIP + 1))
else
  out=$(node tools/verify-devtools.js 2>&1)
  rc=$?
  if echo "$out" | grep -q "^SKIP"; then
    echo "SKIP （未开自动化端口）"
    SKIP=$((SKIP + 1))
  elif [ $rc -eq 0 ]; then
    echo "OK   $(echo "$out" | grep -oE '>>> [0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    PASS=$((PASS + 1))
  else
    echo "FAIL $(echo "$out" | grep -oE '>>> [0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("verify-devtools.js")
    echo "$out" | grep -E "^FAIL" | head -8 | sed 's/^/      /'
    echo "$out" | grep -B2 'Node.js v' | head -6 | sed 's/^/      [err] /'
  fi
fi
echo
echo "-- §6.2 十步冒烟（需开发者工具，缺环境自动跳过）--"
printf "%-34s" "用户路径冒烟"
if [ $GUI_SYNC -eq 0 ]; then
  echo "SKIP （部署镜像未同步，跑它等于测旧代码）"
  SKIP=$((SKIP + 1))
else
  out=$(node tools/smoke-10-steps.js 2>&1)
  rc=$?
  if echo "$out" | grep -q "^SKIP"; then
    echo "SKIP （未开自动化端口）"
    SKIP=$((SKIP + 1))
  elif [ $rc -eq 0 ]; then
    echo "OK   $(echo "$out" | grep -oE '>>> [0-9]+ 步通过 / [0-9]+ 步失败' | tail -1)"
    PASS=$((PASS + 1))
  else
    echo "FAIL $(echo "$out" | grep -oE '>>> [0-9]+ 步通过 / [0-9]+ 步失败' | tail -1)"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("smoke-10-steps.js")
    echo "$out" | grep -E "^FAIL" | head -8 | sed 's/^/      /'
    echo "$out" | grep -B2 'Node.js v' | head -6 | sed 's/^/      [err] /'
  fi
fi
echo
echo "-- 包结构 --"
run "结构与红线"           verify-structure.js
run "视觉完整性"           verify-visual.js
run "包完整性（静态编译）" verify-package.js

echo
echo "=============================================================="
if [ $FAIL -eq 0 ]; then
  echo " >>> $PASS 道通过 / $FAIL 道失败 / $SKIP 道未跑（SKIP）"
  # 2026-09-24（DEV-P0-3）：「全部通过」曾对 SKIP 道静默 —— 无 GUI 环境下
  # 每次都是 11/13，横幅却自称全部通过。全绿 ≠ 全跑：SKIP 的道不构成证据。
  # 现在横幅强制声明未跑数，且 SKIP 道使退出码非 0，CI 无法再误读。
  if [ $SKIP -gt 0 ]; then
    echo "     ⚠ $SKIP 道真机门禁未跑（需开发者工具自动化端口）——"
    echo "       「全绿」只覆盖 Node/静态层，真机层无结论。"
    if [ $ALLOW_SKIP -eq 1 ]; then
      echo "       （--allow-skip 已生效：本次接受该结论。交付/CI 禁用此开关）"
    else
    echo "       补跑：cli agent start --project <项目> --auto-port 9420 后重跑本脚本。"
    exit 2
    fi
  fi
  if [ $GUI_SYNC -eq 0 ]; then
    echo "     ⚠ 两道真机门禁被跳过（部署镜像未同步）—— 本次结论只覆盖 Node/静态层。"
  elif [ $GUI_SYNC -eq -1 ]; then
    echo "     ⚠ 两道真机门禁未经同步校验（未定位到部署镜像）—— 若刚改过 miniprogram/，"
    echo "       它们可能跑的是旧代码，报 OK 也不代表本次改动真的过了。"
  fi
else
  echo " >>> $PASS 道通过 / $FAIL 道失败 / $SKIP 道未跑（SKIP）"
  echo "     失败：${FAILED_NAMES[*]}"
fi
echo "=============================================================="
exit $FAIL
