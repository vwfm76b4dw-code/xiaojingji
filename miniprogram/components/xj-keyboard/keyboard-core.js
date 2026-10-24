/**
 * 小鲸自带键盘 —— 纯逻辑核心（布局生成 / 联想过滤 / 退格状态机）。
 *
 * ## 为什么单独拆一个文件
 * 组件文件天生依赖 Component() 与 wx 全局，门禁（纯 Node）没法直接 require；
 * 这里**一个 wx 都不碰**，所有函数都是「输入 → 输出」的纯函数，
 * tools/verify-keyboard.js 能在 Node 里确定性复现每一格行为。
 * 组件（xj-keyboard.js）只做事件与 setData 的粘合，不再内藏第二份逻辑 ——
 * 两处各写一份"联想怎么过滤"迟早会口径漂移。
 *
 * ## 为什么退格状态机要可注入时间
 * 长按连删的节奏（300ms 起步、逐级加速、下限 40ms）是契约行为，
 * 用真实时钟测要靠 setTimeout 等待，慢且抖；状态机把"此刻该不该再删"
 * 做成 tick(t) 的纯判断，测试直接喂假时间戳，毫秒级精确复现。
 */

/** QWERTY 三行。行结构带 id，供 WXML 的 wx:key 用（数组项没有可用属性） */
var ROW_LETTERS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** 布局生成：=> [{id, chs}]。确定性输出，测试可逐字符断言 */
function buildRows() {
  return ROW_LETTERS.map(function (letters, i) {
    return { id: 'row' + i, chs: letters.split('') };
  });
}

/**
 * 联想过滤：前缀匹配（大小写不敏感），保持调用方传入的顺序（排序是调用方的事），
 * 最多 limit 条；与输入完全相同（忽略大小写）的词不再推荐 —— 推荐它等于没推荐。
 */
function filterSuggestions(list, prefix, limit) {
  var p = String(prefix == null ? '' : prefix).toLowerCase().replace(/^\s+|\s+$/g, '');
  if (!p) return [];
  var cap = limit > 0 ? limit : 5;
  var out = [];
  for (var i = 0; i < list.length && out.length < cap; i++) {
    var w = String(list[i] == null ? '' : list[i]);
    var lw = w.toLowerCase();
    if (lw === p) continue;
    if (lw.indexOf(p) === 0) out.push(w);
  }
  return out;
}

/*------------------------- 退格状态机 -------------------------*/

var BS_DEFAULTS = {
  delayMs: 300,          // 长按多久后开始连删（契约 §2.3 定值）
  startIntervalMs: 150,  // 连删的起始间隔
  minIntervalMs: 40,     // 加速下限：再快手指就跟不上节奏了
  accel: 0.7             // 每删一个间隔乘 0.7（150→105→74→52→40 触底），删长词越删越快
};

/**
 * 退格状态机（可注入时间）。
 *   press(t)  → 按下：立即删 1 个，记下起点
 *   tick(t)   → 按住期间的轮询：返回这一拍应删的次数（0 或 1）
 *   release() → 松手：停
 * 组件侧用一个 ~30ms 的 setInterval 持续问 tick，而不是 setTimeout 链 ——
 * 连删间隔本身在加速，用变化的 setTimeout 重建定时器容易飘；轮询 + 状态机判定是稳定做法。
 */
function createBackspace(cfg) {
  var c = {};
  for (var k in BS_DEFAULTS) c[k] = (cfg && cfg[k] != null) ? cfg[k] : BS_DEFAULTS[k];
  var st = { holding: false, t0: 0, lastFire: 0, interval: c.startIntervalMs };

  return {
    press: function (t) {
      st.holding = true;
      st.t0 = t;
      st.lastFire = t;
      st.interval = c.startIntervalMs;
      return 1;                       // 按下立即删一个，不等 300ms
    },
    release: function () {
      st.holding = false;
      return 0;
    },
    tick: function (t) {
      if (!st.holding) return 0;
      if (t - st.t0 < c.delayMs) return 0;                    // 还没到连删起步点
      if (t - st.lastFire < st.interval) return 0;            // 这一拍间隔未到
      st.lastFire = t;
      if (st.interval > c.minIntervalMs) {
        st.interval = Math.max(c.minIntervalMs, Math.round(st.interval * c.accel));
      }
      return 1;
    }
  };
}

/*------------------------- 大小写 -------------------------*/

/**
 * 点 shift 之后的下一个状态：on ↔ off，auto 视同 on（点一下就关）。
 * auto 是"句首大写"预备位（值清空时进入），不是锁定位。
 */
function shiftAfterTap(state) {
  return state === 'off' ? 'on' : 'off';
}

/** shift 非 off 时键入大写（键帽的大写显示交给 CSS text-transform，这里只管值） */
function charFor(ch, shift) {
  return shift === 'off' ? ch : ch.toUpperCase();
}

module.exports = {
  buildRows: buildRows,
  filterSuggestions: filterSuggestions,
  createBackspace: createBackspace,
  shiftAfterTap: shiftAfterTap,
  charFor: charFor,
  BS_DEFAULTS: BS_DEFAULTS
};
