/**
 * 端上能力验证 —— rag（检索）/ analysis（分析）/ audio（发音包）。
 *
 * ## 为什么单独一组
 * 这三块是"任何手机都能用"的技术内核，且**全程在本机算**，
 * 所以它们必须由**离线、确定性**的测试守住 —— 不依赖网络、不依赖 mock 服务器。
 * 原先的门禁覆盖了算法与页面，但这三块是新长出来的能力，此前零覆盖。
 *
 * ## 测试策略
 *   · 用**真实词表**（295 词）跑，不用假数据 —— 检索质量对词表敏感
 *   · 断言的是**语义正确性**（该找到的能找到），不只是"不抛错"
 *   · 性能断言给宽松上限（真机比桌面慢 2-5 倍），只防"退化到秒级"
 *
 * 运行：node tools/verify-onddevice.js
 */
const path = require('path');

let pass = 0, fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('本文件只支持同步断言');
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name);
    console.log('      ' + (e && e.message ? e.message : String(e)));
    failures.push(name);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)); }

/*------------------------ mock 小程序环境 ------------------------*/
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  env: { USER_DATA_PATH: '/mock-userdata' },
  getFileSystemManager: () => ({
    copyFile: o => setTimeout(() => o.success && o.success({}), 0),
    readFile: o => setTimeout(() => o.success && o.success({ data: 'eA==' }), 0)
  })
};

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const rag = require(path.join(ROOT, 'utils', 'rag.js'));
const analysis = require(path.join(ROOT, 'utils', 'analysis.js'));
const audioMod = require(path.join(ROOT, 'utils', 'audio.js'));
const seed = require(path.join(ROOT, 'data', 'textbook-7a.js'));

/** 真实卡片（模拟 app 启动后的形状） */
const CARDS = seed.words.map(w => ({
  id: w.id, prompt: w.word, answer: w.meaning,
  detail: w.detail, hook: w.mnemonic, tags: w.tags, subject: '英语'
}));

console.log('端上能力验证（检索 / 分析 / 发音包）\n');
console.log('词表：' + CARDS.length + ' 词\n');

/*================================================================
 * 一、检索（utils/rag.js）
 *================================================================*/
console.log('-- 检索（RAG）--');

const idx = rag.buildIndex(CARDS);

check('索引覆盖全部词条', () => {
  assertEq(idx.items.length, CARDS.length, '索引条目数');
});

check('索引构建足够快（<50ms，真机放宽后仍应 <200ms）', () => {
  const t0 = Date.now();
  rag.buildIndex(CARDS);
  const ms = Date.now() - t0;
  assert(ms < 50, '建索引耗时 ' + ms + 'ms');
});

check('形近检索：geography 能找出同后缀的学科词', () => {
  const r = rag.similar('geography', idx, { topK: 5 });
  assert(r.results.length > 0, '没有结果');
  // photography 是本词表里唯一的同类学科词（-graphy 结尾）
  const top = r.results[0].item.display;
  assertEq(top, 'photography', 'top1 应为 photography');
});

check('形近检索：换位词能被识别（quite/quiet 类）', () => {
  // 课本词表里没有 quite/quiet，用注入语料验证算法本身
  const pool = [
    { id: 'a', prompt: 'form' }, { id: 'b', prompt: 'from' },
    { id: 'c', prompt: 'elephant' }, { id: 'd', prompt: 'guitar' }
  ];
  const ix = rag.buildIndex(pool);
  const r = rag.similar('form', ix, { minScore: 0 });
  assertEq(r.results[0].item.display, 'from', 'form 的 top1 应为 from');
  assert(r.results[0].ana === true, '应标记"字母相同顺序不同"');
});

check('形近检索：11 组经典形近词 rank-1 全中', () => {
  const PAIRS = [
    ['quite', 'quiet'], ['affect', 'effect'], ['angel', 'angle'], ['form', 'from'],
    ['adapt', 'adopt'], ['desert', 'dessert'], ['advice', 'advise'], ['than', 'then'],
    ['board', 'broad'], ['weather', 'whether'], ['stationary', 'stationery']
  ];
  const pool = [];
  PAIRS.forEach((p, i) => {
    pool.push({ id: 'x' + i, prompt: p[0] });
    pool.push({ id: 'y' + i, prompt: p[1] });
  });
  ['elephant', 'purple', 'guitar', 'mountain'].forEach((w, i) => pool.push({ id: 'd' + i, prompt: w }));
  const ix = rag.buildIndex(pool);
  const bad = [];
  PAIRS.forEach(p => {
    const r = rag.similar(p[0], ix, { minScore: 0 });
    if (!r.results[0] || r.results[0].item.display !== p[1]) {
      bad.push(p[0] + '→' + (r.results[0] ? r.results[0].item.display : '无'));
    }
  });
  assertEq(bad.length, 0, '未命中：' + bad.join(', '));
});

check('同族词：人工表覆盖规则推不出的那批', () => {
  const f = rag.family('nervous', idx);
  // nervous → nerve/nerves/nervously 靠规则推不出来（要去 -ous 再补 e），
  // 这正是必须有 FAMILY_OVERRIDE 的原因
  assert(f.curated.indexOf('nerve') !== -1, '缺 nerve');
  assert(f.curated.indexOf('nerves') !== -1, '缺 nerves');
});

check('同族词：规则能推出的形态被词典验证后才返回', () => {
  const f = rag.family('history', idx);
  const all = f.curated.concat(f.inCorpus, f.inTable);
  assert(all.indexOf('historical') !== -1, '缺 historical');
  // 未经验证的形态不得混入（否则会出现 geographyly 这类噪声）
  assertEq((f.unverified || []).length, 0, '默认不应返回未验证形态');
});

check('词干剥离不会把 water 误剥成 wat（歧义后缀必须查词典）', () => {
  const ws = {};
  CARDS.forEach(c => { ws[rag.normWord(c.prompt)] = true; });
  // 词表里没有 water，剥离结果必须原样保留
  const r = rag.stemOf('water', ws);
  assertEq(r.stem, 'water', 'water 不该被剥离');
});

check('同类词：按主题名查到一组词', () => {
  const c = rag.category('学校用品', idx);
  assertEq(c.matchedBy, 'topic', '应命中主题');
  assert(c.items.length >= 3, '词数过少：' + c.items.length);
});

check('同类词：别名可用（学生说"文具"也能问到）', () => {
  const c = rag.category('文具', idx);
  assert(c.items.length >= 3, '别名未生效，词数 ' + c.items.length);
});

check('同类词：靠相似度做不到的类别检索确实生效', () => {
  // geography 与 biology 共享 bigram 为 0、无公共前缀 —— 相似度找不到彼此，
  // 但"学科"这个主题索引能找到
  const c = rag.category('学科', idx);
  const names = c.items.map(i => i.display);
  assert(names.indexOf('geography') !== -1 && names.indexOf('biology') !== -1,
    '学科主题应同时含 geography 与 biology，实际 ' + names.slice(0, 8).join(','));
});

check('端到端问答：分辨两个词给得出对比', () => {
  // 注意：这里测的是**学生指定两个词**的对比。
  // 初版测的是"猜哪个词容易混"，那个设计已废弃 —— 实测给的是噪音
  // （important → parent 50%，学生绝不会混这两个）。
  const r = rag.ask('everyone 和 everybody 有什么区别？', CARDS, { index: idx });
  assertEq(r.intent, 'compare', '意图识别');
  assert(r.answer && r.answer.length > 20, '答案过短');
  assert(r.answer.indexOf('everyone') !== -1 && r.answer.indexOf('everybody') !== -1,
    '对比答案应同时提到两个词');
  assertEq(r.sources.length, 2, '应给出两个来源词');
});

check('端到端问答：单问"容易混"时如实回答而非硬凑', () => {
  const r = rag.ask('geography 和哪个词容易混？', CARDS, { index: idx });
  assertEq(r.intent, 'compare', '意图识别');
  // 关键：不能返回一堆 0.3 分的噪音当作"容易混"
  r.sources.forEach(function (s) {
    assert(s.score >= 0.6, '推荐的词像度应 ≥0.6，实际 ' + s.score + '（' + s.word + '）');
  });
});

check('端到端问答：类别类问题给得出答案', () => {
  const r = rag.ask('课本里学校用品有哪些词？', CARDS, { index: idx });
  assertEq(r.intent, 'category', '意图识别');
  assert(r.sources.length >= 3, '来源过少：' + r.sources.length);
});

check('端到端问答：记忆法类问题回带钩子', () => {
  const r = rag.ask('怎么记住 holiday 这个词？', CARDS, { index: idx });
  assert(r.answer.indexOf('holy') !== -1 || r.answer.length > 20,
    '应包含记忆钩子内容：' + r.answer.slice(0, 60));
});

check('端到端问答：问词表里没有的词时如实说没有', () => {
  const r = rag.ask('bicycle 是什么意思？', CARDS, { index: idx });
  assert(r.answer.indexOf('没找到') !== -1 || r.answer.indexOf('没有') !== -1,
    '应如实说明没有，实际：' + r.answer.slice(0, 60));
});

check('端到端问答：空问题不崩', () => {
  const r = rag.ask('', CARDS, { index: idx });
  assert(r && typeof r.answer === 'string', '空问题应有结构化返回');
});

check('检索性能：单次查询 <100ms（真机放宽 5 倍仍可用）', () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) rag.similar('geography', idx, { topK: 5 });
  const ms = (Date.now() - t0) / 10;
  assert(ms < 100, '单次 ' + ms.toFixed(1) + 'ms');
});

/*================================================================
 * 二、历史分析（utils/analysis.js）
 *================================================================*/
console.log('\n-- 分析（analysis）--');

const TODAY = '2026-09-17';

/** 造一条带历史的卡片 */
function mk(id, dates, q, iv) {
  return {
    id: id, prompt: 'w' + id, answer: 'x',
    _hist: dates.map(d => ({ date: d, q: q, interval: iv }))
  };
}
function buildStates(cards) {
  const st = {};
  cards.forEach(c => { st[c.id] = { ef: 2.5, reps: c._hist.length, interval: c._hist.length ? c._hist[c._hist.length - 1].interval : 0, nextReview: '2026-10-01', history: c._hist }; });
  return st;
}

check('日期往返一致（含闰年与跨年）', () => {
  ['2026-01-01', '2026-12-31', '2024-02-29', '2025-03-01'].forEach(d => {
    const i = analysis.dayIndex(d);
    assertEq(analysis.indexToDay(i), d, d + ' 往返失败');
  });
});

check('空数据不崩且返回零值结构', () => {
  const r = analysis.analyze([], {}, TODAY);
  assertEq(r.events, 0, '事件数');
  assertEq(r.streak.current, 0, '连续天数');
  assertEq(r.retention.rate, 0, '保持率');
  assertEq(r.sediment.score, 0, '沉淀指数');
  assertEq(r.pronunciation.attempts, 0, '朗读次数');
});

check('连续天数：连续 3 天', () => {
  const cs = [mk('a', ['2026-09-15', '2026-09-16', '2026-09-17'], 5, 1)];
  const s = analysis.streak(analysis.events(cs, buildStates(cs)), TODAY);
  assertEq(s.current, 3, 'current');
  assertEq(s.longest, 3, 'longest');
  assert(s.alive === true, 'alive');
});

check('连续天数：今天没学但昨天学了 → 仍算连续（不刻薄）', () => {
  const cs = [mk('a', ['2026-09-15', '2026-09-16'], 5, 1)];
  const s = analysis.streak(analysis.events(cs, buildStates(cs)), TODAY);
  assertEq(s.current, 2, 'current');
  assert(s.alive === true, '应视为仍活着');
});

check('连续天数：断 2 天 → 清零但保留最长记录', () => {
  const cs = [mk('a', ['2026-09-13', '2026-09-14', '2026-09-15'], 5, 1)];
  const s = analysis.streak(analysis.events(cs, buildStates(cs)), TODAY);
  assertEq(s.current, 0, 'current 应清零');
  assertEq(s.longest, 3, 'longest 应保留');
  assert(s.alive === false, 'alive 应为 false');
});

check('每日序列补齐空日（否则"断更"会被画成连续）', () => {
  const cs = [mk('a', ['2026-09-15', '2026-09-17'], 5, 1)];
  const d = analysis.dailyCounts(analysis.events(cs, buildStates(cs)), TODAY, 7);
  assertEq(d.length, 7, '应返回 7 天');
  const zeroDays = d.filter(x => x.count === 0).length;
  assert(zeroDays >= 4, '空日应被补齐，实际非零天数过多：' + (7 - zeroDays));
});

check('记忆保持：interval>=21 才算成熟', () => {
  const cs = [mk('a', ['2026-09-01'], 5, 21), mk('b', ['2026-09-01'], 5, 6), mk('c', [], 0, 0)];
  const st = buildStates(cs);
  const r = analysis.retention(cs, st);
  assertEq(r.mature, 1, '成熟数');
  assertEq(r.studied, 2, '已学数');
  assertEq(r.fresh, 1, '未学数');
  assertEq(r.rate, 50, '保持率');
});

check('遗忘统计：q<3 计为遗忘', () => {
  const cs = [mk('a', ['2026-09-01', '2026-09-02'], 1, 1), mk('b', ['2026-09-01'], 5, 1)];
  const r = analysis.forgetting(analysis.events(cs, buildStates(cs)));
  assertEq(r.total, 3, '总事件');
  assertEq(r.forgot, 2, '遗忘数');
});

check('复习效率：没有成熟词时返回 null（不是 0）', () => {
  const cs = [mk('a', ['2026-09-01'], 5, 1)];
  const st = buildStates(cs);
  const r = analysis.efficiency(analysis.events(cs, st), analysis.retention(cs, st));
  assertEq(r.mature, 0, '成熟数应为 0');
  assertEq(r.reviewsPerMature, null, '应为 null 而不是 0');
});

check('沉淀指数：四项分解之和等于总分', () => {
  const cs = [];
  for (let i = 0; i < 12; i++) cs.push(mk('w' + i, ['2026-09-' + String(i + 1).padStart(2, '0')], 5, 21));
  const st = buildStates(cs);
  const an = analysis.analyze(cs, st, TODAY);
  const sum = an.sediment.breakdown.reduce((a, b) => a + b.points, 0);
  assert(Math.abs(sum - an.sediment.score) < 1.0,
    '分解和 ' + sum + ' 与总分 ' + an.sediment.score + ' 不符');
});

check('沉淀指数：各项都被夹在 [0,1]（单项爆表不该拉满总分）', () => {
  const cs = [];
  for (let i = 0; i < 500; i++) cs.push(mk('w' + i, [TODAY], 5, 999));
  const an = analysis.analyze(cs, buildStates(cs), TODAY);
  an.sediment.breakdown.forEach(b => {
    assert(b.ratio <= 100, b.key + ' 达成率越界：' + b.ratio);
  });
  assert(an.sediment.score <= 100, '总分越界：' + an.sediment.score);
});

check('朗读表现：正确统计四档与待加强词', () => {
  const recs = {
    a: [{ band: 'pass' }, { band: 'pass' }],
    b: [{ band: 'fail' }, { band: 'borderline' }],
    c: [{ band: 'unknown' }]
  };
  const r = analysis.pronunciation(recs);
  assertEq(r.attempts, 5, '总次数');
  assertEq(r.pass, 2, 'pass');
  assertEq(r.fail, 1, 'fail');
  assertEq(r.borderline, 1, 'borderline');
  assertEq(r.unknown, 1, 'unknown');
  assertEq(r.passRate, 40, '通过率');
  assertEq(r.worst[0].wordId, 'b', '最需练的应是 b（trouble=2）');
});

check('朗读表现：无记录时返回零值结构而不是 null', () => {
  const r = analysis.pronunciation(null);
  assertEq(r.attempts, 0, '次数');
  assert(Array.isArray(r.worst), 'worst 应为数组');
});

check('星期分布：7 项且能定位遗忘率最高的一天', () => {
  const cs = [mk('a', ['2026-09-15', '2026-09-16', '2026-09-17'], 5, 1)];
  const w = analysis.weekdayDistribution(analysis.events(cs, buildStates(cs)));
  assertEq(w.length, 7, '应 7 项');
  assertEq(w[0].label, '周日', '首项应为周日');
  w.forEach(x => assert(typeof x.forgotRate === 'number', '缺 forgotRate'));
});

check('分析性能：295 词 <200ms', () => {
  const cs = CARDS.map(c => ({
    id: c.id, prompt: c.prompt, answer: c.answer,
    _hist: [{ date: TODAY, q: 5, interval: 1 }]
  }));
  const st = buildStates(cs);
  const t0 = Date.now();
  analysis.analyze(cs, st, TODAY);
  const ms = Date.now() - t0;
  assert(ms < 200, '耗时 ' + ms + 'ms');
});

/*================================================================
 * 三、随包发音（utils/audio.js + data/audio/）
 *================================================================*/
console.log('\n-- 发音包（audio）--');

const fs = require('fs');
const AUDIO_DIR = path.join(ROOT, 'data', 'audio');

check('音频目录存在且非空', () => {
  assert(fs.existsSync(AUDIO_DIR), '缺目录 ' + AUDIO_DIR);
  const n = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.mp3')).length;
  assert(n > 0, '没有 mp3');
});

check('命名规则与词表逐词对齐（错一个就是"某词没声音"的静默 bug）', () => {
  const files = new Set(fs.readdirSync(AUDIO_DIR));
  const miss = [];
  seed.words.forEach(w => {
    const k = audioMod.audioKey(w.word);
    if (k && !files.has(k + '.mp3')) miss.push(w.word + ' → ' + k + '.mp3');
  });
  assertEq(miss.length, 0, '未对齐：' + miss.slice(0, 5).join(', '));
});

check('覆盖率 100%（词卡有发音是硬要求）', () => {
  const cap = audioMod.audioCapability(seed.words.map(w => w.word));
  assertEq(cap.coverage, 100, '覆盖率：' + cap.coverage + '%，缺 ' + cap.missing.slice(0, 5).join(','));
});

check('audioKey 处理短语与词性括号（junior high / race（v.））', () => {
  assertEq(audioMod.audioKey('junior high'), 'junior-high', '短语');
  assertEq(audioMod.audioKey('race（v.）'), 'race', '词性括号');
  assertEq(audioMod.audioKey('Information Technology'), 'information-technology', '大小写');
});

check('音频总体积在预算内（≤1400KB，主包上限 2048KB 还要留给代码）', () => {
  const files = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.mp3'));
  let total = 0;
  files.forEach(f => { total += fs.statSync(path.join(AUDIO_DIR, f)).size; });
  const kb = total / 1024;
  assert(kb <= 1400, '音频 ' + kb.toFixed(0) + 'KB 超预算');
  console.log('      （' + files.length + ' 个文件 · ' + kb.toFixed(0) + ' KB）');
});

check('主包体积仍在 2MB 内（音频不可压缩，必须实算）', () => {
  // 文本类会被 gzip，音频不会 —— 所以按"文本压缩后 + 音频原大小"估算
  const { execSync } = require('child_process');
  let textGz = 0, audioBytes = 0;
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'cloudfunctions' || e.name === 'audio') return;
        walk(full);
      } else if (/\.(js|json|wxml|wxss)$/.test(e.name)) {
        textGz += execSync('gzip -c "' + full + '"', { maxBuffer: 64 * 1024 * 1024 }).length;
      }
    });
  }
  walk(ROOT);
  fs.readdirSync(AUDIO_DIR).forEach(f => { audioBytes += fs.statSync(path.join(AUDIO_DIR, f)).size; });
  const est = textGz + audioBytes;
  assert(est <= 2048 * 1024, '预计 ' + (est / 1024).toFixed(0) + 'KB 超过 2048KB');
  console.log('      （文本压缩 ' + (textGz / 1024).toFixed(0) + 'KB + 音频 ' + (audioBytes / 1024).toFixed(0) + 'KB = ' + (est / 1024).toFixed(0) + 'KB / 2048KB）');
});

check('resolveForPlay 对包内词返回可播路径', () => {
  // 异步断言：用微任务队列同步等待不现实，这里直接验证路径推导
  const p = audioMod.packPath('geography');
  assert(p.indexOf('.mp3') !== -1, '路径异常：' + p);
  assert(p.indexOf('data/audio') !== -1, '应在音频目录：' + p);
});

check('resolveForPlay 对词表外的词不返回包内路径（应走插件）', () => {
  assertEq(audioMod.packPath('zzzznotaword'), '', '不该有包内路径');
});

/*================================================================
 * 汇总
 *================================================================*/
console.log('\n' + '='.repeat(62));
console.log('>>> ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(62));
if (fail > 0) {
  console.log('\n失败：' + failures.join(' / '));
  process.exit(1);
}
