/**
 * 教材册次注册表 —— 20 册「id → 按需加载」映射。
 *
 * 为什么把 require 写进函数体，而不是在文件顶层 require 20 册：
 *   小程序打包时会把 require 到的 JSON 全部内联进包 —— 这正是我们要的，
 *   20 册都随包走，学生点什么都不用等网络。但**执行** require 会把 JSON
 *   解析成内存对象，顶层写 20 个 require 就等于每次进教材页都把 5188 个词
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
 */

/** 同年级排序用：上册 0 → 下册 1 → 全一册 2（只影响顺序，不展示给学生） */
function termRank(name) {
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
 * 20 册全集。书写顺序 = 同年级同册别时的稳定次序（先外研、再北师大、再北京版），
 * 展示顺序统一由下面的排序决定：年级 g1→g9，同年级先上后下。
 */
const BOOKS = [
  { id: 'bj1s', name: '北京版小学英语一年级上册', grade: 'g1', count: 169,
    load: function () { return require('../data/curriculum/bj1s.json'); } },
  { id: 'kj3x', name: '北京课改版英语三年级下册', grade: 'g3', count: 66,
    load: function () { return require('../data/curriculum/kj3x.json'); } },
  { id: 'kj4s', name: '北京课改版英语四年级上册', grade: 'g4', count: 66,
    load: function () { return require('../data/curriculum/kj4s.json'); } },
  { id: 'kj4x', name: '北京课改版英语四年级下册', grade: 'g4', count: 61,
    load: function () { return require('../data/curriculum/kj4x.json'); } },
  { id: 'kj5s', name: '北京课改版英语五年级上册', grade: 'g5', count: 67,
    load: function () { return require('../data/curriculum/kj5s.json'); } },
  { id: 'kj5x', name: '北京课改版英语五年级下册', grade: 'g5', count: 64,
    load: function () { return require('../data/curriculum/kj5x.json'); } },
  { id: 'kj6s', name: '北京课改版英语六年级上册', grade: 'g6', count: 68,
    load: function () { return require('../data/curriculum/kj6s.json'); } },
  { id: 'kj6x', name: '北京课改版英语六年级下册', grade: 'g6', count: 71,
    load: function () { return require('../data/curriculum/kj6x.json'); } },

  { id: 'wy7s_2024', name: '外研版2024新版初中英语七年级上册', grade: 'g7', count: 295,
    load: function () { return require('../data/curriculum/wy7s_2024.json'); } },
  { id: 'wy7s', name: '外研版初中英语七年级上册', grade: 'g7', count: 453,
    load: function () { return require('../data/curriculum/wy7s.json'); } },
  { id: 'wy7x', name: '外研版初中英语七年级下册', grade: 'g7', count: 423,
    load: function () { return require('../data/curriculum/wy7x.json'); } },
  { id: 'bsd7s', name: '北师大版初中英语七年级上册', grade: 'g7', count: 540,
    load: function () { return require('../data/curriculum/bsd7s.json'); } },
  { id: 'bsd7x', name: '北师大版初中英语七年级下册', grade: 'g7', count: 494,
    load: function () { return require('../data/curriculum/bsd7x.json'); } },

  { id: 'wy8s', name: '外研版初中英语八年级上册', grade: 'g8', count: 313,
    load: function () { return require('../data/curriculum/wy8s.json'); } },
  { id: 'wy8x', name: '外研版初中英语八年级下册', grade: 'g8', count: 262,
    load: function () { return require('../data/curriculum/wy8x.json'); } },
  { id: 'bsd8s', name: '北师大版初中英语八年级上册', grade: 'g8', count: 389,
    load: function () { return require('../data/curriculum/bsd8s.json'); } },
  { id: 'bsd8x', name: '北师大版初中英语八年级下册', grade: 'g8', count: 390,
    load: function () { return require('../data/curriculum/bsd8x.json'); } },

  { id: 'wy9s', name: '外研版初中英语九年级上册', grade: 'g9', count: 375,
    load: function () { return require('../data/curriculum/wy9s.json'); } },
  { id: 'wy9x', name: '外研版初中英语九年级下册', grade: 'g9', count: 127,
    load: function () { return require('../data/curriculum/wy9x.json'); } },
  { id: 'bsd9', name: '北师大版初中英语九年级全一册', grade: 'g9', count: 495,
    load: function () { return require('../data/curriculum/bsd9.json'); } }
];

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
  /** 展示用的册次列表（已排好序）：[{ id, name, grade, count }] */
  list: function () {
    return ORDERED.map(function (b) {
      return { id: b.id, name: b.name, grade: b.grade, count: b.count };
    });
  },

  /** 这个 id 是不是我们认识的册 */
  has: function (id) { return !!find(id); },

  /** 取一册的完整内容（点开时才真正加载）；id 不认识返回 null */
  load: function (id) {
    const hit = find(id);
    return hit ? hit.load() : null;
  }
};
