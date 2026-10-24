/**
 * 主题系统 —— 6 套清透浅色配色 + 全站页面接线。
 *
 * ## 机制（为什么是这样而不是别的）
 *
 * 变量覆盖，不是两套样式表：每套主题只覆盖 token **子集**
 * （--paper / --card / --card-2 / 主强调 --green 系 / 辅助 --red（仅樱贝）），
 * 定义成 app.wxss 里的 `.theme-xxx { --paper: …; }` 类。页面根 view 挂上
 * `{{themeClass}}` 后，全站一切读 var() 的组件自动跟随 —— 不存在"改主题
 * 要同步改 N 个页面样式"的第二套真相。
 *
 * token 名不改：--green 在雾蓝主题下装的是蓝色 —— 名字是历史契约
 * （全站几十处 var(--green)），改名是全站重构，换值只需改这里。
 * 语义上把它读作"主强调色"，注释说明即可。
 *
 * ## 对比度口径（verify-theme.js 会逐套重算）
 *   · --ink / --ink-hint / --green-d 对各自 --paper ≥ 4.5:1（正文与正文级强调）
 *   · --on-accent 对 --green ≥ 4.5:1（主按钮白字）
 *   · 新四套的 --green 对 --paper 也 ≥ 4.5:1（新配色没理由不过）；
 *     默认纸白套 --green 对 paper 实测 4.48:1 —— 现配置不动（用户点名"默认不动"），
 *     按图形/大字 3:1 口径放行，豁免理由留在门禁输出里。
 *
 * ## 接线方式（withTheme 包装器）
 * 包 Page 配置而不是 Behavior：小程序 Page() 不支持 behaviors（那是 Component 的），
 * 自己实现包装是唯一不动页面结构的做法。包装只做一件事：onShow 时把当前主题
 * class 写进 data.themeClass（值不变就不 setData，不触发多余渲染）。
 *
 * 为什么挂 onShow 而不是 onLoad：tabBar 页（词库/复习/朗读/我的）常驻内存，
 * 用户在设置页换完主题返回时 onLoad 不会重跑 —— 挂 onLoad 的主题在四个
 * 主页面永远不刷新。onShow 每次进入都跑，天然覆盖"设置页改完返回"。
 */
const settings = require('./settings.js');

/**
 * 6 套配色。颜色本体定义在 app.wxss 的 .theme-* 类（那里是 token 唯一来源），
 * 这里只存**接线与展示所需的最小元数据**：
 *   label  —— 设置页色卡名称
 *   desc   —— 灵感 / 适用感受（设置页色卡副文案）
 *   swatch —— 色卡圆点色（取各套主强调色；与 app.wxss 的 --green 必须一致，
 *             verify-theme.js 会比对这两处）
 *   swapRed —— 仅樱贝把 --red 换成了更深的陶红（与主色拉开），其余套沿用默认；
 *              门禁据此断言"声明了 swapRed 的主题类必须覆盖 --red"。
 *
 * 2026-10-07 去同质化：原「薄荷 mint」（#2F7D4F hue145）**替换**为「紫棠 plum」
 * （#5B3E86 hue264）。替换而非新增的两个理由：
 *   1. 薄荷与纸白 #00825C 实测 dE 仅 7.9，是六套里最冗余的一套（肉眼基本分不出）；
 *   2. 薄荷 hue145° 被纸白 162° 与青瓷 187° 夹住，想调也拉不开 —— 位置本身是死的。
 * id 一并从 mint 改名 plum（id 是存储键，不该出现"叫薄荷却是紫色"的错配）。
 * ⚠️ 老用户存的 'mint' 会怎样（实测 current() 路径，勿凭直觉改）：
 *   'mint' 不在新 IDS 里 → current() 的非法值回退把它变成 **paper（纸白）**，
 *   不是 plum。也就是老用户看到的是「薄荷绿 → 默认绿」，**主色 dE 仅 7.9、色相差17°**，
 *   视觉几乎连续。
 *   为什么**不加**别名把 mint 映射到 plum：那样是「薄荷绿 → 紫棠紫」，
 *   色相差 119°、主色 dE 85.0，是上面那个落差的 **10.7 倍** ——
 *   一个记着"我选了绿色主题"的用户，被静默换成紫色，比退回默认更糟。
 *   换句话说：非法值回退在这里恰好是**语义正确**的那一种，不是将就。
 *   （真要保留薄荷，正确做法是把它当第7 套主题加回来，而不是映射到 plum。）
 */
const THEMES = {
  paper: {
    label: '纸白',
    desc: '默认 · 经典纸白',
    swatch: '#00825C',
    swapRed: false
  },
  celadon: {
    label: '青瓷',
    desc: '青灰釉色 · 清透冷静',
    swatch: '#266A73',
    swapRed: false
  },
  mist: {
    label: '雾蓝',
    desc: '雨后天空 · 沉稳专注',
    swatch: '#2E6BA8',
    swapRed: false
  },
  sakura: {
    label: '樱贝',
    desc: '贝母暖粉 · 轻松柔和',
    swatch: '#A8503C',
    swapRed: true
  },
  plum: {
    label: '紫棠',
    desc: '暮色紫檀 · 安静专注',
    swatch: '#5B3E86',
    swapRed: false
  }
};

/** 合法 id 清单（门禁也用它断言完整性） */
const IDS = Object.keys(THEMES);

/** 存储里的 id → 实际生效 id。非法值（含空/旧版本数据）一律回退 paper：
    主题是外观偏好，任何脏数据都不该把页面打挂。 */
function current() {
  const v = settings.get('theme');
  return IDS.indexOf(v) !== -1 ? v : 'paper';
}

/** 页面根 view 要挂的 class。默认套也返回 'theme-paper'：
    wxml 写法统一为 class="page {{themeClass}}"，机械接线不易漏；
    .theme-paper 在 app.wxss 无定义（默认 token 就是纸白），空规则不用建。 */
function themeClassOf(id) {
  return 'theme-' + (THEMES[id] ? id : 'paper');
}

/** 无参便捷 API：当前主题的 class。
    为什么必须导出这个形态：pack-social/theme-bridge.js 的防御式接线约定了
    "mod.themeClass() 函数形态"（形态二）—— 分包页面隔着桥读主题，
    不感知 themeClassOf(id) 这个带参实现。缺了它桥会永远回退空串，
    社交两页就永远停在默认纸白。 */
function themeClass() {
  return themeClassOf(current());
}

/** 换主题（设置页调用）。返回最新 settings 快照，与 settings.save 的页面惯例一致 */
function setColor(id) {
  return settings.save({ theme: THEMES[id] ? id : 'paper' });
}

/*------------------------- 画布取色（统计图表的主题跟随） -------------------------*/

/** hex → [r,g,b]。只服务 accentSoft 的 rgba 拼装，不值得为此引一个颜色库 */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 130, 92];   // 脏数据回退纸白绿，不能炸画布
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 当前主题的主强调色（hex），给 Canvas 图表用。
 *
 * 为什么必须存在：Canvas 拿不到 CSS 变量（ctx 只认颜色字符串），统计图的
 * 折线/柱/环不传色就会永远停在 chart.COLOR 里那份纸白绿的手工副本上 ——
 * 换主题后"界面的绿和图里的绿不是同一个绿"。
 * 色值取 THEMES[id].swatch 而不是在 JS 里再抄一份 hex：swatch 与 app.wxss
 * 各主题 --green 的一致性已由 verify-theme.js 逐套钉死，复用它就不出现第三处真相。
 * 调用方应在**每次绘制时现取**（stats 的 draw 都跑在 onShow→nextTick 里），
 * 设置页换完主题返回立即生效，不需要任何额外的刷新事件。
 */
function accentColor() {
  return THEMES[current()].swatch;
}

/** 主强调色的淡底版（面积填充/软高亮用）。缺省 alpha 0.14，与 chart.COLOR 的软档同档 */
function accentSoft(alpha) {
  const a = alpha === undefined ? 0.14 : alpha;
  const rgb = hexToRgb(accentColor());
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + a + ')';
}

/**
 * 页面包装器：Page(theme.withTheme({ …原配置… }))
 * data 里补 themeClass 初值（首屏就有正确主题，不会闪一下默认色），
 * onShow 前置刷新（见文件头注释）。页面自己的 onShow 原样被调用。
 */
function withTheme(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('[theme] withTheme 需要页面配置对象');
  }
  if (!config.data) config.data = {};
  if (config.data.themeClass === undefined) {
    config.data.themeClass = themeClassOf(current());
  }
  const userOnShow = config.onShow;
  config.onShow = function () {
    const cls = themeClassOf(current());
    if (this.data.themeClass !== cls) {
      this.setData({ themeClass: cls });
    }
    if (userOnShow) userOnShow.apply(this, arguments);
  };
  return config;
}

module.exports = { THEMES, IDS, current, themeClassOf, themeClass, setColor, accentColor, accentSoft, withTheme };
