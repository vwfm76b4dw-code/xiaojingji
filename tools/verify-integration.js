/**
 * 端到端集成验证 —— 用内存存储模拟小程序环境，跑通"AI 解析 → 落库 → 进入复习队列"闭环。
 *
 * 为什么需要这一层：单元测试各自都绿，但"接起来能不能用"是另一回事。
 * 本测试回答的是验收问题：AI 录入的词，真的会出现在今日复习队列里吗？数据会丢吗？
 *
 * 运行：node tools/verify-integration.js
 */
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

/*------------ 搭一个"够真的"微信环境（内存 KV + 可控云函数） ------------*/

const store = {};                       // 模拟 wx.Storage
let cloudReply = null;                  // 模拟云函数返回
let cloudCalls = 0;

global.wx = {
  getStorageSync: k => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete store[k]; },
  cloud: {
    callFunction(opts) { cloudCalls++; opts.success({ result: cloudReply }); }
  }
};

// 数据库里预置一个词，用于验证"AI 录入不覆盖已有词"
store['words'] = [];

function freshRequire(p) {
  const full = require.resolve(p);
  delete require.cache[full];
  return require(full);
}

// 清掉相关模块缓存（它们各自持有 PRESET_MAP 或读 wx）
['../miniprogram/utils/ai.js', '../miniprogram/utils/store.js',
 '../miniprogram/utils/ai-core.js', '../miniprogram/utils/schedule.js',
 '../miniprogram/utils/date.js'].forEach(p => {
  try { delete require.cache[require.resolve(p)]; } catch (e) { /* 未加载过 */ }
});

const ai = freshRequire('../miniprogram/utils/ai.js');
const storeApi = freshRequire('../miniprogram/utils/store.js');
const schedule = freshRequire('../miniprogram/utils/schedule.js');
const { todayStr } = freshRequire('../miniprogram/utils/date.js');

const TODAY = todayStr();

/*-------------------------------- 用例 ---------------------------------*/

(async function () {
  // 1. AI 解析 → 落库 → 队列闭环
  cloudReply = {
    ok: true,
    data: { items: [
      { word: 'abandon', meaning: 'v. 遗弃，放弃' },
      { word: 'abundant', meaning: 'adj. 丰富的' },
      { word: 'accelerate', meaning: 'v. 加速' }
    ] }
  };
  const parsed = await ai.parseBatch('今天背了 abandon 遗弃，abundant 丰富的，accelerate 加速', storeApi.loadWords());

  check('闭环①：AI 解析成功返回 3 个新词', () => {
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.items.length, 3);
    assert.strictEqual(parsed.dupCount, 0);
  });

  const added = storeApi.addItems(parsed.items);
  check('闭环②：落库成功，3 个词写入本地存储', () => {
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.added, 3);
    assert.strictEqual(storeApi.loadWords().length, 3);
  });

  check('闭环③：录入当日即进入今日复习队列（nextReview = 今天）', () => {
    const queue = schedule.dueWords(storeApi.loadWords(), TODAY);
    assert.strictEqual(queue.length, 3, 'AI 录入的词应立即可复习');
    assert.deepStrictEqual(queue.map(w => w.word).sort(), ['abandon', 'abundant', 'accelerate']);
  });

  check('闭环④：新词字段完整（算法初始态 ef 2.5 / reps 0 / interval 0 / history 空）', () => {
    storeApi.loadWords().forEach(w => {
      assert.strictEqual(w.ef, 2.5, w.word + ' ef 初始值错');
      assert.strictEqual(w.reps, 0);
      assert.strictEqual(w.interval, 0);
      assert.deepStrictEqual(w.history, []);
      assert.strictEqual(w.nextReview, TODAY);
      assert.strictEqual(w.createdAt, TODAY);
      assert.ok(w.id && w.id.length > 0, w.word + ' 缺 id');
    });
  });

  // 2. 复习一个词 → 间隔与积分变化（AI 录入的词能被算法正常调度）
  const { sm2 } = freshRequire('../miniprogram/utils/sm2.js');
  check('闭环⑤：AI 录入的词可正常走 SM-2（认识 → 明天复习）', () => {
    const list = storeApi.loadWords();
    const w = list.find(x => x.word === 'abandon');
    const up = sm2(w, 5, TODAY);
    up.history = w.history.concat([{ date: TODAY, q: 5, interval: up.interval }]);
    assert.strictEqual(storeApi.updateWord(up), true);

    const after = storeApi.loadWords().find(x => x.word === 'abandon');
    assert.strictEqual(after.interval, 1);
    assert.strictEqual(after.reps, 1);
    assert.strictEqual(after.nextReview, (function () {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const p = n => (n < 10 ? '0' + n : n);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })());

    // 复习后它应离开今日队列
    const queue = schedule.dueWords(storeApi.loadWords(), TODAY);
    assert.strictEqual(queue.length, 2, '复习过的词应离开今日队列');
    assert.strictEqual(schedule.pointsOf(storeApi.loadWords()), 3, '认识应得 3 分');
  });

  // 3. 重复词不重复入库（AI 重复解析同一批）
  cloudReply = {
    ok: true,
    data: { items: [{ word: 'ABANDON', meaning: 'v. 遗弃' }] }
  };
  const again = await ai.parseBatch('abandon 遗弃', storeApi.loadWords());
  check('闭环⑥：已存在的词被识别为重复，不写入（忽略大小写）', () => {
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.items.length, 0, '重复词不该进 items');
    assert.strictEqual(again.dupCount, 1);
  });

  // 4. 持久化：模拟进程重启后重新加载
  check('闭环⑦：数据持久化，重新加载不丢（模拟杀进程重开）', () => {
    const before = JSON.stringify(storeApi.loadWords());
    const reloaded = freshRequire('../miniprogram/utils/store.js');
    assert.strictEqual(JSON.stringify(reloaded.loadWords()), before);
    assert.strictEqual(reloaded.loadWords().length, 3);
  });

  // 5. AI 失败时核心功能不受影响
  cloudReply = { ok: false, code: 'TIMEOUT' };
  const failed = await ai.parseBatch('some words here', storeApi.loadWords());
  check('闭环⑧：AI 失败时返回友好提示，且已有词库不受影响', () => {
    assert.strictEqual(failed.ok, false);
    assert.ok(failed.msg && failed.msg.length > 0);
    assert.ok(!/TIMEOUT/.test(failed.msg), '文案不该出现错误码');
    assert.strictEqual(storeApi.loadWords().length, 3, 'AI 失败不该动到已有数据');
    // 离线仍可正常复习
    assert.strictEqual(schedule.dueWords(storeApi.loadWords(), TODAY).length, 2);
  });

  // 6. 非 AI 路径（批量粘贴）仍然可用 —— 阶段 1 零依赖的保证
  check('闭环⑨：不走 AI 的批量粘贴同样能录入（阶段 1 零依赖保证）', () => {
    const r = storeApi.addBatch('borrow 借入\nbrave 勇敢的\n这一行格式非法');
    assert.strictEqual(r.added, 2);
    assert.strictEqual(r.skipped.length, 1);
    assert.strictEqual(storeApi.loadWords().length, 5);
    assert.strictEqual(schedule.dueWords(storeApi.loadWords(), TODAY).length, 4);
  });

  // 7. 统计指标在 AI 录入场景下口径正确
  check('闭环⑩：三项自测指标在有数据后正常出数（hasData=true）', () => {
    const sc = schedule.selfCheck(storeApi.loadWords());
    assert.strictEqual(sc.hasData, true);
    assert.ok(sc.avgEF > 0 && sc.avgEF < 5, '平均 EF 应在合理区间，实际 ' + sc.avgEF);
    assert.ok(sc.firstTryRate >= 0 && sc.firstTryRate <= 100);
    assert.ok(sc.retainedRatio >= 0 && sc.retainedRatio <= 100);
  });

  console.log('\n>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
})();
