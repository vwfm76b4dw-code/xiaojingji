/**
 * AI 服务层验证 —— 覆盖前端校验/降级逻辑与云函数纯函数。
 * 全部离线运行，不消耗模型额度、不依赖云环境。
 * 运行：node tools/verify-ai.js
 *
 * 联网实测另跑：GLM_API_KEY=xxx node tools/check-ai-live.js
 */
const assert = require('assert');
const path = require('path');

const aiCore = require('../miniprogram/utils/ai-core.js');

// 云函数纯函数（不触发网络）
const fn = require(path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'aiProxy', 'index.js'));
const I = fn._internal;

let pass = 0, fail = 0;
function check(name, f) {
  try { f(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

/*---------- 一、ai-core：AI 返回值的清洗与校验 ----------*/

check('归一化：正常词条原样保留', () => {
  const out = aiCore.normalizeItems([
    { word: 'abandon', meaning: 'v. 遗弃' },
    { word: 'abundant', meaning: 'adj. 丰富的' }
  ]);
  assert.deepStrictEqual(out, [
    { word: 'abandon', meaning: 'v. 遗弃' },
    { word: 'abundant', meaning: 'adj. 丰富的' }
  ]);
});

check('归一化：丢弃非英文"单词"（防模型编造中文或句子）', () => {
  const out = aiCore.normalizeItems([
    { word: '单词', meaning: 'word' },
    { word: 'a whole sentence here that is way too long for any phrase', meaning: '九词长句 → 非法（上限 8 词）' },
    { word: '123abc', meaning: '数字开头' },              // 数字开头 → 非法
    { word: 'abandon', meaning: 'v. 遗弃' },
    { word: 'well-known', meaning: 'adj. 著名的' },        // 连字符合法
    { word: "don't", meaning: '缩写' }                     // 撇号合法
  ]);
  assert.deepStrictEqual(out.map(x => x.word), ['abandon', 'well-known', "don't"]);
});

check('归一化：接受词组与习语（五词以内），超过 8 词仍拒绝', () => {
  const out = aiCore.normalizeItems([
    { word: 'look after', meaning: '照顾' },
    { word: 'a bit', meaning: '一点儿' },
    { word: 'as happy as a clam', meaning: '非常快活' }
  ]);
  // 2026-09-19 放宽到 8 词：'as happy as a clam'（5 词）这类习语合法
  assert.deepStrictEqual(out.map(x => x.word), ['look after', 'a bit', 'as happy as a clam']);
});

check('归一化：缺字段的条目被丢弃，不产生半条数据', () => {
  const out = aiCore.normalizeItems([
    { word: 'abandon' },
    { meaning: '没有单词' },
    { word: '', meaning: '' },
    { word: 'valid', meaning: 'adj. 有效的' }
  ]);
  assert.deepStrictEqual(out.map(x => x.word), ['valid']);
});

check('归一化：忽略大小写去重，保留首次出现', () => {
  const out = aiCore.normalizeItems([
    { word: 'Abandon', meaning: '第一条' },
    { word: 'abandon', meaning: '重复条' }
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].meaning, '第一条');
});

check('归一化：非数组输入返回空数组而非抛错', () => {
  assert.deepStrictEqual(aiCore.normalizeItems(null), []);
  assert.deepStrictEqual(aiCore.normalizeItems('字符串'), []);
  assert.deepStrictEqual(aiCore.normalizeItems(undefined), []);
});

check('归一化：条目数上限 50 条（防模型刷屏）', () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ word: 'word' + 'abcdefghij'[i % 10] + i, meaning: '释义' + i });
  // 上面的构造会带数字，改用纯字母：word + 两个字母
  const pure = [];
  const A = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 80; i++) pure.push({ word: 'w' + A[i % 26] + A[Math.floor(i / 26) % 26], meaning: '释义' + i });
  assert.strictEqual(aiCore.normalizeItems(pure).length, 50);
  assert.ok(aiCore.normalizeItems(many).length < 50, '带数字的词应被过滤');
});

check('清洗：去掉模型爱加的引号并折叠空白', () => {
  assert.strictEqual(aiCore.cleanText('"v. 遗弃"', 50), 'v. 遗弃');
  assert.strictEqual(aiCore.cleanText(' “adj.  丰富的” ', 50), 'adj. 丰富的');
});

check('拆分：与现有词库重复的进 dup，新词进 fresh', () => {
  const r = aiCore.partitionNew(
    [{ word: 'abandon', meaning: 'a' }, { word: 'NewWord', meaning: 'b' }],
    [{ word: 'ABANDON' }]
  );
  assert.deepStrictEqual(r.fresh.map(x => x.word), ['NewWord']);
  assert.deepStrictEqual(r.dup.map(x => x.word), ['abandon']);
});

check('降级文案：每种失败都有可执行的中文提示，且不含错误码', () => {
  const codes = ['NO_CLOUD', 'NO_ITEMS', 'TIMEOUT', 'NETWORK', 'UPSTREAM_429'];
  codes.forEach(c => {
    const m = aiCore.degradeHint('parseBatch', c);
    assert.ok(m && m.length > 0, c + ' 缺文案');
    assert.ok(!/[A-Z_]{4,}/.test(m), c + ' 文案里混进了错误码：' + m);
    assert.ok(!/异常|未知错误|undefined/.test(m), c + ' 文案有裸报错词：' + m);
  });
});

/*---------- 二、云函数纯逻辑（与线上同一份代码） ----------*/

check('云函数：extractJson 能抠掉 ```json 围栏', () => {
  const r = I.extractJson('```json\n{"items":[{"word":"a","meaning":"b"}]}\n```');
  assert.strictEqual(r.items[0].word, 'a');
});

check('云函数：extractJson 能容忍前后废话', () => {
  const r = I.extractJson('好的，结果如下：{"items":[{"word":"a","meaning":"b"}]} 希望有帮助');
  assert.strictEqual(r.items[0].meaning, 'b');
});

check('云函数：extractJson 对无法解析的文本返回 null 而非抛错', () => {
  assert.strictEqual(I.extractJson('完全没有 JSON'), null);
  assert.strictEqual(I.extractJson(''), null);
  assert.strictEqual(I.extractJson(null), null);
});

check('云函数：pickText 兼容 content 为数组（多段返回）', () => {
  assert.strictEqual(I.pickText({ choices: [{ message: { content: '纯文本' } }] }), '纯文本');
  assert.strictEqual(I.pickText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.strictEqual(I.pickText({}), '');
});

check('云函数：单词校验与前端同口径（两边都挡非法词）', () => {
  assert.ok(I.WORD_RE.test('abandon'));
  assert.ok(!I.WORD_RE.test('123'));
  assert.ok(!I.WORD_RE.test('两个词'));
  assert.strictEqual(I.WORD_RE.source, aiCore.WORD_RE.source);
});

check('云函数：三条能力的提示词都包含格式约束', () => {
  const p = I.buildMessages('parseBatch', { text: 'abandon 遗弃' });
  assert.strictEqual(p.length, 2);
  assert.ok(/只输出 JSON/.test(p[0].content), 'parseBatch 应约束输出 JSON');

  const e = I.buildMessages('genExample', { word: 'review', meaning: 'v. 复习' });
  assert.ok(/只输出英文句子/.test(e[0].content), 'genExample 应约束输出纯英文句子');
  assert.ok(/review/.test(e[1].content), 'genExample 应带上目标单词');

  const m = I.buildMessages('genMnemonic', { word: 'review' });
  assert.ok(/→/.test(m[0].content), 'genMnemonic 应给出 → 风格的示例');
});

check('云函数：未知 action 返回 null（由 main 折算成 BAD_ACTION）', () => {
  assert.strictEqual(I.buildMessages('不存在的能力', {}), null);
  assert.strictEqual(I.buildMessages(undefined, {}), null);
});

check('云函数：提示词长度受控（防超长输入烧额度）', () => {
  const huge = 'a'.repeat(5000);
  const p = I.buildMessages('parseBatch', { text: huge });
  const sent = p[1].content;
  assert.ok(sent.length < 3000, '送入模型的文本应被截断，实际 ' + sent.length);
});

/*---------- 二·补、清洗/校验/降级文案的边界（补充覆盖） ----------*/

const PRESET = require('../miniprogram/data/words.js');

check('清洗：null / undefined / 数字入参不抛错（AI 少给字段是常态）', () => {
  assert.strictEqual(aiCore.cleanText(null, 10), '', 'cleanText(null) 期望 ""，实际 ' + JSON.stringify(aiCore.cleanText(null, 10)));
  assert.strictEqual(aiCore.cleanText(undefined, 10), '', 'cleanText(undefined) 期望 ""，实际 ' + JSON.stringify(aiCore.cleanText(undefined, 10)));
  assert.strictEqual(aiCore.cleanText(0, 10), '0', 'cleanText(0) 期望 "0"，实际 ' + JSON.stringify(aiCore.cleanText(0, 10)));
});

check('清洗：max 截断生效（超长释义不留尾）', () => {
  const got = aiCore.cleanText('abcdefghij', 4);
  assert.strictEqual(got, 'abcd', "cleanText('abcdefghij',4) 期望 abcd，实际 " + got);
});

check('清洗：只剥成对引号，词内撇号不能被吃掉（don\'t 必须保留撇号）', () => {
  assert.strictEqual(aiCore.cleanText('"hello"', 20), 'hello', '期望剥掉成对双引号');
  assert.strictEqual(aiCore.cleanText('“中文引号”', 20), '中文引号', '期望剥掉成对中文引号');
  const apostrophe = aiCore.cleanText("don't", 20);
  assert.strictEqual(apostrophe, "don't", "cleanText(\"don't\") 期望保留撇号，实际 " + apostrophe);
});

check('WORD_RE：接受连字符 / 撇号 / 二至三词词组', () => {
  const okCases = ['abandon', 'well-known', "don't", 'look after', 'a bit of',
                   'Ethics and the rule of law'];
  okCases.forEach(function (w) {
    assert.ok(aiCore.WORD_RE.test(w), '应接受 "' + w + '"，实际被拒');
  });
});

check('WORD_RE：拒绝数字 / 下划线 / 首字符非字母 / 八词以上 / 非 ASCII / 空串（2026-09-19 放宽到 8 词短语）', () => {
  const badCases = ['abandon1', '_word', ' word', 'a bit of luck today please now my friend', 'café', '', '123', '-abc'];
  badCases.forEach(function (w) {
    assert.ok(!aiCore.WORD_RE.test(w), '应拒绝 ' + JSON.stringify(w) + '，实际被接受');
  });
});

check('归一化：非数组 / 空数组 / 全空条目 → 空数组（不抛错）', () => {
  assert.deepStrictEqual(aiCore.normalizeItems('not an array'), [], '字符串入参期望 []');
  assert.deepStrictEqual(aiCore.normalizeItems([]), [], '空数组期望 []');
  assert.deepStrictEqual(aiCore.normalizeItems([null, undefined, {}]), [], '脏条目期望 []');
});

check('归一化：超长单词被截断到 60 字符后再校验', () => {
  const out = aiCore.normalizeItems([{ word: 'a'.repeat(80), meaning: 'x' }]);
  assert.strictEqual(out.length, 1, '截断后仍是合法英文，应保留 1 条，实际 ' + out.length);
  assert.strictEqual(out[0].word.length, 60, '单词应截断到 60 字符，实际 ' + out[0].word.length);
});

check('归一化：MAX_ITEMS 常量锁定为 50（防模型刷屏的口径）', () => {
  assert.strictEqual(aiCore.MAX_ITEMS, 50, '期望 50，实际 ' + aiCore.MAX_ITEMS);
});

check('拆分：items / existingWords 为 undefined 时不抛错，全部算新词', () => {
  const a = aiCore.partitionNew(undefined, undefined);
  assert.deepStrictEqual(a, { fresh: [], dup: [] }, '全 undefined 期望空结果，实际 ' + JSON.stringify(a));
  const b = aiCore.partitionNew([{ word: 'x' }], [null, undefined, {}]);
  assert.strictEqual(b.fresh.length, 1, '脏 existingWords 不该影响判定，期望 fresh=1，实际 ' + b.fresh.length);
});

check('拆分：现有词库大小写混排仍能识别重复', () => {
  const r = aiCore.partitionNew([{ word: 'ABANDON' }], [{ word: 'Abandon' }]);
  assert.strictEqual(r.dup.length, 1, '忽略大小写应判为重复，实际 dup=' + r.dup.length);
  assert.strictEqual(r.fresh.length, 0, '不该进 fresh，实际 ' + r.fresh.length);
});

check('降级文案：三种失败码各有可执行提示，未知码/未知能力有兜底', () => {
  const noCloud = aiCore.degradeHint('parseBatch', 'NO_CLOUD');
  const noItems = aiCore.degradeHint('parseBatch', 'NO_ITEMS');
  const unknown = aiCore.degradeHint('parseBatch', '某个没见过的码');
  assert.ok(/批量粘贴/.test(noCloud), 'NO_CLOUD 应引导用户改用批量粘贴，实际 ' + noCloud);
  assert.ok(/批量粘贴/.test(noItems), 'NO_ITEMS 应引导用户改用批量粘贴，实际 ' + noItems);
  assert.ok(/批量粘贴/.test(unknown), '未知码应走通用文案且仍给出口，实际 ' + unknown);
  assert.ok(aiCore.degradeHint('genExample', 'X').length > 0, 'genExample 文案不该为空');
  assert.ok(aiCore.degradeHint('genMnemonic', 'X').length > 0, 'genMnemonic 文案不该为空');
  assert.strictEqual(aiCore.degradeHint('没这个能力', 'X'), 'AI 暂时不可用', '未知能力应有兜底文案');
});

check('降级文案：全部不含错误码、不含「异常」「失败」这类裸报错词', () => {
  const codes = ['NO_CLOUD', 'NO_ITEMS', 'CALL_FAILED', 'CALL_THREW', 'UNKNOWN', undefined];
  const actions = ['parseBatch', 'genExample', 'genMnemonic', '没这个能力'];
  const bad = [];
  actions.forEach(function (a) {
    codes.forEach(function (c) {
      const msg = aiCore.degradeHint(a, c);
      if (!msg || typeof msg !== 'string') bad.push(a + '/' + c + ' 文案为空');
      if (/[A-Z_]{3,}/.test(msg)) bad.push(a + '/' + c + ' 含错误码：' + msg);
      if (/异常|失败/.test(msg)) bad.push(a + '/' + c + ' 含裸报错词：' + msg);
    });
  });
  assert.deepStrictEqual(bad, [], '发现不合规文案：' + bad.join('; '));
});

check('云函数：extractJson 能抠出数组形式，空输入返回 null', () => {
  assert.deepStrictEqual(I.extractJson('[1,2,3]'), [1, 2, 3], '纯数组应直接解析');
  assert.deepStrictEqual(I.extractJson('好的 [1,2,3] 完毕'), [1, 2, 3], '前后有废话的数组应被抠出');
  assert.strictEqual(I.extractJson(''), null, '空串期望 null，实际 ' + JSON.stringify(I.extractJson('')));
  assert.strictEqual(I.extractJson(null), null, 'null 期望 null，实际 ' + JSON.stringify(I.extractJson(null)));
});

check('云函数：pickText 覆盖缺字段 / content 为对象 / 忽略思考过程', () => {
  assert.strictEqual(I.pickText(null), '', 'null 期望 ""');
  assert.strictEqual(I.pickText({}), '', '无 choices 期望 ""');
  assert.strictEqual(I.pickText({ choices: [] }), '', '空 choices 期望 ""');
  assert.strictEqual(I.pickText({ choices: [{ message: { content: {} } }] }), '',
    'content 为对象（非字符串非数组）期望 ""');
  const withReasoning = I.pickText({
    choices: [{ message: { reasoning_content: '这是一段思考过程', content: '最终答案' } }]
  });
  assert.strictEqual(withReasoning, '最终答案', '应只取 content，忽略 reasoning_content，实际 ' + withReasoning);
});

check('跨层一致：云函数 clean 与前端 cleanText 同口径（同一输入必须同一输出）', () => {
  const samples = ['  a   b  ', '"quoted"', '“中文”', null, undefined, 123, '', '  '];
  const diffs = [];
  samples.forEach(function (s) {
    const a = I.clean(s, 200);
    const b = aiCore.cleanText(s, 200);
    if (a !== b) diffs.push(JSON.stringify(s) + ' → 云函数 ' + JSON.stringify(a) + ' / 前端 ' + JSON.stringify(b));
  });
  assert.deepStrictEqual(diffs, [], '两层清洗口径不一致：' + diffs.join('; '));
});

check('云函数：parseBatch 文本截断到 2000 字符（MAX_TEXT 精确钉住）', () => {
  const base = I.buildMessages('parseBatch', { text: '' })[1].content;
  const huge = I.buildMessages('parseBatch', { text: 'a'.repeat(5000) })[1].content;
  assert.strictEqual(huge.length, base.length + 2000,
    '期望恰好多出 2000 字符，实际多出 ' + (huge.length - base.length));
});

check('云函数：genExample 的释义截断到 200 字符（MAX_FIELD 精确钉住）', () => {
  const base = I.buildMessages('genExample', { word: 'w', meaning: '' })[1].content;
  const long = I.buildMessages('genExample', { word: 'w', meaning: 'm'.repeat(500) })[1].content;
  assert.strictEqual(long.length, base.length + 200,
    '期望恰好多出 200 字符，实际多出 ' + (long.length - base.length));
});

check('云函数：payload 缺失时不抛错（event 只有 action 的调用是合法的）', () => {
  const p = I.buildMessages('parseBatch', undefined);
  assert.ok(Array.isArray(p) && p.length === 2, '缺 payload 仍应产出两条消息，实际 ' + JSON.stringify(p && p.length));
});

check('云函数：归一化与前端同口径（去重忽略大小写 + 上限 50）', () => {
  const dup = I.normalizeItems([
    { word: 'Abandon', meaning: '第一个' },
    { word: 'ABANDON', meaning: '第二个' }
  ]);
  assert.strictEqual(dup.length, 1, '忽略大小写应去重为 1 条，实际 ' + dup.length);
  assert.strictEqual(dup[0].meaning, '第一个', '应保留首次出现，实际 ' + dup[0].meaning);

  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ word: 'zz' + String.fromCharCode(97 + i % 26) + String.fromCharCode(97 + Math.floor(i / 26)), meaning: 'm' + i });
  }
  assert.strictEqual(I.normalizeItems(many).length, 50,
    '60 条合法输入应被截到 50，实际 ' + I.normalizeItems(many).length);
});

check('清洗：内层引号必须保留，只有单侧引号才剥离（最易被重构写坏的一条）', () => {
  assert.strictEqual(aiCore.cleanText('say "hi" now', 50), 'say "hi" now',
    '内层引号必须原样保留，实际 ' + JSON.stringify(aiCore.cleanText('say "hi" now', 50)));
  assert.strictEqual(aiCore.cleanText('"abc', 50), 'abc',
    '只有左引号也应剥掉，实际 ' + JSON.stringify(aiCore.cleanText('"abc', 50)));
  assert.strictEqual(aiCore.cleanText('“hello\'s”', 50), "hello's",
    '中英引号混用应只剥外层、保留撇号，实际 ' + JSON.stringify(aiCore.cleanText('“hello\'s”', 50)));
});

check('归一化：折叠制表符与内部多空格，脏元素直接跳过', () => {
  const a = aiCore.normalizeItems([{ word: '  abandon\t', meaning: '  v. 遗弃 ' }]);
  assert.deepStrictEqual(a, [{ word: 'abandon', meaning: 'v. 遗弃' }],
    '期望去空白后的干净词条，实际 ' + JSON.stringify(a));
  const b = aiCore.normalizeItems([{ word: 'look  after', meaning: '照顾' }]);
  assert.strictEqual(b[0].word, 'look after',
    '内部双空格应折叠成一个，实际 ' + JSON.stringify(b[0].word));
  const c = aiCore.normalizeItems([null, undefined, { word: 'ok', meaning: 'x' }]).map(x => x.word);
  assert.deepStrictEqual(c, ['ok'], 'null/undefined 元素应被跳过，实际 ' + JSON.stringify(c));
});

check('WORD_RE 现状记录：尾部空格 / 连字符开头被拒；连字符结尾 / 多撇号被放行', () => {
  assert.strictEqual(aiCore.WORD_RE.test('abandon '), false, '尾部空格应被拒');
  assert.strictEqual(aiCore.WORD_RE.test('-abc'), false, '连字符开头应被拒');
  assert.strictEqual(aiCore.WORD_RE.test('abc-'), true, '现状：连字符结尾被放行（口径偏宽，已知并记录）');
  assert.strictEqual(aiCore.WORD_RE.test("a'b'c"), true, '现状：多撇号被放行（口径偏宽，已知并记录）');
});

check('云函数：extractJson 对半截 JSON 返回 null 而非抛错', () => {
  const got = I.extractJson('{"items":[{"word":"a"');
  assert.strictEqual(got, null, '半截 JSON 期望 null，实际 ' + JSON.stringify(got));
});

/*---------- 三、AiGateway 降级契约（用 mock wx 驱动真实 ai.js） ----------*/

/** 用假的 wx 替换全局，模拟云开发的三种结局：成功 / 调用失败 / 未开通 */
function mockWx(mode, result) {
  global.wx = {
    cloud: {
      callFunction(opts) {
        if (mode === 'fail') return opts.fail({ errMsg: 'request:fail' });
        if (mode === 'throw') throw new Error('boom');
        opts.success({ result: result });
      }
    }
  };
}

/** 清掉 require 缓存，让 ai.js 按当前 mock 重新加载 */
function loadAi() {
  delete require.cache[require.resolve('../miniprogram/utils/ai.js')];
  return require('../miniprogram/utils/ai.js');
}

/*---------- 四、端到端：云函数 main 在无 Key 时安全失败 ----------*/

(async function () {
  // ---- 先跑网关测试（需要 async）----
  const saved = process.env.GLM_API_KEY;
  const savedWx = global.wx;

  // 4.1 云开发未就绪：如实报告不可用，且给出可执行提示
  delete global.wx;
  let ai = loadAi();
  check('网关：云开发未就绪时 isAvailable=false', () => {
    assert.strictEqual(ai.isAvailable(), false);
  });

  await (async function () {
    const r = await ai.parseBatch('abandon 遗弃', []);
    check('网关：未开通云开发时返回 ok:false + 可执行提示（不抛错）', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'NO_CLOUD');
      assert.ok(r.msg && r.msg.length > 0, '应给出提示文案');
      assert.ok(!/NO_CLOUD/.test(r.msg), '文案里不该出现错误码');
    });
  })();

  // 4.2 云函数调用失败（网络/超时/上游报错都走这条）：静默降级
  mockWx('fail');
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('abandon 遗弃', []);
    check('网关：云函数调用失败 → 返回 ok:false 并由界面走降级', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'CALL_FAILED');
    });
  })();

  // 4.3 wx.cloud 抛异常也不能穿透到页面
  mockWx('throw');
  ai = loadAi();
  await (async function () {
    let threw = false;
    let r;
    try { r = await ai.parseBatch('abandon 遗弃', []); }
    catch (e) { threw = true; }
    check('网关：wx.cloud 抛异常时不穿透（页面无需写 try/catch）', () => {
      assert.strictEqual(threw, false, 'ai.js 不应把异常抛给调用方');
      assert.strictEqual(r.ok, false);
    });
  })();

  // 4.4 成功路径：解析结果按现有词库剔重
  mockWx('ok', { ok: true, data: { items: [{ word: 'abandon', meaning: 'v. 遗弃' }, { word: 'review', meaning: 'v. 复习' }] } });
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('随便什么', [{ word: 'ABANDON' }]);
    check('网关：成功路径剔重正确（重复的计入 dupCount，不进 items）', () => {
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.items.map(x => x.word), ['review']);
      assert.strictEqual(r.dupCount, 1);
    });
  })();

  // 4.5 例句生成失败 → 回退预置库例句（Preset 是降级兜底，不是报错）
  mockWx('fail');
  ai = loadAi();
  await (async function () {
    const r = await ai.genExample('ability', 'n. 能力');
    check('网关：例句生成失败 → 回退预置库例句并如实标注来源', () => {
      assert.strictEqual(r.ok, true, '预置库有内容就不该算失败');
      assert.strictEqual(r.fromPreset, true);
      assert.ok(r.value.length > 0);
      assert.strictEqual(r.value, ai.PRESET_MAP['ability'].example);
    });

    const r2 = await ai.genExample('zzzznotexist', 'n. 不存在');
    check('网关：预置库也没有的词 → 返回 ok:false + 提示，由界面让用户自己写', () => {
      assert.strictEqual(r2.ok, false);
      assert.strictEqual(r2.fromPreset, false);
      assert.ok(r2.msg && r2.msg.length > 0);
    });
  })();

  // 4.6 空输入不消耗网络调用
  mockWx('ok', { ok: true, data: { items: [] } });
  ai = loadAi();
  await (async function () {
    let called = false;
    global.wx.cloud.callFunction = function () { called = true; };
    const r = await ai.parseBatch('   ', []);
    check('网关：空输入直接拦下，不发请求', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(called, false);
    });
  })();

  // 4.7 AI 返回的条目全部非法 → 如实报"没认出"，而不是假装成功给个空列表
  mockWx('ok', { ok: true, data: { items: [{ word: '中文不是单词', meaning: 'x' }, { word: '', meaning: 'y' }] } });
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('随便写点什么', []);
    check('网关：AI 返回的条目全非法 → ok:false + NO_ITEMS 引导（不假装成功）', () => {
      assert.strictEqual(r.ok, false, '全非法应判失败，实际 ok=' + r.ok);
      assert.strictEqual(r.code, 'NO_ITEMS');
      assert.deepStrictEqual(r.items, [], 'items 应为空数组，实际 ' + JSON.stringify(r.items));
      assert.ok(/批量粘贴/.test(r.msg), '应引导用户改用批量粘贴，实际 ' + r.msg);
    });
  })();

  // 4.8 AI 正常返回例句 → 如实标注不是预置内容
  mockWx('ok', { ok: true, data: { example: 'She has the ability to solve hard problems.' } });
  ai = loadAi();
  await (async function () {
    const r = await ai.genExample('ability', 'n. 能力');
    check('网关：AI 成功返回例句 → fromPreset=false 且内容不被改写', () => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.fromPreset, false, 'AI 生成的不该标成预置');
      assert.strictEqual(r.code, 'OK');
      assert.strictEqual(r.value, 'She has the ability to solve hard problems.');
    });
  })();

  // 4.9 AI 只返回空白 → 视为"没生成出来"，走预置库兜底
  mockWx('ok', { ok: true, data: { mnemonic: '   ' } });
  ai = loadAi();
  await (async function () {
    const r = await ai.genMnemonic('ability');
    check('网关：AI 只返回空白内容 → 不算成功，降级到预置库记忆法', () => {
      assert.strictEqual(r.ok, true, '预置库有内容就不该算失败');
      assert.strictEqual(r.fromPreset, true, '应如实标注来自预置库');
      assert.strictEqual(r.value, ai.PRESET_MAP['ability'].mnemonic);
      assert.ok(r.value.length > 0, '兜底内容不该为空');
    });
  })();

  // 4.10 genMnemonic 空单词：本地拦下，不消耗一次云函数调用
  mockWx('ok', { ok: true, data: { mnemonic: 'x' } });
  ai = loadAi();
  await (async function () {
    let called = false;
    global.wx.cloud.callFunction = function () { called = true; };
    const r = await ai.genMnemonic('   ');
    check('网关：genMnemonic 空单词 → EMPTY_WORD 且不发请求（省一次额度）', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'EMPTY_WORD');
      assert.strictEqual(r.value, '');
      assert.strictEqual(called, false, '空单词不该发起云函数调用');
    });
  })();

  // 4.11 AI 返回 ok 但内容为空、预置库也没有 → 必须报失败，不能假装成功
  mockWx('ok', { ok: true, data: { example: '' } });
  ai = loadAi();
  await (async function () {
    const r = await ai.genExample('zzzznotexist', 'n. 不存在');
    check('网关：AI 空内容 + 预置库无此词 → ok:false 且给出可读提示（不误报成功）', () => {
      assert.strictEqual(r.ok, false, '既没 AI 内容也没预置内容，必须报失败');
      assert.strictEqual(r.value, '');
      assert.strictEqual(r.fromPreset, false);
      assert.ok(r.msg && r.msg.length > 0, '应给出提示文案');
      assert.ok(!/异常|失败/.test(r.msg), '文案不该出现裸报错词，实际 ' + r.msg);
    });
  })();

  // 4.12 降级兜底依赖预置库完整：每个预置词都得有例句与记忆法
  check('网关：PRESET_MAP 覆盖预置库全部词，且每词都有例句与记忆法', () => {
    const keys = Object.keys(ai.PRESET_MAP).length;
    assert.strictEqual(keys, PRESET.length,
      '索引条数应与预置库一致（预置 ' + PRESET.length + ' 条），实际 ' + keys);
    const missing = PRESET.filter(function (w) {
      const v = ai.PRESET_MAP[String(w.word).toLowerCase()];
      return !v || !v.example || !v.mnemonic;
    }).map(function (w) { return w.word; });
    assert.deepStrictEqual(missing, [],
      '这些预置词的例句/记忆法缺失，AI 失败时兜底会空手：' + missing.join(', '));
  });

  // 4.13 wx.cloud 抛同步异常 → CALL_THREW（第 4 个降级码，此前只断言了 ok:false，没断言身份）
  mockWx('throw');
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('abandon 遗弃', []);
    check('网关：wx.cloud 抛同步异常 → code 必须是 CALL_THREW（钉死第 4 个降级码）', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'CALL_THREW', '期望 CALL_THREW，实际 ' + r.code);
    });
  })();

  // 4.14 云函数返回体残缺（success 无 result / result.ok 但无 data）→ UNKNOWN 兜底，不崩
  mockWx('ok', {});
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('abandon 遗弃', []);
    check('网关：云函数返回体残缺（无 result）→ code=UNKNOWN 且不抛错', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'UNKNOWN', '期望 UNKNOWN，实际 ' + r.code);
    });
  })();

  mockWx('ok', { ok: true });
  ai = loadAi();
  await (async function () {
    const r = await ai.parseBatch('abandon 遗弃', []);
    check('网关：result.ok 为真但缺 data → 同样折算成 UNKNOWN', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'UNKNOWN', '期望 UNKNOWN，实际 ' + r.code);
    });
  })();

  // 4.15 单条生成（genExample 路径）的空单词守卫
  mockWx('ok', { ok: true, data: { example: 'x' } });
  ai = loadAi();
  await (async function () {
    let called = false;
    global.wx.cloud.callFunction = function () { called = true; };
    const r = await ai.genExample('   ', '');
    check('网关：genExample 空单词 → EMPTY_WORD 且不发请求', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'EMPTY_WORD');
      assert.strictEqual(called, false, '空单词不该发起云函数调用');
    });
  })();

  // 4.16 预置库索引的键必须全小写（降级查找靠 toLowerCase 命中），且大写输入能命中
  check('网关：PRESET_MAP 的键全为小写（否则大写输入查不到降级内容）', () => {
    const badKeys = Object.keys(ai.PRESET_MAP).filter(k => k !== k.toLowerCase());
    assert.deepStrictEqual(badKeys, [], '存在非小写键：' + badKeys.join(', '));
  });

  mockWx('fail');
  ai = loadAi();
  await (async function () {
    const r = await ai.genMnemonic('ABILITY');
    check('网关：大写单词也能命中预置库降级（查找前统一小写）', () => {
      assert.strictEqual(r.ok, true, '预置库有 ability，应降级成功');
      assert.strictEqual(r.fromPreset, true);
      assert.strictEqual(r.value, ai.PRESET_MAP['ability'].mnemonic);
    });
  })();

  // 恢复环境
  global.wx = savedWx;
  if (savedWx === undefined) delete global.wx;

  // ---- 云函数 main 的失败安全：临时清掉 Key ----
  // 2026-09-28 修：只删 GLM 不够——provider 探测先查 AGNES_API_KEY（本机环境里它
  // 常驻，删 GLM 后 agnes 分支接管返回真实数据，「无 Key」用例假红真绿各一半）。
  // 「无 Key」必须是三个变量全空。
  delete process.env.GLM_API_KEY;
  delete process.env.AGNES_API_KEY;
  delete process.env.AI_PROVIDER;

  let r;
  try {
    r = await fn.main({ action: 'parseBatch', payload: { text: 'abandon 遗弃' } });
  } catch (e) {
    r = { ok: true, code: 'THREW', msg: e.message };
  }
  check('云函数 main：未配置 Key 时返回 ok:false 且不抛异常', () => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_KEY');
  });

  check('云函数 main：未知 action 折算成 ok:false', () => {
    return fn.main({ action: 'hack', payload: {} }).then(x => {
      assert.strictEqual(x.ok, false);
      assert.ok(x.code === 'NO_KEY' || x.code === 'BAD_ACTION', '实际 ' + x.code);
    });
  });

  check('云函数 main：绝不把上游原始报错透传给前端', () => {
    assert.ok(!/apiKey|Bearer|Authorization|stack/i.test(JSON.stringify(r)));
  });

  // ---- 云函数 main 的分发优先级与上游失败折算 ----
  const savedEndpoint = process.env.GLM_ENDPOINT;

  process.env.GLM_API_KEY = 'test-key-not-real';

  let badAction;
  try { badAction = await fn.main({ action: 'hack', payload: {} }); }
  catch (e) { badAction = { ok: true, code: 'THREW', msg: e.message }; }
  check('云函数 main：有 Key + 未知 action → BAD_ACTION（不进入网络请求）', () => {
    assert.strictEqual(badAction.ok, false, '应返回 ok:false，实际 ' + JSON.stringify(badAction));
    assert.strictEqual(badAction.code, 'BAD_ACTION', '期望 BAD_ACTION，实际 ' + badAction.code);
  });

  let nullEvent, emptyEvent;
  try { nullEvent = await fn.main(null); } catch (e) { nullEvent = { code: 'THREW' }; }
  try { emptyEvent = await fn.main({}); } catch (e) { emptyEvent = { code: 'THREW' }; }
  check('云函数 main：null / 空对象 event → BAD_ACTION 且不抛错', () => {
    assert.strictEqual(nullEvent.ok, false, 'main(null) 应返回 ok:false，实际 ' + JSON.stringify(nullEvent));
    assert.strictEqual(nullEvent.code, 'BAD_ACTION', 'main(null) 期望 BAD_ACTION，实际 ' + nullEvent.code);
    assert.strictEqual(emptyEvent.ok, false, 'main({}) 应返回 ok:false，实际 ' + JSON.stringify(emptyEvent));
    assert.strictEqual(emptyEvent.code, 'BAD_ACTION', 'main({}) 期望 BAD_ACTION，实际 ' + emptyEvent.code);
  });

  // 上游不可达：把 endpoint 指向本机未监听端口，连接被拒 → NETWORK（不外发、不联网）
  // 2026-09-28 修：同时删 AGNES/AI_PROVIDER——AGNES key 在场时 provider=agnes 走真端点，
  // 坏 endpoint 根本不生效（本机 AGNES 常驻导致的假红）。
  delete process.env.AGNES_API_KEY;
  delete process.env.AI_PROVIDER;
  process.env.GLM_ENDPOINT = 'https://127.0.0.1:1/chat/completions';
  let netFail;
  try { netFail = await fn.main({ action: 'parseBatch', payload: { text: 'abandon 遗弃' } }); }
  catch (e) { netFail = { ok: true, code: 'THREW', msg: e.message }; }
  check('云函数 main：上游不可达 → 折算成 NETWORK，且不泄露密钥与内部细节', () => {
    assert.strictEqual(netFail.ok, false, '应返回 ok:false，实际 ' + JSON.stringify(netFail));
    assert.strictEqual(netFail.code, 'NETWORK', '期望 NETWORK，实际 ' + netFail.code);
    const dumped = JSON.stringify(netFail);
    assert.ok(!/test-key-not-real/.test(dumped), '响应里泄露了 Key：' + dumped);
    assert.ok(!/Bearer|Authorization|stack/i.test(dumped), '响应里泄露了内部细节：' + dumped);
  });

  // 无 Key + 未知 action → NO_KEY：证明 Key 校验优先于 action 分发
  delete process.env.GLM_API_KEY;
  delete process.env.AGNES_API_KEY;   // 同上：agnes 在场就不是「无 Key」（2026-09-28 补）
  delete process.env.AI_PROVIDER;
  let noKeyBadAction;
  try { noKeyBadAction = await fn.main({ action: 'hack', payload: {} }); }
  catch (e) { noKeyBadAction = { code: 'THREW' }; }
  check('云函数 main：无 Key + 未知 action → NO_KEY（Key 校验优先，优先级被钉死）', () => {
    assert.strictEqual(noKeyBadAction.ok, false, '应返回 ok:false，实际 ' + JSON.stringify(noKeyBadAction));
    assert.strictEqual(noKeyBadAction.code, 'NO_KEY', '期望 NO_KEY，实际 ' + noKeyBadAction.code);
  });

  if (savedEndpoint === undefined) delete process.env.GLM_ENDPOINT;
  else process.env.GLM_ENDPOINT = savedEndpoint;

  if (saved) process.env.GLM_API_KEY = saved;

  console.log('\n>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
})();
