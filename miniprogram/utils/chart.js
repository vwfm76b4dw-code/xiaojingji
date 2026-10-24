/**
 * 手写 Canvas 图表 —— 零依赖，只画这个应用真正需要的东西。
 *
 * 为什么不用图表库：① 小程序引第三方图表库要过 npm 构建，收益不抵复杂度；
 * ② 我们只需要三种基础图形，手写不到 300 行且完全可控；
 * ③ 配色必须跟主题一致（纸感主题绿），库的默认皮肤反而要花力气覆盖。
 *
 * 所有绘制函数都接收 ctx（Canvas 2D 上下文）与画布尺寸，不持有状态，
 * 便于在页面的 onReady 里按需重画。
 */

/**
 * 图表配色 —— 必须与 app.wxss 的 token 逐值一致。
 *
 * 为什么要专门写这条注释：Canvas 拿不到 CSS 变量（ctx 只认具体的颜色字符串），
 * 所以这里是 token 的**手工副本**，改一边不改另一边就会出现
 * "图表的绿和界面的绿不是同一个绿"——肉眼能看出别扭但很难定位。
 * 改 app.wxss 的颜色时，这里必须同步。
 *
 * 逐项对应关系（本表每一项都必须在 app.wxss 里找得到同名 token）：
 *   ink / ink2 / ink3 / inkHint / rule / ruleStrong / green / amber / brick / paper
 *   ↑ 新增的 inkHint 对应 app.wxss 的 --ink-hint（见下）。
 */
/** hex → rgba 字符串。COLOR 的"主色淡底"档一律从主色 hex **派生**，不再手抄 rgba 字面量：
 *  手抄副本正是"主题换了它不换"的病根 —— 从 hex 算出的 rgba 与主色永远同源。 */
function withAlpha(hex, a) {
  const h = String(hex).replace('#', '');
  return 'rgba(' + parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', '
    + parseInt(h.slice(4, 6), 16) + ', ' + a + ')';
}

const COLOR = {
  ink: '#2E4A62',          // --ink
  ink2: '#6B7A88',         // --ink-2
  /**
   * 承载文字的辅助色，对应 app.wxss 的 **--ink-hint**。
   *
   * 为什么单独加这一项：图表上的刻度、数值、空态文字都是**要读的字**，
   * 它们原来用 ink3 —— 在画布底色 --card(#FFFDF7) 上只有 2.47:1，
   * 而同一时期界面的提示文字已经提到 5.39:1（--ink-hint）。
   * 同一个 App 里两套可读性标准，本身就是"没对齐"。
   * 这里 5.39:1，与界面侧同值同标准。
   *
   * ⚠️ 改它等于改统计页所有文字的清晰度，请按对比度取舍（见 app.wxss 的 --ink-hint 注释）。
   */
  inkHint: '#5C6B78',      // --ink-hint
  /**
   * 装饰用浅灰，对应 app.wxss 的 **--ink-3**。
   *
   * ⚠️ 不要用它画任何文字 —— 2.47:1 读不清（文字一律用 inkHint）。
   * 保留这一项是因为本表是 app.wxss token 的完整副本，且 --ink-3 在界面侧
   * 仍有装饰用途（进度条灰段、折角箭头等）。chart.js 目前**没有**用到它：
   * 网格线/坐标轴用的是 rule / ruleStrong —— 那些跟着文字一起变深会让图表变吵。
   */
  ink3: '#9AA5AF',         // --ink-3（装饰专用，勿用于文字）
  rule: 'rgba(46, 74, 98, 0.16)',   // --line
  ruleStrong: 'rgba(46, 74, 98, 0.28)', // --line-2
  green: '#00825C',        // --green（纸白套主色；其余主题由调用方经 theme.accentColor() 传入）
  greenSoft: withAlpha('#00825C', 0.14),   // 主色淡底：从 green 派生（2026-09-25 去裸 rgba）
  amber: '#F6C445',        // --yellow
  amberSoft: 'rgba(246, 196, 69, 0.28)',
  brick: '#D95F3B',        // --red
  paper: '#FFFDF7'         // --card
};

/** 高 DPI：按设备像素比放大画布并缩放上下文，避免文字发虚 */
function setup(canvas, ctx, cssWidth, cssHeight) {
  let dpr = 2;
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    dpr = info.pixelRatio || 2;
  } catch (e) { /* 取不到就按 2 倍 */ }

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { dpr, width: cssWidth, height: cssHeight };
}

/** 统一的坐标轴刻度：给一组数值挑一个"整齐"的上界（1/2/5 × 10^n） */
function niceMax(values, minMax) {
  let max = 0;
  values.forEach(v => { if (v > max) max = v; });
  if (max <= 0) return minMax || 4;

  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.max(step * base, minMax || 0);
}

/**
 * 折线趋势图（用于每日记录数、每日平均字数）。
 * data: [{label, value}]
 */
function drawLine(ctx, size, data, opts) {
  opts = opts || {};
  const padL = 44, padR = 16, padT = 18, padB = 34;
  const w = size.width, h = size.height;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!data || data.length === 0) {
    drawEmptyText(ctx, size, opts.emptyText || '还没有数据');
    return;
  }

  const maxV = niceMax(data.map(d => d.value), opts.minMax || 2);

  // 横向网格线 + y 轴刻度
  ctx.strokeStyle = COLOR.rule;          // 网格线：装饰，保持浅色
  ctx.lineWidth = 1;
  ctx.fillStyle = COLOR.inkHint;         // y 轴刻度数值：文字
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = padT + (plotH / gridCount) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    const val = maxV - (maxV / gridCount) * i;
    ctx.fillText(String(Math.round(val * 10) / 10), padL - 8, y);
  }

  // x 坐标：均分（记录天数通常不多，均分比按日期比例更清晰）
  const n = data.length;
  const xAt = i => padL + (n === 1 ? plotW / 2 : (plotW / (n - 1)) * i);
  const yAt = v => padT + plotH - (v / maxV) * plotH;

  // 面积填充：让"量"有体感
  if (n > 1) {
    ctx.beginPath();
    ctx.moveTo(xAt(0), padT + plotH);
    data.forEach((d, i) => ctx.lineTo(xAt(i), yAt(d.value)));
    ctx.lineTo(xAt(n - 1), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = opts.fillColor || COLOR.greenSoft;
    ctx.fill();
  }

  // 折线
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = xAt(i), y = yAt(d.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = opts.lineColor || COLOR.green;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 数据点：数量少时画点，多了会糊成一片
  if (n <= 20) {
    ctx.fillStyle = opts.pointColor || COLOR.green;
    data.forEach((d, i) => {
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(d.value), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // x 轴标签：最多显示 5 个，避免重叠
  ctx.fillStyle = COLOR.inkHint;         // x 轴日期标签：文字
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const stepL = Math.max(1, Math.ceil(n / 5));
  data.forEach((d, i) => {
    if (i % stepL !== 0 && i !== n - 1) return;
    ctx.fillText(String(d.label).slice(-5), xAt(i), padT + plotH + 8);
  });
}

/**
 * 柱状图（默认用于 24 小时时段分布）。
 * data: [{label, value}]，highlightIndex 高亮（如高峰时段）
 * opts.xLabels: string[] —— 逐柱自定义 x 轴标签（如星期分布的 7 根柱）
 */
function drawBars(ctx, size, data, opts) {
  opts = opts || {};
  const padL = 30, padR = 12, padT = 16, padB = 30;
  const w = size.width, h = size.height;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!data || data.length === 0) {
    drawEmptyText(ctx, size, opts.emptyText || '还没有数据');
    return;
  }

  const maxV = niceMax(data.map(d => d.value), 1);

  // 基线
  ctx.strokeStyle = COLOR.ruleStrong;    // 基线：装饰，保持浅色
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  ctx.lineTo(w - padR, padT + plotH);
  ctx.stroke();

  const gap = 2;
  const barW = Math.max(2, (plotW - gap * (data.length - 1)) / data.length);

  data.forEach((d, i) => {
    if (d.value <= 0) return;
    const bh = Math.max(2, (d.value / maxV) * plotH);
    const x = padL + i * (barW + gap);
    const y = padT + plotH - bh;
    const isPeak = opts.highlightIndex === i;
    // 柱色可由调用方传入（主题跟随）：opts.color 常规柱 / opts.peakColor 高亮柱，
    // 缺省回落纸白套 —— 折线 drawLine 的 lineColor/pointColor/fillColor 与
    // 环形 drawRing、条形 drawHBar 的 color 参数本就支持，drawBars 是最后一块拼图。
    ctx.fillStyle = isPeak ? (opts.peakColor || COLOR.amber) : (opts.color || COLOR.green);
    ctx.fillRect(x, y, barW, bh);
  });

  // x 轴刻度
  ctx.fillStyle = COLOR.inkHint;         // 时刻/星期标签：文字
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  /**
   * 调用方给了 xLabels 就**逐柱**标注。
   *
   * 为什么必须有这个分支：下面那套 0/6/12/18/23 的刻度是给 24 小时分布写死的。
   * 星期分布只有 7 根柱（索引 0..6），套上去会画出"0时 / 6时"两个标签 ——
   * 图上是星期几，横轴却写着时刻，比不标还难读，而且编译期、运行时都不报错。
   */
  if (Array.isArray(opts.xLabels) && opts.xLabels.length === data.length) {
    opts.xLabels.forEach(function (lb, i) {
      ctx.fillText(String(lb), padL + i * (barW + gap) + barW / 2, padT + plotH + 6);
    });
    return;
  }

  // 默认按小时：只标 0/6/12/18/23，避免 24 个标签挤在一起
  [0, 6, 12, 18, 23].forEach(hh => {
    if (hh >= data.length) return;
    const x = padL + hh * (barW + gap) + barW / 2;
    ctx.fillText(hh + '时', x, padT + plotH + 6);
  });
}

/**
 * 环形进度（用于沉淀指数）。
 * value: 0-100
 */
function drawRing(ctx, size, value, opts) {
  opts = opts || {};
  const cx = size.width / 2;
  const cy = size.height / 2;
  const r = Math.min(size.width, size.height) / 2 - 14;
  const lw = opts.lineWidth || 12;

  const start = -Math.PI / 2;
  const ratio = Math.max(0, Math.min(1, (value || 0) / 100));

  // 底环
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = COLOR.rule;
  ctx.lineWidth = lw;
  ctx.stroke();

  // 值环
  if (ratio > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + Math.PI * 2 * ratio);
    ctx.strokeStyle = opts.color || COLOR.green;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // 中心数字
  ctx.fillStyle = COLOR.ink;
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(value || 0)), cx, cy - 6);

  ctx.fillStyle = COLOR.inkHint;         // 副标签「沉淀指数」：文字
  ctx.font = '11px sans-serif';
  ctx.fillText(opts.subLabel || '沉淀指数', cx, cy + 18);
}

/**
 * 水平条形（用于主题聚类占比）。纵向排布，便于阅读长标签。
 * items: [{label, value, sub}]
 */
function drawHBar(ctx, size, items, opts) {
  opts = opts || {};
  const padL = opts.padL || 96;      // 留给标签
  const padR = 48;                    // 留给数值
  const rowH = opts.rowH || 34;
  const w = size.width;

  if (!items || items.length === 0) {
    drawEmptyText(ctx, size, opts.emptyText || '还没有足够的数据聚类');
    return;
  }

  const maxV = niceMax(items.map(d => d.value), 1);
  const barMaxW = w - padL - padR;

  items.forEach((it, i) => {
    const y = 10 + i * rowH;
    const bw = Math.max(3, (it.value / maxV) * barMaxW);

    // 标签（右侧对齐，过长截断）
    ctx.fillStyle = COLOR.ink2;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let label = String(it.label || '');
    if (label.length > 10) label = label.slice(0, 10) + '…';
    ctx.fillText(label, padL - 10, y + 7);

    // 条
    ctx.fillStyle = opts.color || COLOR.green;
    ctx.fillRect(padL, y, bw, 14);

    // 数值
    ctx.fillStyle = COLOR.inkHint;       // 条形右侧数值：文字
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(it.sub !== undefined ? it.sub : it.value), padL + bw + 8, y + 7);
  });
}

function drawEmptyText(ctx, size, text) {
  ctx.fillStyle = COLOR.inkHint;         // 空态提示文字：文字
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size.width / 2, size.height / 2);
}

/** 让调用方按需重画 */
function heightForRows(rows, rowH) {
  return 20 + rows * (rowH || 34);
}

module.exports = {
  COLOR, setup, drawLine, drawBars, drawRing, drawHBar, niceMax, heightForRows
};
