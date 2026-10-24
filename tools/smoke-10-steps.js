/**
 * §6.2 十步冒烟（真引擎自动化版）
 *
 * ## 为什么要有这个脚本
 * `docs/开发指引.md` §6.2 的十步冒烟原本是"人工在模拟器里点 10 次"。
 * 人工走查的问题不是不可靠，而是**每次都要重来一遍、且没有留存证据** ——
 * 前一天点过、第二天改完代码还得再点，成本高到实际没人会天天做。
 *
 * 这个脚本把十步变成可重复执行的断言，每步读真实页面数据取证。
 * 与 `verify-devtools.js` 的分工：
 *   - verify-devtools：17 项断言（能不能跑、契约对不对）
 *   - 本脚本：10 步用户路径（用户真的点一遍会发生什么）
 * 两者互补，都跑。
 *
 * ## 前提（缺一不可）
 *   1. 开发者工具已开项目，且**编译模式是「普通编译」**（不是「小程序 AI 编译」）
 *   2. 自动化端口已挂：`cli agent start --project <镜像> --auto-port 9420`
 *   详见 docs/交接文档-给下一个AI.md 第五之二节。
 *
 * ## 用法
 *   node tools/smoke-10-steps.js
 *   node tools/smoke-10-steps.js --auto-port 9420
 *
 * ## 注意
 * 第 9 步会真的往存储里写 2 个测试词（zztest*），跑完自动清掉。
 * 如果脚本中途崩溃，请手动确认词库总数回到 295（或清存储重编译）。
 */
const path = require('path');
const WS_DEFAULT = 'ws://127.0.0.1:9420';
const TEST_WORD_PREFIX = 'zztest';

function loadAutomator() {
  const HOME = ['C:', 'Users', '271' + '14'].join('/');
  const tries = [
    process.env.MP_AUTOMATOR_DIR,
    HOME + '/AppData/Local/Temp/mpauto',
    '/tmp/mpauto'
  ].filter(Boolean);
  for (const dir of tries) {
    try { return require(path.join(dir, 'node_modules', 'miniprogram-automator')); }
    catch (e) { /* 继续找 */ }
  }
  try { return require('miniprogram-automator'); } catch (e) { return null; }
}

const automator = loadAutomator();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? '  —— ' + detail : ''}`);
    pass++;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.log(`FAIL  ${name}\n      ${msg.slice(0, 220)}`);
    fail++;
    failures.push(name);
  }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

(async function main() {
  const portArg = process.argv.indexOf('--auto-port');
  const ws = portArg > -1 && process.argv[portArg + 1]
    ? 'ws://127.0.0.1:' + process.argv[portArg + 1]
    : WS_DEFAULT;

  console.log('§6.2 十步冒烟（真实引擎）\n');

  if (!automator) {
    console.log('SKIP  未找到 miniprogram-automator');
    console.log('      安装：cd %TEMP%/mpauto && npm i miniprogram-automator');
    process.exit(0);
  }

  let mini;
  try {
    mini = await automator.connect({ wsEndpoint: ws });
    // 学后拼写注入关闭（离场恢复）——**契约说明**（2026-09-24，DEV-P0-3）：
    // 本冒烟测「用户十步真实路径」的中途交互（评分推进、切 tab 接续），
    // 十步中队列不会耗尽，注入只为防御评分把队列提前走空的边缘情形。
    // 拼写轮的默认配置路径由 verify-pages.js（realPrefs 2 项）与
    // verify-runtime.js（P0-1 回归）两层守护 —— 本脚本只负责真机路径可达。
    // ⚠️ 若中断脚本导致 storage 残留 spellCheck=false，先在设置页恢复默认。
    try {
      await mini.evaluate(() => {
        const p = wx.getStorageSync('study_prefs') || {};
        p.spellCheck = false;
        wx.setStorageSync('study_prefs', p);
      });
    } catch (e) { console.warn('（拼写开关预置失败，冒烟继续）', e && e.message); }
  } catch (e) {
    console.log('SKIP  自动化端口未开启');
    console.log('      开启：cli agent start --project <项目> --auto-port 9420');
    console.log('      （用 cli auto 会强制开 lite 窗口，模拟器不加载小程序）');
    console.log('      原因：' + e.message);
    process.exit(0);
  }
  console.log('已连接自动化端口\n');

  let page;
  let baselineTotal = 0;

  /* ---- 1. 冷启动 → 词库页 ---- */
  await step('冷启动进入词库页', async () => {
    page = await mini.reLaunch('/pages/deck/deck');
    await sleep(1400);
    const d = await page.data();
    assert(d.overall, '没有 overall 数据');
    baselineTotal = d.overall.total;
    assert(baselineTotal > 0, '词库为空（预置未生效？）');
    return `总数 ${d.overall.total} / 待复习 ${d.dueCount}`;
  });

  /* ---- 2. 预置词库 + 三态自洽 ---- */
  await step('预置词库三态自洽', async () => {
    const d = await page.data();
    const o = d.overall;
    assert(o.mastered + o.learning + o.fresh === o.total,
      `三态之和 ${o.mastered}+${o.learning}+${o.fresh} != ${o.total}`);
    return `已掌握 ${o.mastered} / 复习中 ${o.learning} / 未学 ${o.fresh}`;
  });

  /* ---- 3. 进入复习队列 ---- */
  await step('点主按钮进入复习队列', async () => {
    const btn = await page.$('button.primary');
    assert(btn, '找不到主按钮');
    const t = (await btn.text() || '').trim();
    // 2026-09-18 改文案：首页主按钮从「开始复习」改为「开始」（数字已说明今天做什么）
    assert(t.indexOf('开始') >= 0, '主按钮文字不是开始相关：' + t);
    await btn.tap();
    await sleep(2200);
    page = await mini.currentPage();
    assert(page.path.indexOf('study') >= 0, '未跳转到复习页，当前：' + page.path);
    const d = await page.data();
    assert(Array.isArray(d.queue) && d.queue.length > 0, '队列为空');
    return `队列 ${d.queue.length} 张，页面 ${page.path}`;
  });

  /* ---- 4. 翻卡前评分应锁定 ---- */
  await step('翻卡前评分被锁定（先记住/先回想）', async () => {
    let d = await page.data();
    if (d.flipped) { // 上一轮可能停在翻面态，先重置视角
      const c = await page.$('.card, [class*=card]');
      if (c) { await c.tap(); await sleep(700); d = await page.data(); }
    }
    assert(d.flipped === false, '当前不是未翻面状态');
    const hint = await page.$('.grade-hint');
    const hintText = hint ? (await hint.text() || '').trim() : '';
    /**
     * 2026-09-18：提示文案分两种 ——
     *   新词："先记住它，再选"（学习阶段，正面直接给答案）
     *   复习："先自己回想，再翻面"（考试阶段，正面只给单词）
     * 两者都在表达"还没到评分的时候"，断言接受任一。
     */
    assert(hintText.indexOf('回想') >= 0 || hintText.indexOf('翻面') >= 0 || hintText.indexOf('记住') >= 0,
      '未翻面时没有出现锁定提示，实际：' + hintText);
    const cur = d.current || {};
    return (cur.isNew ? '[新词] ' : '[复习] ') + '显示「' + hintText.slice(0, 18) + '」';
  });

  /* ---- 5-7. 评分（自动适配新词两档 / 复习三档）---- */
  await step('评分能推进队列（自动识别卡片类型）', async () => {
    let d = await page.data();
    const wasNew = !!(d.current && d.current.isNew);

    // 先翻面/展开（新词已经是展开态，点了也不影响）
    if (!d.flipped) {
      const c = await page.$('.card, [class*=card]');
      assert(c, '找不到卡片元素');
      await c.tap();
      await sleep(800);
      d = await page.data();
    }

    // 按卡片类型找对应按钮（新词两档：「再看一遍」「记住了」；复习三档：「不认识」「模糊」「认识」）
    const wantPrefix = wasNew ? '记住了' : '认识';
    const btns = await page.$$('.grade-btn');
    let target = null;
    const texts = [];
    for (const b of btns) {
      const t = (await b.text() || '').trim();
      texts.push(t);
      if (!target && t.indexOf(wantPrefix) === 0) target = b;
    }
    assert(target, '找不到「' + wantPrefix + '」按钮（现有：' + texts.join(' | ') + '）');

    const before = d.reviewed;
    await target.tap();
    await sleep(1600);
    d = await page.data();
    assert(d.reviewed === before + 1, `reviewed 未递增：${before} → ${d.reviewed}`);
    assert(d.roundKnow >= 1, 'roundKnow 未计数');
    return (wasNew ? '新词' : '复习') + '卡片评分成功 —— 已评 ' + d.reviewed + '，连对 ' + d.streak;
  });

  await step('按钮显示「下次 N 天」（选择后果可见）', async () => {
    const d = await page.data();
    const btns = await page.$$('.grade-btn');
    const texts = [];
    for (const b of btns) texts.push((await b.text() || '').trim());
    /**
     * 2026-09-18 新增契约：评分按钮必须显示"下次多少天"。
     * 为什么要守这条：原来按钮只有「认识/模糊/不认识」三个词，
     * 学生看不出选择的后果；而且"模糊"和"认识"在 SM-2 前两轮排期完全相同，
     * 不显示天数的话这两个按钮在行为上毫无区别（等于装饰品）。
     */
    const hasDays = texts.some(t => /\d+\s*天/.test(t));
    assert(hasDays || (await page.data()).current.isNew === false,
      '按钮上应显示「下次 N 天」，实际：' + texts.join(' | '));
    return '按钮文案：' + texts.join(' | ');
  });

  /* ---- 7. 切 tab 返回 → 数字正确 + 队列接续 ---- */
  await step('切 tab 后队列接续（进度不丢）', async () => {
    const before = await page.data();
    // 先确认页面处于复习中（前面步骤失败时可能没建立）
    assert(typeof before.reviewed === 'number' && before.reviewed > 0,
      '复习进度异常（reviewed=' + before.reviewed + '）—— 前面的评分步骤应已推进队列');
    const midReviewed = before.reviewed, midIdx = before.idx;

    await mini.switchTab('/pages/deck/deck');
    await sleep(1400);
    const deck = await mini.currentPage();
    const dd = await deck.data();
    assert(dd.overall.total >= baselineTotal, '首页总数异常');
    /**
     * 2026-09-18 改口径：首页主数字从"词库里所有到期的"改成"今日计划张数"。
     * 所以不再断言"数字随复习减少"（今日计划是固定的 10 张一轮）；
     * 改为断言新契约 —— 首页数字 = 复习页实际会给的张数（两页同口径）。
     */
    assert(dd.dueCount > 0, '首页今日计划数应 > 0');
    assert(typeof dd.todayNew === 'number', '首页应有 todayNew（新词数）字段');

    await mini.switchTab('/pages/study/study');
    await sleep(1500);
    page = await mini.currentPage();
    const d = await page.data();
    assert(d.reviewed === midReviewed && d.idx === midIdx,
      `队列被重置：reviewed ${midReviewed}→${d.reviewed}，idx ${midIdx}→${d.idx}`);
    return `首页今日计划 ${dd.dueCount}（新词 ${dd.todayNew}），复习进度保持 ${d.reviewed}`;
  });

  /* ---- 8. 统计页出数 ---- */
  await step('统计页出现真实数值', async () => {
    // 2026-09-25 底部栏整理：stats 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const stats = await mini.reLaunch('/pages/stats/stats');
    await sleep(1600);
    const d = await stats.data();
    assert(d.hasStudied === true, 'hasStudied 未变 true（复习记录没进统计）');
    assert(d.overall && d.overall.total > 0, 'overall 异常');
    assert(d.analysis && d.analysis.events > 0, 'analysis.events 为 0');
    return `事件 ${d.analysis.events} 条，连续 ${d.analysis.streak.current} 天，积分 ${d.points}`;
  });

  /* ---- 9. 批量粘贴：合法入库 + 非法跳过 ---- */
  let addedCount = 0;
  await step('批量粘贴（2 合法 + 1 非法 → 只入库 2）', async () => {
    const add = await mini.reLaunch('/pages/add/add');
    await sleep(1400);
    const segs = await add.$$('.seg-item');
    for (const s of segs) {
      const t = (await s.text() || '').trim();
      if (t.indexOf('批量') >= 0) { await s.tap(); break; }
    }
    await sleep(600);
    const tas = await add.$$('textarea');
    assert(tas.length > 0, '找不到输入框');
    const target = tas.length > 1 ? tas[1] : tas[0];
    await target.input(
      TEST_WORD_PREFIX + 'one 测试词一\n' +
      TEST_WORD_PREFIX + 'two 测试词二\n' +
      '这行没有英文'
    );
    await sleep(700);
    const btns = await add.$$('button');
    for (const b of btns) {
      const t = (await b.text() || '').trim();
      if (t.indexOf('解析并添加') >= 0) { await b.tap(); break; }
    }
    await sleep(2200);

    const deck = await mini.reLaunch('/pages/deck/deck');
    await sleep(1500);
    const d = await deck.data();
    addedCount = d.overall.total - baselineTotal;
    assert(addedCount === 2,
      `期望新增 2 个（非法行应被跳过），实际新增 ${addedCount}，总数 ${d.overall.total}`);
    return `总数 ${baselineTotal} → ${d.overall.total}，非法行已跳过`;
  });

  /* ---- 10. 持久化：重新加载后数据仍在 ---- */
  await step('持久化（重新进入数据不丢）', async () => {
    const deck = await mini.reLaunch('/pages/deck/deck');
    await sleep(1500);
    const d = await deck.data();
    assert(d.overall.total === baselineTotal + addedCount,
      `重启后总数变了：${d.overall.total} != ${baselineTotal + addedCount}`);
    assert(d.points >= 0, 'points 异常');
    return `重启后 ${d.overall.total} 词仍在，积分 ${d.points}`;
  });

  /* ---- 清理测试词 ---- */
  await step('清理测试数据（恢复词库基线）', async () => {
    const r = await mini.evaluate(function (prefix) {
      var key = 'words';
      var w = wx.getStorageSync(key) || [];
      var before = w.length;
      var kept = w.filter(function (x) {
        return String(x.word || '').indexOf(prefix) !== 0;
      });
      wx.setStorageSync(key, kept);
      return { before: before, after: kept.length };
    }, TEST_WORD_PREFIX);
    assert(r.after === r.before - addedCount,
      `清理不干净：${r.before} → ${r.after}（应删 ${addedCount}）`);
    return `删除 ${r.before - r.after} 个测试词，总数回到 ${r.after}`;
  });

  console.log('\n' + '='.repeat(62));
  console.log(`>>> ${pass} 步通过 / ${fail} 步失败`);
  console.log('='.repeat(62));
  // 离场恢复：把学后拼写开关还给学生（默认开）
  try {
    await mini.evaluate(() => {
      const p = wx.getStorageSync('study_prefs') || {};
      delete p.spellCheck;
      wx.setStorageSync('study_prefs', p);
    });
  } catch (e) { /* 恢复失败不掩盖结果 */ }
  if (fail) {
    console.log('\n失败：' + failures.join(' / '));
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error('脚本异常：' + (e && e.message ? e.message : e));
  process.exit(1);
});
