/**
 * 音效：练习反馈的随包短音（assets/sfx/*.wav）。
 *
 * ## 为什么用 wav 而不是 mp3
 * 这里是自己生成的单音，wav 直出零编码依赖（python wave 模块直写），
 * InnerAudioContext 原生支持。播放器复用一个实例（切换 src 不重建）。
 *
 * ## 连对递进（2026-09-24 加）
 * 答对音分 4 档，音高逐级升高（+0 / +4 / +7 / +12 半音）。
 * 为什么必须递进：机械的"答对一声、答错一声"，用户三天后就麻木了；
 * 而音高随连对上升会形成**听觉上的爬升感**，把"连对"这件事变得可感知 ——
 * 这比在界面上加一个"连对 5"的数字更直接。
 *
 * ## 四条"不该响"的规则（都是为了避免烦人）
 *   ① **录音期间强制静音** —— 见 setMuted()。这条对本项目是硬约束：
 *      pronounce 页录音时若播音效，会被麦克风录进去，干扰 acoustic.js 的
 *      MFCC 判定（相当于在学生的读音里混进一段纯音）。属于会污染数据的 bug。
 *   ② **同种音 300ms 冷却** —— 快速连点时音效会叠成噪音。原实现只在同种音
 *      连续触发时 stop 再 play，挡不住交替触发，也挡不住 60ms 内的双击。
 *   ③ **连错第 3 次起降音量** —— 同一个刺耳的错误音反复播放会形成"惩罚循环"，
 *      让越错的人越烦。第 3 次起音量降到 0.45，音还是那个音，但不扎人了。
 *   ④ **页面切换/进入页面不放音** —— 只在"用户主动操作的结果"上放。
 *      这条靠调用方自觉，代码里做不到，故写在这里当契约。
 *
 * 是否播放听设置页「音效」开关（utils/settings.js 的 sfx 键，默认开）。
 * 静音开关**必须被尊重** —— 它比上面任何一条都优先。
 */
const settings = require('./settings.js');

/**
 * 音效表。cooldown 是同种音的最小间隔（ms）。
 * 静音类（finish / milestone）给长冷却：它们是"结算音"，叠加播两次会很怪。
 */
const SOUNDS = {
  tap:       { src: '/assets/sfx/tap.wav',       cooldown: 80 },
  ok1:       { src: '/assets/sfx/ok1.wav',       cooldown: 300 },
  ok2:       { src: '/assets/sfx/ok2.wav',       cooldown: 300 },
  ok3:       { src: '/assets/sfx/ok3.wav',       cooldown: 300 },
  ok4:       { src: '/assets/sfx/ok4.wav',       cooldown: 300 },
  bad:       { src: '/assets/sfx/bad.wav',       cooldown: 400 },
  combo:     { src: '/assets/sfx/combo.wav',     cooldown: 800 },
  finish:    { src: '/assets/sfx/finish.wav',    cooldown: 3000 },
  milestone: { src: '/assets/sfx/milestone.wav', cooldown: 3000 }
};

/** 连对档位 → 音效名。阈值与文案库的"连对 3 / 6 / 10"对齐。 */
const COMBO_TIERS = [
  { min: 10, kind: 'ok4' },
  { min: 6,  kind: 'ok3' },
  { min: 3,  kind: 'ok2' },
  { min: 0,  kind: 'ok1' }
];

/** 连错到第几次开始"变软" */
const SOFT_AFTER_WRONG = 3;
const SOFT_VOLUME = 0.45;
const NORMAL_VOLUME = 1;

let ctx = null;
let muted = false;
let wrongStreak = 0;
const lastAt = Object.create(null);      // kind → 上次播放时间戳

/** 当前时间。抽出来是为了让门禁能替换成可控时钟。 */
let now = function () { return Date.now(); };

function ensureCtx() {
  if (ctx) return ctx;
  try {
    ctx = wx.createInnerAudioContext();
    // 反馈音跟随 App 内开关，不跟随系统静音（练习反馈属于内容）
    ctx.obeyMuteSwitch = false;
  } catch (e) { ctx = null; }
  return ctx;
}

/**
 * 播放。
 *
 * @param {string} kind SOUNDS 的键
 * @param {Object} [opt]
 *   @param {number} [opt.volume] 覆盖音量（0~1）
 */
function play(kind, opt) {
  opt = opt || {};
  if (muted) return;                       // ① 录音期间静音（最高优先）
  try { if (!settings.get('sfx')) return; } catch (e) { return; }

  const conf = SOUNDS[kind];
  if (!conf) return;

  // ② 同种音冷却窗
  const t = now();
  if (lastAt[kind] && (t - lastAt[kind]) < conf.cooldown) return;
  lastAt[kind] = t;

  // ③ 连错变软
  let vol = opt.volume;
  if (vol === undefined) {
    vol = (kind === 'bad' && wrongStreak >= SOFT_AFTER_WRONG) ? SOFT_VOLUME : NORMAL_VOLUME;
  }

  const c = ensureCtx();
  if (!c) return;
  try {
    if (c.src !== conf.src) c.src = conf.src;
    c.volume = Math.max(0, Math.min(1, vol));
    // 换源后必须从头播；同源重复触发也从头（否则第二次点会"没声音"）
    try { c.stop(); } catch (e) { /* 未在播放时 stop 会抛，忽略 */ }
    c.play();
  } catch (e) { /* 音效失败不影响主流程 */ }
}

/**
 * 按连对次数播放对应的答对音（连对递进的唯一入口）。
 * @param {number} combo 当前连对次数（含本次）
 */
function playOk(combo) {
  const n = Math.max(0, Number(combo) || 0);
  const tier = COMBO_TIERS.filter(function (x) { return n >= x.min; })[0];
  wrongStreak = 0;                          // 答对即重置连错
  play(tier ? tier.kind : 'ok1');
}

/** 播放答错音（内部维护连错计数，用于"变软"） */
function playBad() {
  wrongStreak += 1;
  play('bad');
}

/**
 * 录音期间静音 —— **本项目特有的硬约束**。
 *
 * pronounce 页在 startRecord 时 setMuted(true)、判定结束/离开页面时 setMuted(false)。
 * 不这么做的话：学生按下录音 → 界面播放"开始"或上一题的反馈音 → 音效被麦克风录进录音 →
 * MFCC 特征里混进一段纯音 → 端上声学判定的距离被拉偏，而**判定不会报错**，
 * 只会安静地判错。属于会污染数据的 bug，不是体验问题。
 */
function setMuted(v) { muted = !!v; }
function isMuted() { return muted; }

/** 重置内部状态。测试用；也用于"换一轮练习"时清掉连错计数。 */
function reset() {
  wrongStreak = 0;
  Object.keys(lastAt).forEach(function (k) { delete lastAt[k]; });
}

/** 替换时钟（门禁用，让冷却窗可被确定性地测试） */
function _setClock(fn) { now = fn || function () { return Date.now(); }; }

module.exports = {
  play, playOk, playBad,
  setMuted, isMuted, reset,
  SOUNDS, COMBO_TIERS, SOFT_AFTER_WRONG, SOFT_VOLUME,
  _setClock
};
