/**
 * 教材词库导入页 —— 两级：先选一册教材，再挑这册里的单元。
 *
 * 20 册教材都在包里，但**只按需加载**：
 *   册次列表（书名 + 词数）来自 utils/curriculum-books.js 的注册表（不含词表），
 *   学生点开哪册才 require 哪册 —— 不进这页就把 6000+ 个词全读进内存的事，这里挡掉了。
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
 *   2026-09-25：北京版 4 册 + 北京课改版 8 册下架，换入外研社版小学 8 册（带 unit 与
 *   mnemonic 钩子）。下架册的学生旧数据仍可在管理页删除（见 isManagedName / RETIRED）。
 */
/**
 * ⚠️ 跨包引用要**多数一层**（2026-09-24 搬进分包时踩到的坑）：
 *   本文件在 pack-curriculum/pages/curriculum/ 下，
 *   `../../` 只到 pack-curriculum/，`../../../` 才回到包根。
 *   写成 `../../utils/store.js` 不会报错，只会解析到一个不存在的路径 ——
 *   编译期未必拦得住，真机上就是"点开教材页白屏"。
 *   store / cards 属于主包（分包**可以** require 主包，只是路径要写对）。
 *   教材注册表 curriculum-books.js 已随包搬过来，故仍是 `../../`。
 */
const store = require('../../../utils/store.js');
const cards = require('../../../utils/cards.js');
const books = require('../../utils/curriculum-books.js');

/** 记住上次选的册：学生下次进来直接落到那一册，不用每次重选 */
const LAST_BOOK_KEY = 'curriculum_last_book';

/** 词库里已有词与本次要导入词的重合率超过这个数，就认定"这一册已经导入过" */
const IMPORTED_RATIO = 0.9;

/** 没有 unit 字段的册（19 册旧版词书）：整册归到一个格子，学生看到的不是空白行 */
const WHOLE_BOOK_UNIT = '全部单词';

/**
 * 用户重命名的本地映射（key = 原册名，value = 显示名）。
 *
 * ## 为什么重命名不直接改词条的 unit 前缀（TODO-5 的设计陷阱）
 * unit 前缀是三件事的承重结构：
 *   ① buildManaged() 用 `unit.split(' · ')[0]` 反查册名，并要求命中注册表 ——
 *      改了前缀，这本书就从管理列表里消失（用户报过"删不掉"的同一机制）；
 *   ② deleteBook 按前缀整册删词 —— 改了前缀，旧前缀的词一个都删不掉；
 *   ③ buildManaged 的注册表校验同时挡着"预置 295 词的 unit='7A Unit N' 不算一册"，
 *      放宽它会让所有无前缀单元混进管理列表。
 * 所以重命名只写这个映射：聚合与删除仍走原前缀，只有**显示名**变化。
 * 取舍：改名只存在本机（不同步、换设备失效）——对单机应用这是可接受的成本，
 * 换来的是零迁移（1000+ 条已导入词一条都不用改写，不会写坏历史数据）。
 */
const BOOK_META_KEY = 'curriculum_book_meta';

/** 显示名长度上限：册名行是一行文本，超长会顶掉词数徽标 */
const DISPLAY_NAME_MAX = 24;

function readBookMeta() {
  try {
    const v = wx.getStorageSync(BOOK_META_KEY);
    // 只接受普通对象：存坏/存成数组的旧数据一律当"没改过名"，不让异常数据进页面
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) {
    // 读不到就当没改过名：重命名是锦上添花，不能因此拦住管理页
    console.warn('[curriculum] 读取重命名映射失败', e);
    return {};
  }
}

function saveBookMeta(meta) {
  try {
    wx.setStorageSync(BOOK_META_KEY, meta);
  } catch (e) {
    // 存不进去只影响显示名（下次进来回到原名），不提示打断学生
    console.warn('[curriculum] 保存重命名映射失败', e);
  }
}

/**
 * 教材条目 → 词条：释义带词性前缀（pos 非空时），如「n. 教科书, 教材, 课本」。
 *
 * 2026-09-18 修：**unit 必须一起带走**。
 * 原来只取 word + meaning，把单元扔了 —— 而学生导入教材的真实目的往往是
 * "我要背 Unit 2 这一单元"，单元信息一丢，导入后就再也筛不出单元了。
 * （同文件的 unitNameOf() 明明知道单元是什么，导入时却被丢弃。）
 */
function toItem(w) {
  const pos = String(w.pos || '').trim();
  const meaning = String(w.meaning || '').trim();
  const unit = String(w.unit || '').trim();
  const item = {
    word: String(w.word || '').trim(),
    meaning: pos ? pos + ' ' + meaning : meaning
  };
  // 旧版 19 册没有 unit：不写空串，保持"字段不存在"这一种空态
  if (unit) item.unit = unit;
  // 2026-09-25 起：外研社新册每词自带 mnemonic（记忆钩子）。store.addItems 会读
  // raw.mnemonic 落库，toCard 把它映射成 hook —— 缺这一行，钩子就在导入时被丢掉。
  const mnemonic = String(w.mnemonic || '').trim();
  if (mnemonic) item.mnemonic = mnemonic;
  return item;
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
    managed: [],   // 已导入的册 [{id,name,count,ids}]
    stage: 'books',     // 'books' 选册（第一级） | 'units' 选单元（第二级）
    books: [],          // 第一级平铺列表（供头部计数）
    bookGroups: [],     // 第一级分组列表：[{ label, books: [{id,name,count,isNew}] }]
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
    const list = books.list();
    // 按轨道分组展示（注册表 list() 已给出 section 字段）：
    // 一起点与三起点在 g3-g6 是两条并行的教材轨道，只按年级排平铺的话，
    // 一年级的孩子要滚过十几册初中书才找到自己的册 —— 分组是找书的路标。
    const SECTION_LABELS = [
      { key: 'yq', label: '小学 · 一年级起点' },
      { key: 'sq3', label: '小学 · 三年级起点' },
      { key: 'junior', label: '初中' }
    ];
    this.setData({
      books: list,
      bookGroups: SECTION_LABELS.map(function (s) {
        return {
          label: s.label,
          books: list.filter(function (b) { return b.section === s.key; })
        };
      }).filter(function (g) { return g.books.length > 0; })
    });
    this.buildManaged();

    // 上次选过就直达那一册；记的那册若已不在册次表里（数据换过），安静退回列表
    const last = readLastBook();
    if (last && books.has(last)) this.openBookById(last);
  },

  /** 第一级：点一本教材 */
  /**
   * 教材管理：统计每册已导入词数（按"该册词表 ∩ 词库"计算）。
   * 已导入的册在这里可以整册移除 —— "导入"有入口，"移除"也得有，
   * 否则导错一册只能一个词一个词地删。
   */
  /**
   * 教材管理（2026-09-19 加）：已导入的册 → 按 unit 前缀分组统计，可整册移除。
   *
   * 为什么按 unit 前缀而不是按册模块匹配：onLoad 加载全部册词表会破坏
   * "点开才加载"的按需设计（门禁明确拦这个）。导入时 unit 统一带册名前缀
   *（"册名 · 上半/下半" 或教材自带单元名），用前缀聚合零加载成本。
   * 前缀要命中 isManagedName（在架 + 已下架册名）才算"教材"：预置 295 词的
   * unit 是 "7A Starter/7A Unit N" 这类单元名，不算一册，不进管理列表；
   * 已下架册（如 2026-09-25 替换掉的北京版 12 册）虽不再提供导入，
   * 学生词库里的旧数据仍要能看到、能删除 —— 不认它们就是"幽灵书"复发。
   *
   * 2026-09-25 修：聚合时机。原来只在 onLoad 算一次 —— 学生导入后点「换一册」
   * 回到列表页，刚导入的册不会出现（也删不掉），要退出重进才能看到。
   * 这正是用户报的"书加不进管理列表"的残余形态。现在 backToBooks 与
   * doImport 成功后都刷新（聚合只扫本地存储，开销可忽略）。
   */
  buildManaged() {
    this.normalizeBareUnits();
    const meta = readBookMeta();
    const groups = {};
    store.loadWords().forEach(function (w) {
      const unit = String(w.unit || '').trim();
      if (!unit) return;
      const book = unit.split(' · ')[0];
      if (!books.isManagedName(book)) return;
      const g = groups[book] || (groups[book] = { name: book, count: 0, units: {} });
      g.count++;
      g.units[unit] = (g.units[unit] || 0) + 1;
    });
    const managed = Object.keys(groups).map(function (name) {
      const g = groups[name];
      const display = meta[name] && meta[name].displayName ? meta[name].displayName : name;
      return {
        origName: name,            // 删除/聚合的键：永远指向 unit 前缀，不受改名影响
        name: display,             // 展示名：用户改过就显示改名
        count: g.count,
        units: Object.keys(g.units),
        retired: books.isRetiredName(name)   // 下架册在界面上要能看出来"不再提供导入"
      };
    }).sort(function (a, b) {
      // 下架册沉底：它们不能导入，长期占着"在架册"前面会误导
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      return b.count - a.count;
    });
    this.setData({ managed: managed, hasRetired: managed.some(function (m) { return m.retired; }) });
  },

  /**
   * 归一自愈（2026-09-26，GUI 门禁真机跑抓到的现行病例）：把"裸单元名"形态的词
   * 归一到当前注册表册名。真实数据：wy7s_2024 导入的词一部分带全名前缀
   * 「外研版2024新版初中英语七年级上册 · 7A Unit 3」、一部分是裸「7A Unit 3」——
   * 册名变更前后两批并存，单元列表出现重复组，复习页筛选器也多出一项。
   * _repairUnits 只补"完全无前缀"的词，且只在打开该册时触发；裸形态（带了单元号
   * 没带册名）它视为"已带前缀"跳过，永远修不到。这里在 buildManaged（每次进
   * 教材管理页必跑）兜一次：按**词表比对**（裸 unit 命中某册的单元名集合 + 词在
   * 该册词表里）归一——不同教材都叫 "Unit 1"，只按单元名匹配会改坏别的册。
   * 多册命中时按词出现率取命中最多的那册，平局不动（宁可不修，不猜）。
   */
  normalizeBareUnits() {
    const lib = store.loadWords();
    // 收集裸形态：unit 不为空、不带「 · 」分隔符（带前缀的都有它）
    const bare = {};
    lib.forEach(function (w, i) {
      // 预置词（id 以 en-XXXX- 前缀开头）不该进归一：它们的 unit 本来就是裸的
      // （textbook-7a.js 种子里就是这么写的），一旦归一就把「这一册」当可移除教材展示。
      if (String((w && w.id) || '').indexOf('en-') === 0) return;
      const u = String(w.unit || '').trim();
      if (!u || u.indexOf(' · ') !== -1) return;
      (bare[u] || (bare[u] = [])).push(i);
    });
    const bareUnits = Object.keys(bare);
    if (!bareUnits.length) return;

    // 建「册名 → {单元名集合, 词表}」：注册表全量册（含已下架——旧数据的册可能已下架）
    const bookLib = {};
    books.list().forEach(function (b) {
      try {
        const d = books.load(b.id);
        if (!d || !Array.isArray(d.words)) return;
        const units = {};
        d.words.forEach(function (w) {
          const u = String((w && w.unit) || '').trim();
          if (u) units[u] = true;
        });
        bookLib[b.name] = { units: units, words: d.words };
      } catch (e) { /* 单册加载失败不拦归一（与逐册加载的容错同口径） */ }
    });

    // 每个裸 unit：找命中它单元名的册；多册命中时按词出现数取最大
    // 比对口径：**剥掉词性括注再比**——预置词表刻意有 race（v.）/race（n.）双卡
    // （括注是承重的索引键，见 TODO-11），而教材词表里存的是干净的 race；
    // 不剥括注这两条永远匹配不上（命中 0 → 平局 → 永远修不到，2026-09-26 实测）。
    const norm = function (s) {
      return String(s || '').toLowerCase().trim().replace(/（[^）]*）|\([^)]*\)/g, '');
    };
    const assign = {};
    bareUnits.forEach(function (u) {
      let best = null, bestCount = 0, tie = false;
      Object.keys(bookLib).forEach(function (name) {
        if (bookLib[name].units[u] !== true) return;
        const words = bookLib[name].words;
        let cnt = 0;
        bare[u].forEach(function (i) {
          const k = norm(lib[i] && lib[i].word);
          if (!k) return;
          for (let j = 0; j < words.length; j++) {
            if (norm(words[j] && words[j].word) === k) { cnt++; break; }
          }
        });
        if (cnt > bestCount) { best = name; bestCount = cnt; tie = false; }
        else if (cnt === bestCount && cnt > 0) { tie = true; }
      });
      if (best && !tie) assign[u] = best;
    });

    let fixed = 0;
    Object.keys(assign).forEach(function (u) {
      bare[u].forEach(function (i) {
        fixed++;
        lib[i] = Object.assign({}, lib[i], { unit: assign[u] + ' · ' + u });
      });
    });
    if (fixed > 0) {
      store.saveWords(lib);
      cards.invalidate();
    }
  },

  /** 整册移除：二次确认后按 unit 前缀批量删词（按 origName 找，改名不影响删除） */
  deleteBook(e) {
    const origName = e.currentTarget.dataset.orig;
    const target = (this.data.managed || []).filter(function (m) { return m.origName === origName; })[0];
    if (!target) return;
    wx.showModal({
      title: '移除「' + target.name + '」？',
      content: '将移除这一册导入的 ' + target.count + ' 个词（含上/下半分组）。这些词的学习进度会一并清掉。',
      confirmText: '移除',
      confirmColor: '#D95F3B',
      success: (res) => {
        if (!res.confirm) return;
        const lib = store.loadWords();
        const removed = lib.filter(function (w) {
          return String(w.unit || '').split(' · ')[0] === origName;
        });
        const removedIds = {};
        removed.forEach(function (w) { removedIds[w.id] = true; });
        store.saveWords(lib.filter(function (w) { return !removedIds[w.id]; }));
        cards.invalidate();
        this.buildManaged();
        wx.showToast({ title: '已移除 ' + removed.length + ' 个词', icon: 'none' });
      }
    });
  },

  /**
   * 重命名（TODO-5）：只改本地显示映射，unit 前缀一律不动。
   * 见文件顶部 BOOK_META_KEY 处的设计取舍说明 —— 为什么不改词条 unit。
   */
  renameBook(e) {
    const origName = e.currentTarget.dataset.orig;
    if (!origName) return;
    const meta = readBookMeta();
    const current = (meta[origName] && meta[origName].displayName) || origName;
    wx.showModal({
      title: '重命名「' + current + '」',
      // editable 需基础库 2.17.1+；不支持的旧库里弹普通确认框，
      // res.content 为 undefined → 落到下面的空值分支 = 无操作，不会改坏数据
      editable: true,
      placeholderText: current,
      content: current,
      success: (res) => {
        if (!res.confirm) return;
        const v = String(res.content == null ? '' : res.content).trim().slice(0, DISPLAY_NAME_MAX);
        if (!v || v === origName) {
          // 空名 / 改回原名：清掉映射，存储里不留垃圾条目
          delete meta[origName];
        } else {
          meta[origName] = { displayName: v };
        }
        saveBookMeta(meta);
        this.buildManaged();
      }
    });
  },

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

    // 顺手把这一册"导入过但没有册名前缀"的旧词修好（见 _repairUnits 的说明）
    const fixed = this._repairUnits(String(data.book || ''), words);
    if (fixed > 0) {
      wx.showToast({ title: '已整理 ' + fixed + ' 个词的册名', icon: 'none' });
    }
  },

  /**
   * 自愈：把这一册里"导入了但 unit 没带册名前缀"的词补上前缀。
   *
   * ## 为什么需要它
   * 上面 doImport 的 bug（`else if (!item.unit)` 是死分支）从 2026-09-19 就存在，
   * 期间导入的词 unit 停在 "7A Unit 1" 这种**不带册名**的形态。
   * 光修导入逻辑救不了这批历史数据 —— 学生不会为了修数据重新导一遍。
   *
   * ## 为什么在这里修（而不是一次性全量迁移）
   * 本页刻意"点开哪册才 require 哪册"（门禁明确拦全量加载 5184 词）。
   * 而打开一册时，这一册的词表**已经在内存里**了 —— 此刻修复零额外成本。
   * 打开哪册修哪册，是唯一不需要破坏按需设计的做法。
   *
   * ## 为什么必须比对词表（而不是只比对单元名）
   * 不同教材的单元名会撞（北师大版也叫 "Unit 1"）。只按单元名匹配的话，
   * 打开 A 册会顺手把 B 册的 "Unit 1" 也加上 A 的册名前缀 —— 把数据改坏。
   * 所以先建这一册的词表，**只修这一册确实收录的词**。
   *
   * @returns {number} 修了几个词
   */
  _repairUnits(bookName, words) {
    if (!bookName || !Array.isArray(words) || !words.length) return 0;

    const inBook = {};
    const unitNames = {};
    words.forEach(function (w) {
      const k = String((w && w.word) || '').toLowerCase().trim();
      if (k) inBook[k] = true;
      const u = String((w && w.unit) || '').trim();
      if (u) unitNames[u] = true;
    });
    if (!Object.keys(unitNames).length) return 0;

    const lib = store.loadWords();
    let fixed = 0;
    const next = lib.map(function (w) {
      const u = String(w.unit || '').trim();
      // 空 unit / 已经带前缀的 / 不属于本册单元的 → 一律不动
      if (!u || unitNames[u] !== true) return w;
      if (inBook[String(w.word || '').toLowerCase().trim()] !== true) return w;
      fixed += 1;
      return Object.assign({}, w, { unit: bookName + ' · ' + u });
    });

    if (fixed > 0) {
      store.saveWords(next);
      cards.invalidate();
    }
    return fixed;
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
    // 回列表要重算已导入分组：导入/删除/自愈都可能在二级页里改过词库，
    // 沿用 onLoad 那份就出现"刚导完却看不到"的陈旧列表
    this.buildManaged();
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

    // 2026-09-19 改：无单元数据的册（旧版 19 册），导入的词不再落"未分组"——
    // 按册名 + 前后分半给**默认分组**（一次导 400+ 词全挤一个组也没法练）。
    const unitless = this.data.units.length === 1 && this.data.units[0].name === WHOLE_BOOK_UNIT;
    const mid = Math.ceil(this.words.length / 2);
    const items = [];
    this.words.forEach((w, i) => {
      if (pickedNames.indexOf(unitNameOf(w)) === -1) return;
      const item = toItem(w);
      /**
       * ⚠️ 2026-09-25 修（这是"书本添加/删除失效"的根因）：
       *
       * 原来写的是 `else if (!item.unit) { item.unit = this.data.book; }` ——
       * 而**教材源数据每条都自带 unit**（toItem 第 58 行会把它带过来），
       * 于是这个分支**永远不会进入**，导入的词 unit 停在 "7A Unit 1"，
       * 没有册名前缀。
       *
       * 后果（学生看到的）：导入明明成功了，但"教材管理"里找不到这一册 ——
       * 因为 buildManaged() 用 `unit.split(' · ')[0]` 反查册名，拿到的是
       * "7A Unit 1"，不在注册表里，整组被跳过。**看不到，也就删不掉。**
       *
       * 本文件第 122-123 行的注释其实早就写明了意图："导入时 unit 统一带册名前缀
       *（'册名 · 上半/下半' **或教材自带单元名**）" —— 代码没做到，这里是补上。
       */
      if (unitless) {
        item.unit = this.data.book + (i < mid ? ' · 上半' : ' · 下半');
      } else if (item.unit) {
        item.unit = this.data.book + ' · ' + item.unit;
      } else {
        item.unit = this.data.book;
      }
      items.push(item);
    });

    // 导入前先看这一册是不是早就在词库里了：是就直说，不报"跳过 N 个"。
    // 首次启动已预置七上 295 词，学生再选同一册时，旧文案会变成
    // 「已导入 1 个词，跳过 294 个」—— 看着像出错，其实只是老词重来一遍。
    // 重合率超过九成即视为"已经导过"（可能还剩个别新词，也不值得让学生重来）。
    const inLib = {};
    store.loadWords().forEach(function (w) { inLib[String(w.word).toLowerCase()] = 1; });
    const hit = items.filter(function (it) { return inLib[it.word.toLowerCase()]; }).length;
    if (items.length > 0 && hit / items.length > IMPORTED_RATIO) {
      // 拦截文案要给出路（作者把"没法导入教材"反馈上来 —— 这句话读起来像故障）：
      // 说清"已经在了 = 不用再导"，下一步直接去复习
      wx.showToast({ title: '这一册已在词库里，去「复习」直接练', icon: 'none', duration: 2000 });
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
    this.buildManaged();         // 管理列表立刻看到这一册（不必退出重进）
    wx.showToast({ title: msg, icon: 'none', duration: 1600 });

    // 导入成功后清空选择，给一个"这次已经处理完"的收尾
    this.applyUnits(this.data.units.map((u) => ({ name: u.name, count: u.count, picked: false })));
  }
});
