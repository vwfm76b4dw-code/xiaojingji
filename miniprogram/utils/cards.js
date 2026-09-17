/**
 * 卡片数据访问层 —— 页面拿卡片的**唯一入口**。
 *
 * ## 为什么需要这一层
 * 页面的视角是"只读内容表 + 可变状态表"（便于浏览/复习/统计按卡操作），
 * 而存储层的物理形状是"内容与状态写在同一条记录里"（见 utils/store.js）。
 * 这层只做**投影**：从同一份存储派生出两个视图，不存第二份数据，
 * 因此不存在"两张表不同步"这类问题。
 *
 * ## 与旧实现的关系
 * 内容原先来自打包的 data/batches.js（只读、不可增删）。现在内容可由用户
 * 自己录入/导入教材，所以必须改为从 store 读 —— 否则用户加的词永远不出现在复习里。
 *
 * ## 缓存
 * loadWords() 每次都要过一遍 sanitize 净化，页面 onShow 频繁调用会有点浪费。
 * 这里做一层**按写入失效**的缓存：store 的写操作会调 invalidate()。
 * 不引时间戳轮询 —— 那种"看起来是缓存其实是延迟"的做法会产生难复现的脏读。
 */
const store = require('./store.js');
const SHORT_HOOKS = require('../data/short-hooks.js');

let _cards = null;
let _states = null;

/** 作废缓存。store 的任何写操作后都要调用（或由页面在写后显式调用 refresh） */
function invalidate() {
  _cards = null;
  _states = null;
}

/** 全部卡片（只读内容视图）。返回的数组可安全传阅，不会被内部修改 */
function allCards() {
  if (_cards === null) _cards = store.loadCards();
  return _cards;
}

/** 全部学习状态 map：{ [cardId]: {ef, reps, interval, nextReview, history} } */
function allStates() {
  if (_states === null) _states = store.loadStates();
  return _states;
}

/** 按 id 取一张卡（找不到返回 null） */
function getCard(id) {
  const list = allCards();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/** 取某张卡的状态；没学过返回 null（页面据此区分"新卡"与"已学"） */
function getState(id) {
  return allStates()[id] || null;
}

/**
 * 写回一张卡的状态。返回 { ok } —— ok=false 表示写盘失败。
 *
 * ⚠️ 页面必须检查返回值。不检查的后果：用户点了"认识"、界面推进到下一张，
 * 但进度根本没落盘，重启后这个词又从零开始 —— 而且没有任何提示。
 * （这正是 review 页比 study 页更严谨的地方，合并时保留了严格版。）
 */
function setState(id, st) {
  const ok = store.setState(id, st);
  if (ok) {
    // 只更新缓存里的这一条，避免整表重读
    if (_states) _states[id] = st;
  } else {
    invalidate();
  }
  return { ok: !!ok };
}

/** 批量写回状态。返回 { ok, count } */
function setStates(map) {
  const n = store.setStates(map);
  if (n > 0 && _states) {
    Object.keys(map).forEach(function (id) { _states[id] = map[id]; });
  } else {
    invalidate();
  }
  return { ok: n > 0, count: n };
}

/** 学科列表（含卡片数） */
function subjects() {
  const map = {};
  allCards().forEach(function (c) {
    const s = c.subject || '英语';
    map[s] = (map[s] || 0) + 1;
  });
  return Object.keys(map).map(function (s) { return { subject: s, count: map[s] }; })
    .sort(function (a, b) { return b.count - a.count; });
}

module.exports = {
  invalidate, allCards, allStates, getCard, getState,
  setState, setStates, subjects
};
