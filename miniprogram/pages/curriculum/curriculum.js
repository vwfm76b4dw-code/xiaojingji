/**
 * 教材词库导入页 —— 两级：先选一册教材，再挑这册里的单元。
 *
 * 20 册教材都在包里，但**只按需加载**：
 *   册次列表（书名 + 词数）来自 utils/curriculum-books.js 的注册表（不含词表），
 *   学生点开哪册才 require 哪册 —— 不进这页就把 5188 个词全读进内存的事，这里挡掉了。
 *
 * ⚠️ 导入路径**必须绕开 ai-core / aiProxy 的 normalizeItems()**：
 *   那里的 WORD_RE 有"最多 3 个词"的上限，是为挡住模型把整句英文当单词返回而设的。
 *   教材里有 18 条合法多词短语（as dead as a dodo / stop someone from doing something…），
 *   套上会被**静默丢弃** —— 不报错、不进 skipped、界面上什么都看不到。
 *   所以这里直接构造 [{word, meaning}] 交给 store.addItems()。
 *   store.addItems 本身只校验 word/meaning 非空 + 按 word 查重，不做 WORD_RE 校验。
 *
 * 数据背景：旧版 19 册曾被排除出包（抓取管线有 36 条错义，如 PE→"Peru 秘鲁"），
 *   经 tools/clean-curriculum.js 清洗后已全部放行（2026-09-17）。
 *   它们没有 unit 字段，整册收进「全部单词」一个格子。
 */
const store = require('../../utils/store.js');
const cards = require('../../utils/cards.js');
const books = require('../../utils/curriculum-books.js');

/** 记住上次选的册：学生下次进来直接落到那一册，不用每次重选 */
const LAST_BOOK_KEY = 'curriculum_last_book';

/** 词库里已有词与本次要导入词的重合率超过这个数，就认定"这一册已经导入过" */
const IMPORTED_RATIO = 0.9;

/** 没有 unit 字段的册（19 册旧版词书）：整册归到一个格子，学生看到的不是空白行 */
const WHOLE_BOOK_UNIT = '全部单词';

/** 教材条目 → 词条：释义带词性前缀（pos 非空时），如「n. 教科书, 教材, 课本」 */
function toItem(w) {
  const pos = String(w.pos || '').trim();
  const meaning = String(w.meaning || '').trim();
  return {
    word: String(w.word || '').trim(),
    meaning: pos ? pos + ' ' + meaning : meaning
  };
}

/** 词条属于哪个单元（两种情况归一处理，选单元时按同一个函数比对） */
function unitNameOf(w) {
  return String((w && w.unit) || '').trim() || WHOLE_BOOK_UNIT;
}

function readLastBook() {
  try {
    const v = wx.getStorageSync(LAST_BOOK_KEY);
    return typeof v === 'string' ? v : '';
  } catch (e) {
    // 读不到就当没选过，退回册次列表 —— 不该因此拦住学生
    console.warn('[curriculum] 读取上次选的册失败', e);
    return '';
  }
}

function saveLastBook(id) {
  try {
    wx.setStorageSync(LAST_BOOK_KEY, id);
  } catch (e) {
    // 记不住只是下次要重选一次，不影响导入，不打扰学生
    console.warn('[curriculum] 记录上次选的册失败', e);
  }
}

Page({
  data: {
    stage: 'books',     // 'books' 选册（第一级） | 'units' 选单元（第二级）
    books: [],          // 第一级列表：[{ id, name, count }]，已按年级排好
    book: '',           // 第二级：当前那册的书名
    total: 0,
    units: [],          // [{ name, count, picked }]
    pickedCount: 0,     // 已选单元的词数合计
    allPicked: false,
    nonePicked: true
  },

  onLoad() {
    // 词表放在实例上而不是 data 里：一册最多 540 词，塞进 data 会被 setData
    // 整个序列化一遍，而界面只用到单元名和词数。
    this.words = [];
    this.setData({ books: books.list() });

    // 上次选过就直达那一册；记的那册若已不在册次表里（数据换过），安静退回列表
    const last = readLastBook();
    if (last && books.has(last)) this.openBookById(last);
  },

  /** 第一级：点一本教材 */
  openBook(e) {
    this.openBookById(String(e.currentTarget.dataset.id || ''));
  },

  openBookById(id) {
    let data = null;
    try {
      data = books.load(id);
    } catch (e) {
      console.error('[curriculum] 打开教材失败', id, e);
    }
    const words = (data && Array.isArray(data.words)) ? data.words : [];
    if (words.length === 0) {
      wx.showToast({ title: '这本教材暂时打不开', icon: 'none' });
      return;
    }

    const order = [];
    const countOf = {};
    words.forEach(function (w) {
      const name = unitNameOf(w);
      if (!countOf[name]) { countOf[name] = 0; order.push(name); }
      countOf[name]++;
    });

    this.words = words;
    this.setData({
      stage: 'units',
      book: String(data.book || ''),
      total: words.length,
      units: order.map(function (name) { return { name: name, count: countOf[name], picked: false }; }),
      pickedCount: 0,
      allPicked: false,
      nonePicked: true
    });
    saveLastBook(id);
  },

  /** 第二级：回第一级换一册 */
  backToBooks() {
    this.words = [];
    this.setData({
      stage: 'books',
      book: '',
      total: 0,
      units: [],
      pickedCount: 0,
      allPicked: false,
      nonePicked: true
    });
  },

  toggleUnit(e) {
    const i = Number(e.currentTarget.dataset.i);
    const units = this.data.units.slice();
    if (!units[i]) return;
    units[i] = { name: units[i].name, count: units[i].count, picked: !units[i].picked };
    this.applyUnits(units);
  },

  selectAll() {
    this.applyUnits(this.data.units.map((u) => ({ name: u.name, count: u.count, picked: true })));
  },

  clearAll() {
    this.applyUnits(this.data.units.map((u) => ({ name: u.name, count: u.count, picked: false })));
  },

  /** 统一在选完单元后重算派生状态，避免三处各写一遍 */
  applyUnits(units) {
    const picked = units.filter((u) => u.picked);
    this.setData({
      units: units,
      pickedCount: picked.reduce((sum, u) => sum + u.count, 0),
      allPicked: units.length > 0 && picked.length === units.length,
      nonePicked: picked.length === 0
    });
  },

  doImport() {
    const pickedNames = this.data.units.filter((u) => u.picked).map((u) => u.name);
    if (pickedNames.length === 0) {
      wx.showToast({ title: '先选一个单元', icon: 'none' });
      return;
    }

    const items = [];
    this.words.forEach((w) => {
      if (pickedNames.indexOf(unitNameOf(w)) === -1) return;
      items.push(toItem(w));
    });

    // 导入前先看这一册是不是早就在词库里了：是就直说，不报"跳过 N 个"。
    // 首次启动已预置七上 295 词，学生再选同一册时，旧文案会变成
    // 「已导入 1 个词，跳过 294 个」—— 看着像出错，其实只是老词重来一遍。
    // 重合率超过九成即视为"已经导过"（可能还剩个别新词，也不值得让学生重来）。
    const inLib = {};
    store.loadWords().forEach(function (w) { inLib[String(w.word).toLowerCase()] = 1; });
    const hit = items.filter(function (it) { return inLib[it.word.toLowerCase()]; }).length;
    if (items.length > 0 && hit / items.length > IMPORTED_RATIO) {
      wx.showToast({ title: '这一册的词已经在你的词库里了', icon: 'none', duration: 1600 });
      return;
    }

    const r = store.addItems(items);
    if (!r.ok) {
      // 与 add.js 的 saveBatch / confirmAiItems 同口径：写盘失败 / 全在词库里 / 没有可用条目。
      // 本页最不能把"写盘失败"说成"这些词都已经在词库里了"：一次写几百条最容易撞配额，
      // 而那句提示会让用户以为早就导过了，直接走人 —— 一个词都没进去。
      let title = '没有可导入的词条';
      if (r.saveFailed) title = '保存失败，请重试';
      else if (r.dupSkipped > 0 && r.dupSkipped === r.skipped.length) title = '这些词都已经在词库里了';
      wx.showToast({ title: title, icon: 'none' });
      return;
    }

    let msg = '已导入 ' + r.added + ' 个词';
    if (r.skipped.length > 0) msg += '，跳过 ' + r.skipped.length + ' 个';
    cards.invalidate();          // 让卡片缓存看到新词，否则返回列表看不到刚导入的内容
    wx.showToast({ title: msg, icon: 'none', duration: 1600 });

    // 导入成功后清空选择，给一个"这次已经处理完"的收尾
    this.applyUnits(this.data.units.map((u) => ({ name: u.name, count: u.count, picked: false })));
  }
});
