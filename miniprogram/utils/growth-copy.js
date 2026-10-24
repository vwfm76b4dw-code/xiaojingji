/**
 * 增长看板的文案库。
 *
 * ## 为什么单独一个模块
 * ① 文案是最容易被改的东西（老师/家长看一眼就会想调），把它从逻辑里拿出来，
 *    改文案不需要碰任何计算代码；
 * ② 文案**不能硬编码进 WXML** —— 那样想换一句就要动模板，且没法按状态分支。
 *
 * ## 为什么是"按日期确定性挑选"而不是随机
 * 随机在每次 setData 时都会变，同一个页面上文字会**跳来跳去**（渲染一次换一句），
 * 看起来像 bug。按「日期 + 场景」做种子，则：同一天内稳定不变，第二天自动换新。
 * 这个"每天不一样"本身就是留存的一部分 —— 用户第二天回来会看到新句子。
 *
 * ## 文案来源与语气
 * 全部取自 docs/增长机制研究与文案库.md（2026-09-24 研究产出），
 * 遵循三条：短（≤14 字最佳）、有画面感、不说教。
 * 禁止 emoji（项目视觉红线）；答错类文案**只给下一步动作，不指责**。
 */

const dateUtil = require('./date.js');

/** 场景 → 候选句。{n} 是连续天数，{r} 是剩余数量。 */
const COPY = {
  /* 进入看板 */
  hello: ['今天想练几个词', '来都来了，练几个', '今天的状态怎么样', '看一眼就走也行'],

  /* 连胜达成 */
  streakDone: ['连续第 {n} 天，拿下', '今天的打卡，稳了', '又守住了今天',
               '今天的火苗，续上了', '{n} 天，一天没落下', '打卡成功，明天见'],

  /* 连胜即将断（今天还没打卡但连胜还活着） */
  streakRisk: ['今天还差 {r} 个词，别断', '差一点点，连胜就保住', '还差 {r} 张，今晚能行',
               '别让 {n} 天断在今晚', '就剩几个词，撑住', '今晚补上，还来得及'],

  /* 今日目标 */
  goalDone: ['今天的任务，清空了', '全部完成，收工', '今天练完了，明天见',
             '收工，明天继续', '练完了，去玩吧', '完成，今天没白来'],
  goalRemain: ['今天还剩 {r} 个词', '还有 {r} 张，不着急', '再练 {r} 个就达标'],

  /* 连胜里程碑 */
  ms3: ['连续三天，习惯在成形', '三天了，别小看它', '三天的坚持，看得见'],
  ms7: ['一周了，你坚持下来了', '连续七天，很了不起', '一周不断，值得记一笔'],
  ms30: ['三十天，已经成了习惯', '一个月不断，厉害了', '三十天，你比想象中能坚持'],

  /* 断签挽回 —— 不指责，只给下一步 */
  broken: ['从今天重新开始，你背过的 {m} 个词还在',
           '连胜归零了，但累计 {d} 天不会清',
           '重新开始，之前的 {m} 个词没白背'],

  /* 排行榜 */
  rankUp: ['你比上周多背了 {p} 个词', '这周进步明显', '这周的你，比上周强'],
  rankFlat: ['和上周差不多，稳住', '这周保持住了'],
  rankDown: ['这周起步慢，下周追上', '排名暂时靠后，还有时间', '差得不多，加把劲'],

  /* 空态 */
  empty: ['今天没有要复习的词', '词库清空了，休息一下', '都复习完了，等明天',
          '没有到期的词，去学点新的']
};

/** 用日期 + 场景做一个稳定的种子（同一天同一场景恒定，跨天会变） */
function seedOf(scene, today) {
  const s = String(today || '') + '|' + scene;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 取一句文案。
 *
 * @param {string} scene COPY 的键
 * @param {Object} [ctx] 替换 {n} / {r} / {m} / {d} / {p}
 * @param {string} [today] 日期种子（不传则用今天）
 * @returns {string} 场景不存在时返回空串（调用方据此不渲染那一行）
 */
function pick(scene, ctx, today) {
  const list = COPY[scene];
  if (!Array.isArray(list) || !list.length) return '';
  const t = today || dateUtil.todayStr();
  const raw = list[seedOf(scene, t) % list.length];
  const c = ctx || {};
  return raw.replace(/\{(\w+)\}/g, function (m, k) {
    return c[k] === undefined || c[k] === null ? '' : String(c[k]);
  });
}

/** 连胜里程碑该用哪一句（0 = 没有对应文案） */
function milestoneScene(days) {
  const n = Number(days) || 0;
  if (n >= 30) return 'ms30';
  if (n >= 7) return 'ms7';
  if (n >= 3) return 'ms3';
  return '';
}

module.exports = { COPY, pick, milestoneScene, seedOf };
