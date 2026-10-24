/**
 * 教材册次注册表 —— 32 册「id → 按需加载」映射。
 *
 * 为什么把 require 写进函数体，而不是在文件顶层 require 全部册次：
 *   小程序打包时会把 require 到的 JSON 全部内联进包 —— 这正是我们要的，
 *   24 册都随包走，学生点什么都不用等网络。但**执行** require 会把 JSON
 *   解析成内存对象，顶层写 24 个 require 就等于每次进教材页都把 5550 个词
 *   全读进内存（首屏变慢、白占内存）。
 *   写进函数后，require 只在点开那一册时才执行，内存里只留打开过的册；
 *   同一册重复打开走 require 缓存，不会再解析第二遍。
 *
 * 元数据（name / grade / count）的唯一权威是各 JSON 的 book / grade / count 字段，
 * 本表原样镜像它们。数据文件若重新生成，跑 node tools/verify-pages.js 的册次用例
 * （逐册比对 name / count / grade 与 JSON 实际值）即可发现不一致。
 *
 * ⚠️ 这里只放元数据 + 加载函数，**不要放 words** —— 那会把全量词表又拖回内存，
 *    本文件存在的意义就没了。
 *
 * 数据背景：旧版 19 册曾被排除出包（koolearn 抓取管线产生 36 条错义，
 * 如 PE→"Peru 秘鲁"）。2026-09-17 经 tools/clean-curriculum.js 清洗后已全部放行，
 * 详见同目录 README。它们的词条没有 unit / pos 字段，导入页会把整册收进
 * 「全部单词」一个格子。
 *
 * 2026-09-25 替换（Agent B）：北京版 4 册 + 北京课改版 8 册（bj1s…kj6x，994 词）
 * 全部下架 —— 换成外研社版小学英语（三年级起点）8 册 1184 词。
 * 为什么是三起点而不是一起点：本项目保留的外研版初中 7 册（wy7s…wy9x）是
 * 三起点教材，小学三起点（3上→6下）与初中在**同一条教材轨道**上顺次衔接，
 * 一起点则是另一条轨道，混放会让学生背两套体系。替换后 g1/g2 没有册次 ——
 * 这是三起点教材体系的天然边界（三年级才开英语课），不是数据缺失。
 * 2026-09-25 补全（Agent 教材域）：注册表 20 册 → 32 册。
 *   ① 新增 外研版2024新版初中七年级下册（wy7x_2024，376 词）—— 学生手里的
 *      下一册书（2026 春学期用）。2024 新版初中其余各册（八上/八下/九上/九下）
 *      的可靠词源 51jiaoxi/koolearn 均未上线，暂缺（见构建脚本诚实边界注释）。
 *   ② 新增 外研版小学英语一年级起点 11 册（wy1s_qy…wy6x_qy，957 词去重）——
 *      一起点是与三起点**并行的另一条轨道**，不是同一套书的低年级段；
 *      一并放进包里，一年级开英语课的孩子也有书可选。id 后缀 _qy（起一）：
 *      三起点已占用 wy3s…wy6x，两轨从三年级起撞 id。一起三下无源（站点别名
 *      到三起(新)三下），故 11 册而非 12 册。
 *   ③ wy7s_2024 钩子回填 + 置信度升 high（双源互证）；wy3x 单元名修复。
 *   数据来源与置信度记录在各 JSON 的 _source / _confidence 字段，
 *   生产脚本 tools/build-expand2026.py（主源 51jiaoxi 朗读宝，抓取脚本
 *   tools/fetch-jjx-books.py）。
 * ⚠️ 被替换的 12 册学生的旧数据仍可删除：见 RETIRED_BOOKS。
 */

/**
 * 已下架册次的书名（2026-09-25 被外研社版替换的 12 册）。
 *
 * 为什么只留书名、不留加载函数：下架册不再提供词表（.json/.js 都已移出包），
 * 但导入过这些册的学生的词库里，词条 unit 还带着这些书名前缀 ——
 * 教材管理页必须能认出并整册删掉它们，否则"导入过的书在管理列表里消失、删不掉"
 * 这个用户报过的事故会原样复发（buildManaged 按前缀反查册名）。
 * 管理页按前缀聚合与删除都只需要名字，所以这里只需要书名清单。
 */
const RETIRED_BOOK_NAMES = [
  '北京版小学英语一年级上册', '北京版小学英语一年级下册',
  '北京版小学英语二年级上册', '北京版小学英语二年级下册',
  '北京课改版英语三年级上册', '北京课改版英语三年级下册',
  '北京课改版英语四年级上册', '北京课改版英语四年级下册',
  '北京课改版英语五年级上册', '北京课改版英语五年级下册',
  '北京课改版英语六年级上册', '北京课改版英语六年级下册'
];

/** 同年级排序用：上册 0 → 下册 1 → 全一册 2（只影响顺序，不展示给学生） */function termRank(name) {
  if (name.indexOf('上册') !== -1) return 0;
  if (name.indexOf('下册') !== -1) return 1;
  return 2;
}

/** 'g7' → 7；解析不出来按 0（排最前，不会被藏起来） */
function gradeNum(grade) {
  const n = Number(String(grade || '').replace(/^g/, ''));
  return isFinite(n) ? n : 0;
}

/**
 * 32 册全集（2026-09-25 起）。三个轨道各有天然边界：
 *   一起点小学（wy1s_qy…wy6x_qy，g1→g6，缺一起三下 —— 无源，非漏做）
 *   三起点小学（wy3s…wy6x，g3→g6 —— 三年级才开英语课）
 *   初中（wy7s_2024/wy7s…wy9x + 北师大 5 册，g7→g9）
 * 展示顺序统一由下面的排序决定：年级 g1→g9，同年级先上后下。
 */
const BOOKS = [
  { id: 'wy1s_qy', name: '外研版小学英语一年级上册（一年级起点）', grade: 'g1', count: 128,
    load: function () { return require('../data/curriculum/wy1s_qy.js'); } },
  { id: 'wy1x_qy', name: '外研版小学英语一年级下册（一年级起点）', grade: 'g1', count: 109,
    load: function () { return require('../data/curriculum/wy1x_qy.js'); } },
  { id: 'wy2s_qy', name: '外研版小学英语二年级上册（一年级起点）', grade: 'g2', count: 115,
    load: function () { return require('../data/curriculum/wy2s_qy.js'); } },
  { id: 'wy2x_qy', name: '外研版小学英语二年级下册（一年级起点）', grade: 'g2', count: 110,
    load: function () { return require('../data/curriculum/wy2x_qy.js'); } },
  { id: 'wy3s_qy', name: '外研版小学英语三年级上册（一年级起点）', grade: 'g3', count: 81,
    load: function () { return require('../data/curriculum/wy3s_qy.js'); } },
  { id: 'wy4s_qy', name: '外研版小学英语四年级上册（一年级起点）', grade: 'g4', count: 109,
    load: function () { return require('../data/curriculum/wy4s_qy.js'); } },
  { id: 'wy4x_qy', name: '外研版小学英语四年级下册（一年级起点）', grade: 'g4', count: 78,
    load: function () { return require('../data/curriculum/wy4x_qy.js'); } },
  { id: 'wy5s_qy', name: '外研版小学英语五年级上册（一年级起点）', grade: 'g5', count: 79,
    load: function () { return require('../data/curriculum/wy5s_qy.js'); } },
  { id: 'wy5x_qy', name: '外研版小学英语五年级下册（一年级起点）', grade: 'g5', count: 71,
    load: function () { return require('../data/curriculum/wy5x_qy.js'); } },
  { id: 'wy6s_qy', name: '外研版小学英语六年级上册（一年级起点）', grade: 'g6', count: 61,
    load: function () { return require('../data/curriculum/wy6s_qy.js'); } },
  { id: 'wy6x_qy', name: '外研版小学英语六年级下册（一年级起点）', grade: 'g6', count: 91,
    load: function () { return require('../data/curriculum/wy6x_qy.js'); } },

  { id: 'wy3s', name: '外研版2024新版小学英语三年级上册（三年级起点）', grade: 'g3', count: 206,
    load: function () { return require('../data/curriculum/wy3s.js'); } },
  { id: 'wy3x', name: '外研版2024新版小学英语三年级下册（三年级起点）', grade: 'g3', count: 197,
    load: function () { return require('../data/curriculum/wy3x.js'); } },
  { id: 'wy4s', name: '外研版小学英语四年级上册（三年级起点）', grade: 'g4', count: 145,
    load: function () { return require('../data/curriculum/wy4s.js'); } },
  { id: 'wy4x', name: '外研版小学英语四年级下册（三年级起点）', grade: 'g4', count: 130,
    load: function () { return require('../data/curriculum/wy4x.js'); } },
  { id: 'wy5s', name: '外研版小学英语五年级上册（三年级起点）', grade: 'g5', count: 150,
    load: function () { return require('../data/curriculum/wy5s.js'); } },
  { id: 'wy5x', name: '外研版小学英语五年级下册（三年级起点）', grade: 'g5', count: 146,
    load: function () { return require('../data/curriculum/wy5x.js'); } },
  { id: 'wy6s', name: '外研版小学英语六年级上册（三年级起点）', grade: 'g6', count: 106,
    load: function () { return require('../data/curriculum/wy6s.js'); } },
  { id: 'wy6x', name: '外研版小学英语六年级下册（三年级起点）', grade: 'g6', count: 104,
    load: function () { return require('../data/curriculum/wy6x.js'); } },

  { id: 'wy7s_2024', name: '外研版2024新版初中英语七年级上册', grade: 'g7', count: 295,
    load: function () { return require('../data/curriculum/wy7s_2024.js'); } },
  { id: 'wy7x_2024', name: '外研版2024新版初中英语七年级下册', grade: 'g7', count: 376,
    load: function () { return require('../data/curriculum/wy7x_2024.js'); } },
  { id: 'wy7s', name: '外研版初中英语七年级上册', grade: 'g7', count: 453,
    load: function () { return require('../data/curriculum/wy7s.js'); } },
  { id: 'wy7x', name: '外研版初中英语七年级下册', grade: 'g7', count: 423,
    load: function () { return require('../data/curriculum/wy7x.js'); } },
  { id: 'bsd7s', name: '北师大版初中英语七年级上册', grade: 'g7', count: 540,
    load: function () { return require('../data/curriculum/bsd7s.js'); } },
  { id: 'bsd7x', name: '北师大版初中英语七年级下册', grade: 'g7', count: 494,
    load: function () { return require('../data/curriculum/bsd7x.js'); } },

  { id: 'wy8s', name: '外研版初中英语八年级上册', grade: 'g8', count: 313,
    load: function () { return require('../data/curriculum/wy8s.js'); } },
  { id: 'wy8x', name: '外研版初中英语八年级下册', grade: 'g8', count: 262,
    load: function () { return require('../data/curriculum/wy8x.js'); } },
  { id: 'bsd8s', name: '北师大版初中英语八年级上册', grade: 'g8', count: 389,
    load: function () { return require('../data/curriculum/bsd8s.js'); } },
  { id: 'bsd8x', name: '北师大版初中英语八年级下册', grade: 'g8', count: 390,
    load: function () { return require('../data/curriculum/bsd8x.js'); } },

  { id: 'wy9s', name: '外研版初中英语九年级上册', grade: 'g9', count: 375,
    load: function () { return require('../data/curriculum/wy9s.js'); } },
  { id: 'wy9x', name: '外研版初中英语九年级下册', grade: 'g9', count: 127,
    load: function () { return require('../data/curriculum/wy9x.js'); } },
  { id: 'bsd9', name: '北师大版初中英语九年级全一册', grade: 'g9', count: 495,
    load: function () { return require('../data/curriculum/bsd9.js'); } }
];

/** 在架书名集合：isManagedName 的快速查询用 */
const bookNameSet = (function () {
  const s = Object.create(null);
  BOOKS.forEach(function (b) { s[b.name] = true; });
  return s;
})();

/** 排好序的展示序列（模块加载时排一次，调用方直接拿） */
const ORDERED = BOOKS.map(function (b, i) { return { b: b, i: i }; })
  .sort(function (x, y) {
    const gx = gradeNum(x.b.grade);
    const gy = gradeNum(y.b.grade);
    if (gx !== gy) return gx - gy;                       // 年级 g1 → g9
    const tx = termRank(x.b.name);
    const ty = termRank(y.b.name);
    if (tx !== ty) return tx - ty;                       // 同年级：上 → 下 → 全一册
    return x.i - y.i;                                    // 其余保持注册表次序，结果稳定可预期
  })
  .map(function (x) { return x.b; });

function find(id) {
  for (let i = 0; i < BOOKS.length; i++) {
    if (BOOKS[i].id === id) return BOOKS[i];
  }
  return null;
}

module.exports = {
  /**
   * 展示用的册次列表（已排好序）：
   * [{ id, name, grade, count, section, isNew }]
   * section：书目选择器按学段/轨道分组展示用的标签 —— 'yq' 一起点小学 /
   * 'sq3' 三起点小学 / 'junior' 初中。分组依据是轨道而不是只看年级：
   * 一起点与三起点在 g3-g6 并行，单按年级分两组会把两轨的书混在一起，
   * 学生找不到自己那套。
   * isNew：2024 课标新版（书名含「2024新版」），选择器上打「新」角标。
   */
  list: function () {
    return ORDERED.map(function (b) {
      const n = gradeNum(b.grade);
      return {
        id: b.id, name: b.name, grade: b.grade, count: b.count,
        section: n >= 7 ? 'junior' : (b.id.indexOf('_qy') !== -1 ? 'yq' : 'sq3'),
        isNew: b.name.indexOf('2024新版') !== -1
      };
    });
  },

  /** 这个 id 是不是我们认识的册 */
  has: function (id) { return !!find(id); },

  /** 取一册的完整内容（点开时才真正加载）；id 不认识返回 null */
  load: function (id) {
    const hit = find(id);
    return hit ? hit.load() : null;
  },

  /** 这个书名是不是"在架或已下架"的教材（教材管理页按 unit 前缀聚合时用） */
  isManagedName: function (name) {
    if (bookNameSet[name]) return true;
    for (let i = 0; i < RETIRED_BOOK_NAMES.length; i++) {
      if (RETIRED_BOOK_NAMES[i] === name) return true;
    }
    return false;
  },

  /** 这个书名是不是已下架册（下架册不再提供导入，只允许删除） */
  isRetiredName: function (name) {
    return RETIRED_BOOK_NAMES.indexOf(name) !== -1;
  }
};
