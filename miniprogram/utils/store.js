/**
 * 本地存储封装 —— 所有数据只存本机（wx.setStorageSync），不上传。
 * Storage Key: 'words' → Array<WordItem>
 */
const { todayStr, isValidDateStr } = require('./date.js');
/**
 * 一句话版记忆钩子 —— 从完整钩子提炼（见 tools/build-short-hooks.js）。
 * 完整钩子中位 72 字，学生翻卡时一眼扫不过来会直接跳过；
 * 短版 ≤26 字，先给一眼能记住的，完整版点开再看。
 */
const SHORT_HOOKS = require('../data/short-hooks.js');

const WORDS_KEY = 'words';

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 非负整数判定（用 ES3 的 isFinite/Math.floor，避免依赖 Number.isInteger 的运行时支持） */
function isNonNegInt(v) {
  const n = Number(v);
  return isFinite(n) && Math.floor(n) === n && n >= 0;
}

/*----------------------------- 读取净化 ------------------------------*/
/**
 * 把被外部改坏、或跨版本迁移留下的脏记录修正回合法形状。
 *
 * 为什么必须做：loadWords 是唯一数据入口，下游 dueWords / masteredCount / selfCheck /
 * 页面 .map 全部直接假定"拿到的是合法数组"。存储值一旦被写成字符串，
 * 下游就是 `xxx is not a function` → 整页白屏；某个字段缺了则静默算出 NaN。
 *
 * 三条纪律：
 *  1. **修正而非丢弃**：只有 word/meaning 缺失才丢（缺了这条记录就没有意义）；
 *     其余字段一律修正 —— 丢弃等于静默丢词，正是要消灭的行为。
 *  2. **不动合法数据**：字段本来就合法时一个字节都不改，保证"净化前后对正常词条完全一致"。
 *  3. **不回写存储**：只在内存里修正，不在这里调 saveWords（否则每次读都写盘）。
 *     确实发生修正时打一条汇总 warn，便于排查。
 */
function sanitize(list) {
  let fixed = 0;
  let dropped = 0;

  const out = list.filter(function (raw) {
    if (!raw || typeof raw !== 'object') { dropped++; return false; }
    if (typeof raw.word !== 'string' || !raw.word.trim()) { dropped++; return false; }
    if (typeof raw.meaning !== 'string' || !raw.meaning.trim()) { dropped++; return false; }
    return true;
  });

  // 已发出去的 id。为什么要去重：removeWord 是 `filter(w => w.id !== id)`，
  // 会删掉**所有**同 id 记录；而 updateWord 是 `for` + `list[i] = updated`，只替换**第一个**。
  // 同一个 id 下"删除"和"更新"的语义不一致 —— 两条记录撞了 id 时，
  // 长按删一条会把另一条一起带走，用户看到的是"删一个少了两个"。
  const seen = new Set();

  out.forEach(function (w) {
    // id 缺失/非串 → 补发。不补的话 removeWord 的 filter 会把它和所有缺 id 的记录
    // 一起过滤掉（undefined !== undefined 为 false），删一条 = 清空半张词库，还返回 true 假装成功。
    if (typeof w.id !== 'string' || !w.id) { w.id = genId(); fixed++; }
    if (seen.has(w.id)) { w.id = genId(); fixed++; }
    seen.add(w.id);

    if (w.word !== w.word.trim()) { w.word = w.word.trim(); fixed++; }
    if (w.meaning !== w.meaning.trim()) { w.meaning = w.meaning.trim(); fixed++; }

    // ef：有限数且不低于下限 1.3，否则回到新词默认值。
    // 顺手把字符串 '2.5' 折算成数字 —— 否则 sm2 里 `item.ef + ...` 会变成字符串拼接。
    const ef = Number(w.ef);
    if (!isFinite(ef) || ef < 1.3) { w.ef = 2.5; fixed++; }
    else if (typeof w.ef !== 'number') { w.ef = ef; fixed++; }

    const reps = Number(w.reps);
    if (!isNonNegInt(reps)) { w.reps = 0; fixed++; }
    else if (typeof w.reps !== 'number') { w.reps = reps; fixed++; }

    const interval = Number(w.interval);
    if (!isNonNegInt(interval)) { w.interval = 0; fixed++; }
    else if (typeof w.interval !== 'number') { w.interval = interval; fixed++; }

    // 不变式：interval 为 0 意味着"从未成功复习过"，reps 就不该 > 0。
    // 这条同时兜住受损数据在 (reps>=3 且 interval===0) 下间隔恒为 0、永远当日到期的状态。
    if (w.interval === 0 && w.reps !== 0) { w.reps = 0; fixed++; }

    // 日期串坏了就按"今天"处理，让这个词至少能重新进队列，而不是因字典序永久卡死
    if (!isValidDateStr(w.nextReview)) { w.nextReview = todayStr(); fixed++; }

    if (!Array.isArray(w.history)) { w.history = []; fixed++; }
    else {
      const hist = [];
      w.history.forEach(function (h) {
        if (!h || typeof h !== 'object') { fixed++; return; }
        if (!isValidDateStr(h.date)) { h.date = todayStr(); fixed++; }
        const q = Number(h.q);
        if (!isFinite(q)) { h.q = 0; fixed++; }
        else if (typeof h.q !== 'number') { h.q = q; fixed++; }
        const iv = Number(h.interval);
        if (!isNonNegInt(iv)) { h.interval = 0; fixed++; }
        else if (typeof h.interval !== 'number') { h.interval = iv; fixed++; }
        hist.push(h);
      });
      w.history = hist;
    }
  });

  if (fixed > 0 || dropped > 0) {
    console.warn('[store] 词库数据净化：修正 ' + fixed + ' 处，丢弃 ' + dropped + ' 条无效记录');
  }
  return out;
}

function loadWords() {
  try {
    const raw = wx.getStorageSync(WORDS_KEY);
    if (raw === '' || raw == null) return [];
    if (!Array.isArray(raw)) {
      console.warn('[store] 词库存储值不是数组，已按空库处理');
      return [];
    }
    return sanitize(raw);
  } catch (e) {
    console.error('[store] 读取词库失败', e);
    return [];
  }
}

function saveWords(list) {
  try {
    wx.setStorageSync(WORDS_KEY, list);
    return true;
  } catch (e) {
    console.error('[store] 保存词库失败', e);
    return false;
  }
}

/**
 * 造一条新词条。
 *
 * extra 承载"内容型附加字段"：detail（词义详解）/ tags / source / difficulty / subject。
 * 这些字段**不参与算法**，只是内容属性，因此不设默认值也不做校验——
 * 缺了就是缺了（页面用 `|| ''` 兜），而不是被塞一个假值进来。
 *
 * 为什么把它们和 SM-2 状态放在同一条记录里：
 *   内容与状态同记录，是本项目的数据模型选择（对比"内容只读表 + 状态表"的双表方案）。
 *   代价是删除词条会连带删掉学习进度，收益是 addWord/updateWord/removeWord
 *   不需要维护两张表之间的一致性，也不会出现"状态表里留着已删词的孤儿进度"。
 */
function makeItem(word, meaning, example, mnemonic, today, extra) {
  const item = {
    id: (extra && extra.id) || genId(),
    word: word,
    meaning: meaning,
    example: example || '',
    mnemonic: mnemonic || '',
    ef: 2.5,
    reps: 0,
    interval: 0,
    nextReview: today,   // 录入当日即到期
    createdAt: today,
    history: []
  };
  if (extra) {
    if (extra.detail) item.detail = extra.detail;
    if (extra.tags && extra.tags.length) item.tags = extra.tags;
    if (extra.source) item.source = extra.source;
    if (extra.difficulty) item.difficulty = extra.difficulty;
    if (extra.subject) item.subject = extra.subject;
    if (extra.batch) item.batch = extra.batch;
  }
  return item;
}

/** 单个添加。返回 { ok, msg?, item? } */
function addWord(input) {
  const word = String(input.word || '').trim();
  const meaning = String(input.meaning || '').trim();
  if (!word || !meaning) return { ok: false, msg: '单词和释义都要填' };

  const list = loadWords();
  const dup = list.some(function (w) { return w.word.toLowerCase() === word.toLowerCase(); });
  if (dup) return { ok: false, msg: '「' + word + '」已在词库中' };

  const item = makeItem(word, meaning, String(input.example || '').trim(), String(input.mnemonic || '').trim(), todayStr());
  list.push(item);
  return saveWords(list) ? { ok: true, item: item } : { ok: false, msg: '保存失败，请重试' };
}

/** 一个"纯英文单词/短语 token"：字母开头，后可跟字母、撇号、连字符 */
const TOKEN_RE = /^[A-Za-z][A-Za-z'-]*$/;

/**
 * 把一行「单词 释义」文本切成 { word, meaning }；切不出来返回 null。
 *
 * 为什么要取"最长前导英文串"而不是固定 parts[0]：
 *   教材词库里大量条目是**合法多词短语**（all over the world / look after /
 *   stop someone from doing something）。旧实现把 parts[0] 当单词、其余全当释义，
 *   于是 "all over the world 全世界" 被静默切成 word='all' / meaning='over the world 全世界'
 *   —— 词库里凭空多出一个假单词 'all'，而界面还提示"已添加"，用户不会发现。
 *
 * 规则：
 *   1. 取最长的前导纯英文 token 串作为单词候选；
 *   2. 若候选把整行吃光（释义为空），逐个回退 token 直到释义非空
 *      —— 这样 "hello world" 仍按原行为切成 {hello, world}，而不是变成非法行；
 *   3. 无任何合法切分 → 返回 null（调用方计入 skipped）。
 *
 * 不设 token 数量上限：教材最长短语 5 词，回退规则已足够消歧义，
 * 加上限反而会把长短语截断成假单词 —— 正是要修的这个毛病。
 */
function splitLine(s) {
  const tokens = s.split(/\s+/).filter(function (t) { return t !== ''; });

  let n = 0;
  while (n < tokens.length && TOKEN_RE.test(tokens[n])) n++;
  if (n === 0) return null;

  while (n >= 1 && tokens.slice(n).join(' ').trim() === '') n--;
  if (n < 1) return null;

  const meaning = tokens.slice(n).join(' ').trim();
  if (!meaning) return null;

  return { word: tokens.slice(0, n).join(' '), meaning: meaning };
}

/**
 * 批量添加：按逗号/顿号/分号/换行切分，每条为「单词 释义」（空格分隔）。
 * 返回 { ok, added, skipped, dupSkipped, saveFailed? }
 *   skipped    —— 被跳过的条目（格式非法的给原文，重复的给单词）
 *   dupSkipped —— 其中因"已在词库里"被跳过的条数。
 *                界面靠它区分"格式不认识"和"这些词都收过了"，两者给用户的下一步完全不同。
 *   saveFailed —— 解析出了词、但写盘失败（配额满等）。**只有这一种情况才为 true**。
 *                为什么单独给标志：added 的语义是"已落库条数"，写盘失败时它就该是 0，
 *                拿它兼职当错误码会让调用方写出 `if (r.added > 0) 判定写盘失败` 这种
 *                恒为假的死分支 —— 用户拿到的提示会指向完全错误的方向（去改格式、
 *                或以为"这些词我已经导过了"），而不是去重试。
 */
function addBatch(text) {
  const list = loadWords();
  const today = todayStr();
  const pieces = String(text || '').split(/[\n,，、;；]+/);
  let added = 0;
  let dupSkipped = 0;
  const skipped = [];

  pieces.forEach(function (raw) {
    const s = raw.trim();
    if (!s) return;
    const parsed = splitLine(s);
    if (!parsed) { skipped.push(s); return; }
    const word = parsed.word;
    const meaning = parsed.meaning;
    const dup = list.some(function (w) { return w.word.toLowerCase() === word.toLowerCase(); });
    if (dup) { skipped.push(word); dupSkipped++; return; }
    list.push(makeItem(word, meaning, '', '', today));
    added++;
  });

  if (added > 0 && !saveWords(list)) {
    return { ok: false, added: 0, saveFailed: true, skipped: skipped, dupSkipped: dupSkipped };
  }
  return { ok: added > 0, added: added, skipped: skipped, dupSkipped: dupSkipped };
}

/**
 * 批量写入已结构化的词条（供 AI 智能录入 / 教材词库导入使用）。
 * 与 addBatch 的区别：输入已经是 {word, meaning} 对象数组，不需要再解析文本。
 * 返回 { ok, added, skipped, dupSkipped, saveFailed? }
 *   skipped    —— 被跳过的条目（缺字段的给原文，重复的给单词）
 *   dupSkipped —— 其中因"已在词库里"被跳过的条数（口径与 addBatch 一致）。
 *                 教材词库导入走的就是这条路：用户看到「跳过 N 个」时，
 *                 得能分清是"已在词库里"还是"这条数据有问题"，两者的下一步完全不同。
 *   saveFailed —— 同 addBatch：解析出了词但写盘失败。教材导入一次写 295 条，
 *                 最可能撞上 10MB 配额，因此这里的错误提示尤其不能指错方向。
 */
function addItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, added: 0, skipped: [], dupSkipped: 0 };
  }

  const list = loadWords();
  const today = todayStr();
  let added = 0;
  let dupSkipped = 0;
  const skipped = [];

  items.forEach(function (raw) {
    const word = String((raw && raw.word) || '').trim();
    const meaning = String((raw && raw.meaning) || '').trim();
    if (!word || !meaning) { skipped.push(word || '(空)'); return; }

    const dup = list.some(function (w) { return w.word.toLowerCase() === word.toLowerCase(); });
    if (dup) { skipped.push(word); dupSkipped++; return; }

    list.push(makeItem(word, meaning, String(raw.example || '').trim(), String(raw.mnemonic || '').trim(), today, {
      id: raw.id,
      detail: raw.detail,
      tags: raw.tags,
      source: raw.source,
      difficulty: raw.difficulty,
      subject: raw.subject,
      batch: raw.batch
    }));
    added++;
  });

  if (added > 0 && !saveWords(list)) {
    return { ok: false, added: 0, saveFailed: true, skipped: skipped, dupSkipped: dupSkipped };
  }
  return { ok: added > 0, added: added, skipped: skipped, dupSkipped: dupSkipped };
}

function updateWord(updated) {
  const list = loadWords();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === updated.id) { list[i] = updated; return saveWords(list); }
  }
  return false;
}

function removeWord(id) {
  return saveWords(loadWords().filter(function (w) { return w.id !== id; }));
}

function clearAll() {
  try {
    wx.removeStorageSync(WORDS_KEY);
    return true;
  } catch (e) {
    console.error('[store] 清空词库失败', e);
    return false;
  }
}

/** 载入预置词库（覆盖现有词库），返回载入数量 */
function seedWords(seedList) {
  const today = todayStr();
  const list = seedList.map(function (s) {
    return makeItem(s.word, s.meaning, s.example, s.mnemonic, today, {
      id: s.id,
      detail: s.detail,
      tags: s.tags,
      source: s.source,
      difficulty: s.difficulty,
      subject: s.subject,
      batch: s.batch
    });
  });
  return saveWords(list) ? list.length : 0;
}

/*===================== 首次预置 =====================*/

const SEEDED_KEY = 'seeded_v1';

/**
 * 首次启动预置教材词库。
 *
 * 为什么必须做：在此之前，本站的首次体验是**空的**——用户得自己进「词库 → 教材导入」
 * 才有内容，于是打开就像个半成品。预置之后开箱即有 295 词可学。
 *
 * 幂等设计：用 SEEDED_KEY 标记"预置这件事做过"，而不是判断"词库是否为空"。
 * 为什么不用判空：用户可能主动清空词库重新开始，那时判空会**违背他的意愿把词全灌回来**。
 * 标记位只有在真正写入成功后才落盘，中途失败下次仍会重试。
 *
 * 返回 { seeded, count, reason? }
 *   seeded=false 的三种情况：已预置过 / 预置数据缺失 / 用户已有词库
 */
function initSeed(seedWordsList) {
  if (!Array.isArray(seedWordsList) || seedWordsList.length === 0) {
    return { seeded: false, count: 0, reason: 'no_seed_data' };
  }
  try {
    if (wx.getStorageSync(SEEDED_KEY)) return { seeded: false, count: 0, reason: 'already_seeded' };
  } catch (e) { /* 读取失败按未预置处理，下面会再试一次 */ }

  // 已有内容时不覆盖：用户自己导入过词库的场景，不能拿教材词表盖掉他
  if (loadWords().length > 0) {
    try { wx.setStorageSync(SEEDED_KEY, 1); } catch (e) { /* 标记失败不致命 */ }
    return { seeded: false, count: 0, reason: 'has_content' };
  }

  const n = seedWords(seedWordsList);
  if (n > 0) {
    try { wx.setStorageSync(SEEDED_KEY, 1); } catch (e) { /* 标记失败下次会重试，可接受 */ }
    return { seeded: true, count: n };
  }
  return { seeded: false, count: 0, reason: 'save_failed' };
}

/*===================== (cards, states) 视图适配层 =====================*/
/**
 * 把"内容+状态同记录"的存储，投影成"只读内容表 + 状态表"的双表视图。
 *
 * 为什么要这层：页面有两种写法，一种直接拿词条列表（录入/词库管理），
 * 一种按 (卡片, 状态) 操作（卡组浏览/复习/统计）。两者读的是**同一份存储**，
 * 这层只做形状转换，不引入第二份数据 —— 避免"两张表不同步"这类问题。
 *
 * 映射规则：
 *   loadCards() → [{ id, prompt, answer, detail, hook, tags, difficulty, source, subject }]
 *   loadStates() → { [id]: { ef, reps, interval, nextReview, history, createdAt } }
 *   写回：setState(id, st) / setStates(批量)
 */

/**
 * 造一份"从未复习过"的初始状态。
 *
 * 为什么必须有这个函数：复习页对生词的处理是
 *   `const st = states[id] || newState(today)`
 * —— 生词在状态表里**不存在**（见 loadStates 的语义说明），所以这个兜底分支
 * 是每个新用户复习第一个词时**必走**的路径。它一旦缺失就是当场崩溃，
 * 而且只在"第一次复习"时触发，测试若沿用"所有词都有状态"的旧假设还会漏掉。
 *
 * 与 makeItem 里的初始值保持一致：EF=2.5（SM-2 的标准起步值）、reps=0、interval=0。
 */
function newState(today) {
  return {
    ef: 2.5,
    reps: 0,
    interval: 0,
    nextReview: today || todayStr(),
    createdAt: today || todayStr(),
    history: []
  };
}

/** 词条 → 卡片（只取内容字段，算法状态不带） */
function toCard(w) {
  return {
    id: w.id,
    prompt: w.word,
    answer: w.meaning,
    detail: w.detail || '',
    hook: w.mnemonic || '',
    // 提炼不出时为 ''，页面应回退到显示完整 hook
    shortHook: SHORT_HOOKS[w.word] || '',
    example: w.example || '',
    tags: w.tags || [],
    difficulty: w.difficulty || 2,
    source: w.source || '',
    subject: w.subject || '英语',
    batch: w.batch || ''
  };
}

/** 词条 → 算法状态（只取 SM-2 相关字段） */
function toState(w) {
  return {
    ef: w.ef,
    reps: w.reps,
    interval: w.interval,
    nextReview: w.nextReview,
    history: w.history || [],
    createdAt: w.createdAt || ''
  };
}

function loadCards() {
  return loadWords().map(toCard);
}

/**
 * 学习状态表：{ [id]: {ef, reps, interval, nextReview, history, createdAt} }
 *
 * ⚠️ **只为"复习过"的词返回条目**，没复习过的不出现在表里。
 *
 * 为什么这条不能省：本项目的存储里每个词都带 SM-2 字段（ef/reps/interval 各有默认值），
 * 所以"字段存在"不等于"学过"。如果这里把全部词都返回，下游一律用 `states[id]` 是否存在
 * 来判断"学过没有"，就会得到**全部词都学过**的结论 —— 表现为：
 *   · 卡组页"未学"恒显示 0（新用户进来看到的数字就是错的）
 *   · 卡片详情永远不说"还没学过"，而是显示一堆无意义的 0
 *   · 新卡不再排到复习队列前面
 * 这两个数据模型的语义差异（"状态表只存学过的" vs "每条记录都带状态字段"）
 * 必须在**这一层**抹平，否则会渗进每一个页面。
 *
 * 判定口径：有复习历史（history 非空）才算学过。
 * 不用 reps>0 或 interval>0：那两者在"清零进度"后也是 0，但语义上
 * "曾经学过、后来清了"与"从没学过"在界面上应当一致 —— 都以 history 为准最直观。
 */
function loadStates() {
  const out = {};
  loadWords().forEach(function (w) {
    const hist = w.history;
    if (Array.isArray(hist) && hist.length > 0) out[w.id] = toState(w);
  });
  return out;
}

/**
 * 回写单张卡的状态。返回 true/false（写盘成功与否）。
 *
 * 注意：这里**只覆盖算法字段**，不动内容字段。
 * 因为状态来自 SM-2 计算，内容来自词库，混写会出现"复习一次把释义改没了"这种事。
 */
function setState(id, st) {
  const list = loadWords();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id !== id) continue;
    list[i].ef = st.ef;
    list[i].reps = st.reps;
    list[i].interval = st.interval;
    list[i].nextReview = st.nextReview;
    if (Array.isArray(st.history)) list[i].history = st.history;
    return saveWords(list);
  }
  return false;
}

/** 批量回写状态。返回成功写回的条数 */
function setStates(mapByld) {
  const list = loadWords();
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const st = mapByld[list[i].id];
    if (!st) continue;
    list[i].ef = st.ef;
    list[i].reps = st.reps;
    list[i].interval = st.interval;
    list[i].nextReview = st.nextReview;
    if (Array.isArray(st.history)) list[i].history = st.history;
    n++;
  }
  if (n > 0 && !saveWords(list)) return 0;
  return n;
}

/** 学过（有复习记录）的卡片 id 集合 */
function studiedIds() {
  const out = {};
  loadWords().forEach(function (w) {
    if (w.history && w.history.length > 0) out[w.id] = true;
  });
  return out;
}

/** 清空所有学习进度（保留词条内容）—— 用于"重新开始" */
function clearStates() {
  const today = todayStr();
  const list = loadWords().map(function (w) {
    w.ef = 2.5;
    w.reps = 0;
    w.interval = 0;
    w.nextReview = today;   // 清零后全部回到今日到期
    w.history = [];
    return w;
  });
  return saveWords(list);
}

/** 按 id 取单个词条（找不到返回 null） */
function getWord(id) {
  const list = loadWords();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/** 词条总数 */
function countWords() {
  return loadWords().length;
}

/*===================== 错题本 / 复习偏好 =====================*/

/**
 * 错题本：把"答错过"的词挑出来。
 *
 * 判定口径：历史里出现过 q < 3（不认识）或 q === 3（模糊）。
 * 为什么不按"当前 EF 低"判：EF 会因为后来的连对而回升，
 * 而"曾经答错"是个**永久有用的事实**——正是需要多练的那批词。
 */
function weakIds() {
  const out = [];
  loadWords().forEach(function (w) {
    const h = w.history || [];
    if (!Array.isArray(h)) return;
    for (let i = 0; i < h.length; i++) {
      const q = Number((h[i] || {}).q);
      if (Number.isFinite(q) && q <= 3) { out.push(w.id); return; }
    }
  });
  return out;
}

const PREFS_KEY = 'study_prefs';

/*===================== 朗读记录 =====================*/
/**
 * 朗读评测记录 —— 谁读对了、谁读错了，供"发音薄弱词"统计与回看。
 *
 * 为什么收敛到 store 而不是各页面自己管：
 *   原先朗读页自己读写 'pron_records'，设置页却删 'memcards_pron_records' ——
 *   两个不同的键，于是**"清空朗读记录"点了等于没点**，用户看到的"已清空"是假的。
 *   这类"同一份数据两处各写一个键"的漂移靠约定防不住，必须收敛到一处。
 *
 * 存储形状：{ [wordId]: [ {band, score, heard, at}, ... ] }（每词最多 PER_WORD 条）
 * 按词分组而不是平铺成一条流水：界面上要展示的就是"这个词读得怎么样"，
 * 分组存可以直接取某词的历史，不用每次全表扫描再过滤。
 */
const PRON_KEY = 'pron_records';
const PRON_PER_WORD = 20;

function loadPronRecords() {
  try {
    const v = wx.getStorageSync(PRON_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    console.warn('[store] 读取朗读记录失败', e);
    return {};
  }
}

/** 追加一条某词的朗读记录。返回 true/false（写盘成功与否） */
function addPronRecord(wordId, entry) {
  if (!wordId) return false;
  try {
    const all = loadPronRecords();
    const list = all[wordId] || [];
    list.push(entry);
    all[wordId] = list.slice(-PRON_PER_WORD);   // 防存储膨胀
    wx.setStorageSync(PRON_KEY, all);
    return true;
  } catch (e) {
    console.error('[store] 保存朗读记录失败', e);
    return false;
  }
}

function clearPronRecords() {
  try {
    wx.removeStorageSync(PRON_KEY);
    return true;
  } catch (e) {
    console.error('[store] 清空朗读记录失败', e);
    return false;
  }
}

/*===================== 复习偏好 =====================*/

/** 复习页的筛选偏好（学科 / 范围），随用户最后一次选择保留 */
function loadPrefs() {
  try {
    const raw = wx.getStorageSync(PREFS_KEY);
    if (!raw || typeof raw !== 'object') return {};
    return raw;
  } catch (e) {
    console.warn('[store] 读取复习偏好失败', e);
    return {};
  }
}

function savePrefs(prefs) {
  try {
    wx.setStorageSync(PREFS_KEY, prefs || {});
    return true;
  } catch (e) {
    console.warn('[store] 保存复习偏好失败', e);
    return false;
  }
}

module.exports = {
  loadWords, saveWords, addWord, addBatch, addItems, updateWord, removeWord,
  clearAll, seedWords, initSeed,
  loadCards, loadStates, setState, setStates, studiedIds, clearStates, newState,
  getWord, countWords,
  weakIds, loadPrefs, savePrefs,
  loadPronRecords, addPronRecord, clearPronRecords, PRON_KEY
};
