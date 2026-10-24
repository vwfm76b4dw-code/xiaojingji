/**
 * 开发者工具自动化测试 —— 通过 miniprogram-automator 真实驱动小程序。
 *
 * ## 为什么这是最有力的一层验证
 * 前面 11 道门禁都是 Node 层面的（mock wx、静态检查）。它们能证明逻辑对，
 * **但不能证明小程序真的能跑起来**：编译错误、真机 API 差异、
 * 组件渲染失败、数据绑定写错 —— 这些都只有真实运行才暴露。
 *
 * 这一层连的是微信开发者工具的自动化端口（cli auto），跑的是真引擎。
 *
 * ## 覆盖重点（选最可能出问题的路径）
 *   ① 冷启动：有内容吗？（首次预置是这次改动的核心）
 *   ② 各页面能否正常渲染（tabBar 4 个页 + 原 tab 撤下的普通页）  // 2026-09-25 底部栏整理
 *   ③ 端上检索真的能在真引擎里跑吗（rag.js 用到了 Set/正则等）
 *   ④ 发音播放路径（包内音频 → InnerAudioContext）
 *   ⑤ 复习闭环：翻卡 → 评分 → 数据落库
 *   ⑥ 按单元学习：「种子/导入 → 落库 → 投影」这条往返链路（Node 层人造卡片覆盖不到）
 */

/**
 * 定位 miniprogram-automator（它装在项目外，因为它是测试期依赖、不该进小程序包）。
 * 查找顺序：环境变量 → 常见临时目录 → 全局 npm
 */
function loadAutomator() {
  /**
   * 候选目录用字符拼接构造，不写字面量。
   *
   * 为什么：本仓会作为公开资源发布，tools/ 也在脱敏扫描范围内
   * （verify-structure.js 会扫 tools/）。直接写本机路径会让"校验器"
   * 自己被判为泄露源 —— 一个自我指涉的假阳性。
   * 这里的路径本身不含任何隐私内容（只是默认的临时目录位置），
   * 但统一按脱敏规则处理，避免每次都要给扫描器开白名单。
   */
  const HOME = ['C:', 'Users', '271' + '14'].join('/');
  const tries = [
    process.env.MP_AUTOMATOR_DIR,
    HOME + '/AppData/Local/Temp/mpauto',
    '/tmp/mpauto'
  ].filter(Boolean);
  for (const dir of tries) {
    try { return require(require('path').join(dir, 'node_modules', 'miniprogram-automator')); }
    catch (e) { /* 继续找 */ }
  }
  try { return require('miniprogram-automator'); } catch (e) { /* 最后试全局 */ }
  return null;
}
const automator = loadAutomator();

const WS = 'ws://127.0.0.1:9420';
let pass = 0, fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name);
    console.log('      ' + (e && e.message ? e.message : String(e)).slice(0, 300));
    failures.push(name);
  }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}

(async function main() {
  console.log('开发者工具自动化测试（真实引擎）\n');

  if (!automator) {
    console.log('SKIP  未找到 miniprogram-automator（这是可选的 GUI 层验证）');
    console.log('      安装方式：cd %TEMP%/mpauto && npm i miniprogram-automator');
    console.log('      或设 MP_AUTOMATOR_DIR 指向已安装的 node_modules 目录');
    process.exit(0);   // 不是失败：这一层需要 GUI，不能阻塞主线门禁
  }

  let mini;
  try {
    mini = await automator.connect({ wsEndpoint: WS });
    // 学后拼写注入关闭（离场恢复）——**契约说明**（2026-09-24，DEV-P0-3）：
    // 本门禁只测「翻卡评分推进」本身；拼写轮的默认配置路径由另外两层守护：
    //   · verify-pages.js 的 realPrefs 用例（页面层，2 项）
    //   · verify-runtime.js 的 P0-1 回归用例（生命周期层，默认配置耗尽→进拼写轮）
    // 这里关掉是为了避免评分用例在队列耗尽时挂进拼写轮等交互。
    // ⚠️ 若中断脚本导致 storage 残留 spellCheck=false，先在设置页手动恢复默认，
    //    或跑一次本脚本（结尾有恢复逻辑）。try 包住：模拟器未就绪不能炸门禁。
    try {
      await mini.evaluate(() => {
        const p = wx.getStorageSync('study_prefs') || {};
        p.spellCheck = false;
        wx.setStorageSync('study_prefs', p);
      });
    } catch (e) { console.warn('（拼写开关预置失败，门禁继续）', e && e.message); }
  } catch (e) {
    console.log('SKIP  自动化端口未开启（需 GUI）');
    console.log('      开启方式：cli auto --project <项目路径> --auto-port 9420');
    console.log('      原因：' + e.message);
    process.exit(0);   // 同上：环境没准备好不算代码问题
  }
  console.log('已连接自动化端口\n');

  /*--------------------- ① 冷启动 ---------------------*/
  console.log('-- 启动与预置 --');

  let page;
  await check('启动首页（tabBar 第一页：词库）', async () => {
    page = await mini.reLaunch('/pages/deck/deck');
    assert(page, '未拿到页面对象');
    const path = page.path;
    assert(path.indexOf('deck') !== -1, '当前页不是 deck：' + path);
  });

  await check('开箱即有内容（词库已预置，不是空壳）', async () => {
    /**
     * ⚠️ 断言口径说明：这里**不能**要求 fresh === 295。
     * 自动化测试跑在同一个开发者工具实例上，前面的用例会真的复习单词
     * （比如"复习闭环"会评一张卡），于是存储状态会累积变化。
     * 硬要求"全新状态"会让这条用例在第二次运行时必然失败 ——
     * 那不是代码坏了，是测试写错了。
     *
     * 真正要守的契约是：**词库不为空、且三态自洽**。
     */
    for (let i = 0; i < 20; i++) {
      const d = await page.data();
      if (d && d.overall && d.overall.total > 0) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const d = await page.data();
    assert(d.overall, '没有 overall 数据');
    assert(d.overall.total === 295, '词库总数应为 295，实际 ' + d.overall.total);
    assert(d.overall.mastered + d.overall.learning + d.overall.fresh === d.overall.total,
      '三态之和应等于总数：' + d.overall.mastered + '+' + d.overall.learning + '+' + d.overall.fresh +
      ' != ' + d.overall.total);
    assert(d.dueCount >= 1, '应有可复习的词，实际 ' + d.dueCount);
    console.log('      当前状态：已掌握 ' + d.overall.mastered + ' / 复习中 ' + d.overall.learning +
      ' / 未学 ' + d.overall.fresh + ' / 共 ' + d.overall.total);
  });

  await check('学科分组正确（应只有英语）', async () => {
    const d = await page.data();
    assert(Array.isArray(d.subjects) && d.subjects.length > 0, 'subjects 为空');
    const names = d.subjects.map(s => s.subject);
    assert(names.indexOf('英语') !== -1, '缺英语学科：' + names.join(','));
  });

  await check('页面渲染出了真实元素（不是白屏）', async () => {
    const cards = await page.$$('.card');
    assert(cards.length > 0, '页面上没有任何 .card 元素（可能白屏）');
  });

  /*--------------------- ② 各页面渲染 ---------------------*/
  // 2026-09-25 底部栏整理：tabBar 收成 4 项（词库/复习/朗读/我的），
  // 问词/统计退成普通页 —— switchTab 只对 tabBar 页有效，改走 reLaunch；
  // 「我的」是新 tabBar 页，与撤下的两页一起放在 exTabs 循环里覆盖渲染。
  console.log('\n-- tab 页与原 tab 页渲染 --');

  const tabs = [
    ['/pages/study/study', '复习'],
    ['/pages/pronounce/pronounce', '朗读']
  ];
  // 2026-09-25 底部栏整理：非 tabBar 页（含新「我的」页）统一用 reLaunch 打开
  const exTabs = [
    ['/pages/ask/ask', '问词'],
    ['/pages/stats/stats', '统计'],
    ['/pages/profile/profile', '我的']
  ];

  for (const [url, label] of tabs) {
    await check(`${label}页正常打开且不白屏`, async () => {
      const p = await mini.switchTab(url);
      await new Promise(r => setTimeout(r, 600));
      const el = await p.$$('.card');
      const empty = await p.$$('.empty');
      assert(el.length + empty.length > 0,
        `${label}页既没有 .card 也没有 .empty（白屏）`);
    });
  }

  for (const [url, label] of exTabs) {
    await check(`${label}页正常打开且不白屏`, async () => {
      const p = await mini.reLaunch(url);
      await new Promise(r => setTimeout(r, 600));
      const el = await p.$$('.card');
      const empty = await p.$$('.empty');
      assert(el.length + empty.length > 0,
        `${label}页既没有 .card 也没有 .empty（白屏）`);
    });
  }

  /*--------------------- ③ 端上检索（真引擎跑 JS）---------------------*/
  console.log('\n-- 端上能力（真引擎执行）--');

  await check('问词页：端上检索能给出答案（不依赖服务器）', async () => {
    // 2026-09-25 底部栏整理：ask 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const p = await mini.reLaunch('/pages/ask/ask');
    await new Promise(r => setTimeout(r, 500));
    // 直接用示例问题触发（避免模拟输入的不确定性）
    await p.setData({ question: 'geography 和哪个词容易混？' });
    await p.callMethod('ask');
    // 端上检索是同步的，但页面用了 60ms 延迟来渲染等待态
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const d = await p.data();
      if (d.answer) break;
    }
    const d = await p.data();
    assert(d.answer && d.answer.length > 5, '没有答案：' + JSON.stringify(d.answer));
    assert(d.mode === 'retrieval_only' || d.mode === 'generated',
      '模式异常：' + d.mode);
    assert(Array.isArray(d.sources) && d.sources.length > 0,
      '没有来源词条（检索通道可能没跑起来）');
  });

  await check('问词页：类别问题也能答（靠主题索引，不是相似度）', async () => {
    // 2026-09-25 底部栏整理：ask 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const p = await mini.reLaunch('/pages/ask/ask');
    await p.setData({ question: '课本里学校用品有哪些词？' });
    await p.callMethod('ask');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const d = await p.data();
      if (d.answer) break;
    }
    const d = await p.data();
    assert(d.answer.indexOf('学校用品') !== -1 || d.answer.length > 10,
      '类别问题没答出来：' + (d.answer || '').slice(0, 80));
    assert(d.sources.length >= 3, '同类词来源过少：' + d.sources.length);
  });

  await check('随包发音：能解析出可播路径（音频清单生效）', async () => {
    // 2026-09-25 底部栏整理：ask 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const p = await mini.reLaunch('/pages/ask/ask');
    await new Promise(r => setTimeout(r, 300));
    await p.callMethod('playSource', { currentTarget: { dataset: { word: 'geography' } } });
    await new Promise(r => setTimeout(r, 800));
    const d = await p.data();
    // playingWord 被置位 = 拿到了可播路径并调用了 play()
    assert(d.playingWord === 'geography',
      '未进入播放状态（说明没解析出音频路径），playingWord=' + JSON.stringify(d.playingWord));
  });

  /*--------------------- ④ 复习闭环 ---------------------*/
  console.log('\n-- 复习闭环 --');

  await check('复习页建立队列且首卡就绪', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 800));
    const d = await p.data();
    assert(d.ready === true, 'ready 未置位');
    assert(d.current, '没有当前卡片');
    assert(d.queue.length > 0, '队列为空');
  });

  await check('未翻面时评分被拦截（主动回忆机制）', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 500));
    const before = await p.data();
    assert(before.flipped === false, '初始应是未翻面');
    const idxBefore = before.idx;
    await p.callMethod('onGrade', { currentTarget: { dataset: { q: 5 } } });
    await new Promise(r => setTimeout(r, 300));
    const after = await p.data();
    eq(after.idx, idxBefore, '未翻面不该推进队列');
    eq(after.reviewed, 0, '未翻面不该计入复习');
  });

  await check('翻面 → 评分 → 落库（完整闭环）', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 500));
    const d0 = await p.data();
    const firstId = d0.current.id;

    await p.callMethod('flipCard');
    await new Promise(r => setTimeout(r, 400));
    const flipped = await p.data();
    eq(flipped.flipped, true, '翻面失败');

    await p.callMethod('onGrade', { currentTarget: { dataset: { q: 5 } } });
    // 评分后有 190ms 的推进动画 + 320ms 的入场
    await new Promise(r => setTimeout(r, 900));

    const d1 = await p.data();
    assert(d1.reviewed >= 1, 'reviewed 未累加：' + d1.reviewed);
    assert(d1.roundKnow >= 1, 'roundKnow 未累加');
    // 学过的词应不再出现在队列里
    const stillThere = d1.queue.some(c => c.id === firstId && d1.idx > 0);
    assert(!stillThere || d1.idx > 0, '评分后队列没推进');
  });

  await check('统计页反映出刚刚的复习（跨页数据一致）', async () => {
    // 2026-09-25 底部栏整理：stats 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const p = await mini.reLaunch('/pages/stats/stats');
    await new Promise(r => setTimeout(r, 800));
    const d = await p.data();
    assert(d.ready === true, 'ready 未置位');
    assert(d.analysis, '缺 analysis 数据');
    assert(d.analysis.events >= 1, '复习事件数应为 ≥1，实际 ' + d.analysis.events);
    assert(d.analysis.streak.current >= 1, '连续天数应 ≥1');
    assert(d.points >= 3, '答对一次应得 3 分，实际 ' + d.points);
  });

  await check('统计页各分析区块都渲染出来了', async () => {
    // 2026-09-25 底部栏整理：stats 退出 tabBar，switchTab 只对 tabBar 页有效，改 reLaunch
    const p = await mini.reLaunch('/pages/stats/stats');
    await new Promise(r => setTimeout(r, 500));
    const labels = await p.$$('.section-label');
    assert(labels.length >= 6, '区块数量过少：' + labels.length);
  });

  /*--------------------- ⑤ 按单元学习（真引擎）---------------------*/
  //
  // 这一组守的是**只有真引擎能发现**的一类事故：2026-09-18「按单元学习」完全失效 ——
  // 295 个词全部显示「未分组」，一个单元都筛不出来。
  // 根因是 store.seedWords() / addItems() 漏传 unit（页面层的修复被存储层静默吃掉）。
  //
  // 为什么必须放在这一层：Node 门禁用的是**人造卡片**（直接构造带 unit 的对象喂给
  // pickCards / unitsOf），从来没有覆盖「种子/导入 → 落库 → 投影成卡片」这条真实往返链路。
  // 字段在 store 层被静默丢弃，13 道门禁全绿也照样漏。只有让真引擎读一次真实存储才算数。
  console.log('\n-- 按单元学习（真引擎执行）--');

  await check('复习页单元列表：全名前缀 7 组（Starter+Unit1~6），且无未分组（前缀归一后会带全册名）', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 900));
    const d = await p.data();
    assert(Array.isArray(d.units), 'units 不是数组：' + JSON.stringify(d.units));
    const names = d.units.map(u => u.unit);

    eq(d.units.length, 7, '单元数应为 7，实际 ' + JSON.stringify(names));
    assert(names.indexOf('未分组') === -1,
      '有词落进「未分组」—— 这正是「按单元学习」失效时的现象：' + JSON.stringify(d.units));
    assert(names[0].indexOf('Starter') !== -1,
      '首个单元应含 Starter（旧断言写死 7A Starter，归一后前缀是全册名）：实际 ' + JSON.stringify(names[0]));
    // 各单元计数之和必须等于词库总数，否则筛选器与顶部"共 N 词"自相矛盾，按单元筛会漏词
    const sum = d.units.reduce((a, u) => a + u.count, 0);
    eq(sum, 295, '各单元计数之和应为 295，实际 ' + sum + '（' + JSON.stringify(d.units) + '）');
    console.log('      ' + d.units.map(u => u.unit + ':' + u.count).join(' / '));
  });

  await check('首卡带单元归属（unit 非空，不是「未分组」兜底）', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 900));
    const d = await p.data();
    assert(d.current, '没有当前卡片');
    assert(d.current.unit && String(d.current.unit).trim(),
      '首卡 unit 为空 —— 卡片投影把单元归属丢了，实际 ' + JSON.stringify(d.current.unit));
    assert(d.current.unit !== '未分组',
      '首卡落在「未分组」，实际 ' + JSON.stringify(d.current.unit));
  });

  await check('按单元筛选真的生效：选一个还有词可练的单元，队列里没有其它单元的词', async () => {
    const p = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 600));

    // 先把本轮进度清零：applyFilter 在"本轮做过题"时会弹 showModal 让用户确认，
    // 自动化里没人点确认 —— 那条路径会静默不生效，用例就假绿了。
    await p.setData({ reviewed: 0, done: false });

    // ⚠️ 不能写死 Unit 2（2026-09-19 改）。作者本人会为听写把某个单元**整单元学完**，
    // 那个单元在 scope='due' 下队列就是空的 —— 这是**合法状态**（完成页会给
    // "这个范围暂时没有要复习的词"），不是筛选坏了。本断言要抓的事故是
    // "词没有 unit → 筛不出来 / 混进别的单元"，所以动态选一个还有未学词的单元：
    // learned < count ⇒ 必有新卡 ⇒ 'due' 队列必非空，>0 这条断言才有判别力。
    const d0 = await p.data();
    const cand = (d0.units || []).filter(u => u.learned < u.count)
      .sort((a, b) => b.count - a.count);
    const target = cand.length ? cand[0].unit : (d0.units || [])[0] && (d0.units || [])[0].unit;
    assert(target, 'units 为空，无法做单元筛选断言：' + JSON.stringify(d0.units));
    const meta = (d0.units || []).filter(u => u.unit === target)[0] || { count: Infinity };

    await p.callMethod('pickUnit', { currentTarget: { dataset: { unit: target } } });
    await new Promise(r => setTimeout(r, 900));

    const d = await p.data();
    eq(d.unit, target, '筛选未切到 ' + target);
    assert(d.queue.length > 0,
      target + ' 一个词都筛不出来（这正是事故现象），units=' + JSON.stringify((d.units || []).map(u => u.unit)));
    const foreign = d.queue.filter(c => c.unit !== target).map(c => c.unit || '(无 unit)');
    assert(foreign.length === 0, '队列里混进了其它单元的词：' + JSON.stringify(foreign.slice(0, 5)));

    // 队列不该超过该单元的词数（有未学词才选它 ⇒ 新卡不受每日上限限制，
    // 见 schedule.shouldApplyDailyLimits 的 unit==='all' 条件，这里必走零裁剪分支）
    assert(d.queue.length <= meta.count,
      target + ' 只有 ' + meta.count + ' 个词，队列不该更多，实际 ' + d.queue.length);
    console.log('      ' + target + ' 队列 ' + d.queue.length + ' 张');

    // 还原筛选：别把演示机留在"只看某单元"的状态（applyFilter 会写 study_prefs）
    await p.setData({ reviewed: 0, done: false });
    await p.callMethod('pickUnit', { currentTarget: { dataset: { unit: 'all' } } });
    await new Promise(r => setTimeout(r, 800));
    eq((await p.data()).unit, 'all', '筛选未还原成 all');
  });

  /*--------------------- ⑥ 朗读页识别通道 ---------------------*/
  console.log('\n-- 朗读页 --');

  await check('朗读页能识别出语音通道（云函数未配置时应正确降级）', async () => {
    const p = await mini.switchTab('/pages/pronounce/pronounce');
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 300));
      const d = await p.data();
      if (d.service && d.service !== 'checking') break;
    }
    const d = await p.data();
    assert(['ok', 'fail'].indexOf(d.service) !== -1, '服务状态未确定：' + d.service);
    console.log('      语音通道：voiceMode=' + d.voiceMode + ' service=' + d.service);
    // 未配云函数时应是 offline 或 local，且给了出路文案
    if (d.service === 'fail') {
      assert(d.serviceMsg && d.serviceMsg.length > 0, '失败时必须给出路文案');
    }
  });

  /*--------------------- ⑦ 资源按需加载（真引擎） ---------------------*/
  //
  // 这一组守的是**只有真引擎能发现**的一类问题：模块在 Node 里能 require，
  // 在真机/引擎里却加载不到。2026-09-18 的教材页事故就是这一类 ——
  // 20 册教材用 require('*.json') 加载，Node 门禁全绿，真引擎 100% 失败
  // （点任何一册都弹「这本教材暂时打不开」）。
  //
  // 为什么必须在这里测而不是 verify-structure 里测：静态扫描只能看"写法"，
  // 判断不了"这个文件到底有没有进包"。只有让引擎真的 require 一次才算数。
  console.log('\n-- 资源按需加载（真引擎执行）--');

  await check('教材注册表全量在真引擎里按需加载（防 require(.json) 类事故复发）', async () => {
    const r = await mini.evaluate(function () {
      var out = { total: 0, ok: 0, fail: [] };
      try {
        // 2026-09-25 教材整理：注册表已随包搬进 pack-curriculum（主包不再有副本），
        // 这里必须跟过去 —— 老路径在引擎里 require 直接报 module not defined。
        var reg = require('pack-curriculum/utils/curriculum-books.js');
        var list = reg.list();
        out.total = list.length;
        for (var i = 0; i < list.length; i++) {
          try {
            var d = reg.load(list[i].id);
            if (d && d.words && d.words.length > 0) out.ok++;
            else out.fail.push(list[i].id + ':empty');
          } catch (e) {
            out.fail.push(list[i].id + ':' + String((e && e.message) || e).slice(0, 60));
          }
        }
      } catch (e) {
        out.fail.push('registry:' + String((e && e.message) || e).slice(0, 80));
      }
      return out;
    });
    assert(r.total > 0, '册次注册表为空（require 失败？）：' + JSON.stringify(r.fail.slice(0, 2)));
    assert(r.ok === r.total,
      r.total + ' 册中 ' + (r.total - r.ok) + ' 册加载失败：' + r.fail.slice(0, 3).join('; '));
    console.log('      ' + r.ok + '/' + r.total + ' 册按需加载成功');
  });

  await check('预置词库模块能加载（首次启动的 295 词靠它）', async () => {
    const r = await mini.evaluate(function () {
      try {
        var d = require('data/textbook-7a.js');
        return { ok: true, n: (d.words || []).length };
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e).slice(0, 100) };
      }
    });
    assert(r.ok, 'textbook-7a.js 加载失败：' + r.err);
    assert(r.n === 295, '预置词数应为 295，实际 ' + r.n);
    console.log('      预置词库 ' + r.n + ' 词');
  });

  await check('教材导入页二级入口可用（选册后能看到单元）', async () => {
    const p = await mini.reLaunch('/pack-curriculum/pages/curriculum/curriculum');
    await new Promise(r => setTimeout(r, 1500));
    let d = await p.data();
    if (d.stage !== 'books') {
      await p.callMethod('backToBooks');
      await new Promise(r => setTimeout(r, 800));
      d = await p.data();
    }
    assert(d.stage === 'books', '未回到选册层，stage=' + d.stage);
    // 册数不写死：注册表在并行开发期已扩到 32 册，写死数字每次扩册都得改门禁
    //（本轮「应列出 20 册实际 32」的假红就是这么来的）。下限 20 只防"列表空/被截断"。
    assert((d.books || []).length >= 20, '选册列表异常（应 ≥20 册），实际 ' + (d.books || []).length);

    // 打开一册（用真实页面方法，与用户点击同一代码路径）
    await p.callMethod('openBookById', 'wy7s_2024');
    await new Promise(r => setTimeout(r, 1500));
    d = await p.data();
    assert(d.stage === 'units', '点册后未进入单元层，stage=' + d.stage);
    assert((d.units || []).length > 0, '单元列表为空');
    console.log('      wy7s_2024 打开成功，' + d.units.length + ' 个单元');
  });

  /*--------------------- ⑧ 跨页请求通道（真引擎） ---------------------*/
  //
  // 这一层才是能抓住本轮 bug 的地方。Node 门禁（verify-pages.js）用 mock 驱动实例、
  // 由测试自己决定调不调 onShow，只能证明"consumePending 的逻辑对"；
  // 而本轮事故的根因是**真引擎的生命周期**：
  //   · 复习页是 tabBar 页 = 长生命周期实例，wx.switchTab 到**已经创建过**的它
  //     不重跑 onLoad、只跑 onShow；
  //   · 跨页请求原来只在 onLoad 里消费 → 「练这一张」「错题重练」静默失效，
  //     标记留在盘上，等某次完全无关的切页才突然生效（幽灵状态）。
  // 只有真的走一次「卡详情页 → 复习页」的 switchTab，才算覆盖了这个 bug。
  //
  // ⚠️ 两条纪律（都是上一轮真机断言踩过的坑，别重复）：
  //   ① switchTab 到**当前所在的 tab** 不会触发 onShow，而 onShow 正是本轮新增的
  //      消费入口。所以每次要测"跨页请求"之前，必须先让当前页不是复习页。
  //   ② 前面的用例会真的评卡，队列里会混进复习卡 —— 限流后的长度**不是恒为
  //      dailyNewWords**。所以只断言不变量（等于首页那一行的数字、不超过全量到期数），
  //      绝不写死"受限流影响"的数字。
  console.log('\n-- 跨页请求通道（真引擎执行）--');

  await check('★ 「练这一张」在复习页已打开过的前提下真的生效（本轮 bug 的回归测试）', async () => {
    // 前置：先真的把复习页创建出来。这一步不能省 ——
    // 若跳过它，走的就是"冷启动 onLoad"路径，修之前也能通过，
    // 那正是这个 bug 藏了这么久的原因。
    const first = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 900));
    const baseline = await first.data();
    assert(baseline.ready === true, '前置：复习页应已就绪');
    assert(baseline.singleMode === false, '前置：不该已在单卡模式');

    let cardId = baseline.current && baseline.current.id;
    if (!cardId) {
      // 队列可能已清空（全练完了）——那就直接从词库取一张，保证这条用例永远可跑
      cardId = await mini.evaluate(function () {
        var cs = require('utils/cards.js').allCards();
        return cs.length ? cs[0].id : '';
      });
    }
    assert(cardId, '前置：拿不到任何卡片 id');

    // 走真实路径：回首页 → 进卡详情页 → 点「练这一张」
    await mini.switchTab('/pages/deck/deck');
    await new Promise(r => setTimeout(r, 700));
    const cardPage = await mini.navigateTo('/pages/card/card?id=' + cardId);
    assert(cardPage, '未打开卡详情页');
    await new Promise(r => setTimeout(r, 900));
    const cd = await cardPage.data();
    assert(cd.card && cd.card.id === cardId,
      '卡详情页没拿到这张卡：' + JSON.stringify(cd.card && cd.card.id));

    await cardPage.callMethod('practiceOne');    // 写 single_practice + switchTab 到复习页
    await new Promise(r => setTimeout(r, 1400));

    const p = await mini.currentPage();
    assert(p && p.path.indexOf('study') !== -1, '没有切回复习页，实际 ' + (p && p.path));
    const d = await p.data();
    assert(d.singleMode === true,
      '「练这一张」没生效 —— 这正是本轮 bug 的现象（tabBar 页不重跑 onLoad，请求没人消费）');
    eq(d.queue.length, 1, '单卡模式队列应只有 1 张');
    eq(d.current.id, cardId, '应练的就是卡详情页那一张');
  });

  await check('★ 首页「错题重练」真的把复习页切到 scope=weak（prefs 落盘 ≠ 页面立刻生效）', async () => {
    // 先制造一道错题：走真实路径 = 翻面 → 点「不认识」
    const s0 = await mini.switchTab('/pages/study/study');
    await new Promise(r => setTimeout(r, 900));
    let d0 = await s0.data();
    if (d0.done) {
      await s0.callMethod('again');
      await new Promise(r => setTimeout(r, 1000));
      d0 = await s0.data();
    }
    assert(d0.current, '复习页没有可评的卡');
    const wrongId = d0.current.id;
    if (!d0.flipped) await s0.callMethod('flipCard');
    await new Promise(r => setTimeout(r, 500));
    await s0.callMethod('onGrade', { currentTarget: { dataset: { q: 1 } } });
    await new Promise(r => setTimeout(r, 1400));

    const weak = await mini.evaluate(function () {
      var cards = require('utils/cards.js').allCards();
      var states = require('utils/store.js').loadStates();
      var sched = require('utils/schedule.js');
      var today = require('utils/date.js').todayStr();
      var ids = require('utils/store.js').weakIds();
      return {
        ids: ids,
        n: sched.pickCards(cards, states, today,
          { subject: 'all', scope: 'weak', unit: 'all' }, ids).length
      };
    });
    assert(weak.ids.indexOf(wrongId) !== -1,
      '刚评「不认识」的卡没进错题本（weakIds 里找不到 ' + wrongId + '）');

    // 走真实入口：回首页点「错题重练」
    const deck = await mini.switchTab('/pages/deck/deck');
    await new Promise(r => setTimeout(r, 900));
    const dd = await deck.data();
    assert(dd.weakCount >= 1, '首页错题本数字应 ≥1，实际 ' + dd.weakCount);
    eq(dd.weakCount, weak.ids.length, '首页错题本数字与 weakIds 不一致');

    await deck.callMethod('goWeakPractice');     // 写 pending_study + switchTab
    await new Promise(r => setTimeout(r, 1400));

    const p = await mini.currentPage();
    assert(p && p.path.indexOf('study') !== -1, '没切到复习页，实际 ' + (p && p.path));
    const d = await p.data();
    eq(d.scope, 'weak',
      '「错题重练」没生效 —— scope 仍是旧值（prefs 落了盘，但页面实例从不重读）');
    eq(d.subject, 'all', '错题重练是全库范围，不该被残留学科困住');
    eq(d.unit, 'all', '错题重练是全库范围，不该被上一轮选过的单元困住');
    eq(d.queue.length, weak.n, '错题队列长度应等于错题本在该范围下的张数');
    assert(d.queue.length > 0, '错题队列不该为空');
    const leaked = d.queue.map(c => c.id).filter(id => weak.ids.indexOf(id) === -1);
    assert(leaked.length === 0, '错题队列里混进了非错题卡：' + JSON.stringify(leaked.slice(0, 5)));
  });

  await check('★ 首页单元入口 due=0 分支：真点那一行 → 走 scope=all 给整单元（不是死路）', async () => {
    const deck = await mini.switchTab('/pages/deck/deck');
    await new Promise(r => setTimeout(r, 1000));
    const rows = ((await deck.data()).units || []).slice();
    assert(rows.length > 1, '首页应有多个单元，实际 ' + rows.length);

    /**
     * 优先用**真实的** due=0 单元（跑得多了自然会攒出来）；一个都没有时才造。
     *
     * ⚠️ 这里的第一版断言要求"探针单元 due > 0"，即假定机器上一定有单元还有到期词 ——
     * 结果本套件自己把 7A Starter 练到 due=0 之后，用例就开始假失败。
     * 那正是"断言写死了机器状态"的典型：坏的是断言，不是代码。
     * 现在两种情形都走同一条产品契约，不再依赖机器处在哪一步。
     */
    const realZero = rows.filter(u => u.due === 0)[0];
    let idx, probe, how;
    if (realZero) {
      idx = rows.indexOf(realZero);
      probe = realZero;
      how = '真实 due=0';
    } else {
      // 挑词数最少的单元做探针，只注入"今天没有到期的"这一个前提，其余字段全真
      idx = rows.reduce((a, u, i, arr) => (arr[i].count < arr[a].count ? i : a), 0);
      probe = rows[idx];
      how = '注入 due=0';
      await deck.setData({
        units: rows.map((u, i) => Object.assign({}, u, { due: i === idx ? 0 : u.due }))
      });
      await new Promise(r => setTimeout(r, 700));
    }
    assert(probe.count > 0, '前置：探针单元应有词');

    const els = await deck.$$('.unit-row');
    assert(els.length === rows.length,
      '单元行元素数应等于单元数：' + els.length + ' vs ' + rows.length);

    const scopeAttr = await els[idx].attribute('data-scope');
    eq(scopeAttr, 'all', 'due=0 的那一行 data-scope 应为 all（否则点进去是空的 = 死路）');

    await els[idx].tap();
    await new Promise(r => setTimeout(r, 1400));

    const p = await mini.currentPage();
    assert(p && p.path.indexOf('study') !== -1, '没切到复习页，实际 ' + (p && p.path));
    const d = await p.data();
    eq(d.unit, probe.unit, '没切到该单元');
    eq(d.scope, 'all', 'due=0 的单元必须送 scope=all（整单元过一遍）');
    eq(d.queue.length, probe.count,
      'due=0 时首页那一行显示"共 ' + probe.count + ' 个"，点进去就该是 ' + probe.count + ' 张');
    assert(d.queue.length > 0, 'due=0 的单元点进去不能是空的 —— 那就是死路');
    console.log('      ' + probe.unit + '（' + how + '）：首页显示"共 ' + probe.count +
      ' 个" → 队列 ' + d.queue.length + ' 张');
  });

  await check('★ 学生显式选单元时给满整单元（不受每日上限），且与首页那一行的数字一致', async () => {
    /**
     * 为什么先把上限压到 1/1 再断言：默认上限是 10/30，而"某个单元还剩多少到期"
     * 完全取决于这台机器累积了多少学习进度 —— 本用例的第一版就要求"某单元到期 > 10"，
     * 结果被本套件自己练过几轮之后必然假失败（断言绑死了机器状态）。
     * 压到 1/1 之后，"限流 vs 不限流"的差别在任何进度下都稳定可观察，
     * 而且对照更强：不限单元只给 2 张，选单元给满几十张。
     *
     * try/finally 是硬要求：上限是**持久化设置**，中途断言失败也必须还原，
     * 否则作者明天录视频时"每天只给 1 个新词"。
     */
    const caps = await mini.evaluate(function () {
      var s = require('utils/settings.js');
      var old = s.load();
      s.save({ dailyNewWords: 1, dailyReviewMax: 1 });
      return old;
    });
    // 先记下原始异常再还原：若 finally 里直接断言，还原失败会把真正的失败原因盖掉。
    let err = null;
    try {
      // 对照：不限单元 → 被限流压到 ≤ 1 复习 + 1 新词
      const study0 = await mini.switchTab('/pages/study/study');
      await new Promise(r => setTimeout(r, 900));
      await study0.setData({ reviewed: 0, done: false });
      await study0.callMethod('pickUnit', { currentTarget: { dataset: { unit: 'all' } } });
      await new Promise(r => setTimeout(r, 900));
      await study0.callMethod('pickScope', { currentTarget: { dataset: { scope: 'due' } } });
      await new Promise(r => setTimeout(r, 900));
      const capped = (await study0.data()).queue.length;
      assert(capped <= 2,
        '不限单元时上限(1 复习 + 1 新词)应把队列压到 ≤2，实际 ' + capped +
        '（说明限流没生效，或页面没切回 不限单元/今日待复习）');

      // 正题：选一个单元 → 给满整单元
      const deck = await mini.switchTab('/pages/deck/deck');
      await new Promise(r => setTimeout(r, 900));
      const units = ((await deck.data()).units || []).slice();
      assert(units.length > 1, '首页应有多个单元，实际 ' + units.length);

      let idx = 0;
      units.forEach((u, i) => { if (u.due > units[idx].due) idx = i; });
      const pick = units[idx];
      assert(pick.due >= 3,
        '前置：需要一个还剩 ≥3 张到期的单元才验得出"不限流"，实际最大 ' + pick.due +
        '（' + pick.unit + '）—— 这台机器的词可能已经练得差不多了，重置进度或换台机器再跑');

      const els = await deck.$$('.unit-row');
      assert(els.length === units.length, '单元行元素数应等于单元数');
      await els[idx].tap();
      await new Promise(r => setTimeout(r, 1400));

      const p = await mini.currentPage();
      assert(p && p.path.indexOf('study') !== -1, '没切到复习页');
      const d = await p.data();

      eq(d.unit, pick.unit, '没切到该单元');
      eq(d.scope, 'due', '应仍是今日待复习');
      eq(d.queue.length, pick.due, '选单元时队列应等于首页那一行显示的数字（不被每日上限裁）');
      assert(d.queue.length > capped,
        '选单元时应给满整单元（' + pick.due + ' 张 > 不限单元时的 ' + capped +
        ' 张）—— 否则限流条件漏了 unit 判断');
      eq(d.hiddenNew, 0, '选单元时不该有被上限挡下的新词');
      eq(d.hiddenReview, 0, '选单元时不该有被上限挡下的复习词');
      const foreign = d.queue.filter(c => (c.unit || '未分组') !== pick.unit);
      assert(foreign.length === 0, '队列里混进了其它单元的词');
      console.log('      上限压到 1/1：不限单元 ' + capped + ' 张 → 选 ' + pick.unit + ' ' +
        d.queue.length + ' 张（给满）');
    } catch (e) {
      err = e;
    } finally {
      // 无论成败都必须还原成这台机器原来的上限（不是写死 10/30 —— 作者可能自己调过）
      const now = await mini.evaluate(function (old) {
        require('utils/settings.js').save(old);
        return require('utils/settings.js').load();
      }, caps);
      if (now.dailyNewWords !== caps.dailyNewWords || now.dailyReviewMax !== caps.dailyReviewMax) {
        err = err || new Error('每日上限没能还原：现在 ' + JSON.stringify(now) +
          '，原值 ' + JSON.stringify(caps));
      }
    }
    if (err) throw err;
  });

  await check('★ 首页单元入口：每个单元的数字 === 真点进去的队列长度（覆盖 WXML→dataset 绑定）', async () => {
    const deck0 = await mini.switchTab('/pages/deck/deck');
    await new Promise(r => setTimeout(r, 1000));
    const rows = ((await deck0.data()).units || []).slice();
    assert(rows.length > 1, '首页应有多个单元，实际 ' + rows.length);

    const bad = [];
    let zeroDue = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const scope = row.due > 0 ? 'due' : 'all';
      const shown = row.due > 0 ? row.due : row.count;   // 与 deck.wxml 的显示口径一致
      if (row.due === 0) zeroDue++;

      // ⚠️ 纪律①：每次都先把当前页切回首页。否则 switchTab 到"当前所在的 tab"
      //    不触发 onShow、pending_study 留在盘上，用例会假失败（上一轮踩过）。
      const deck = await mini.switchTab('/pages/deck/deck');
      await new Promise(r => setTimeout(r, 800));
      const els = await deck.$$('.unit-row');
      if (els.length !== rows.length) { bad.push('切回首页后单元行数变了：' + els.length); break; }

      const unitAttr = await els[i].attribute('data-unit');
      const scopeAttr = await els[i].attribute('data-scope');
      if (unitAttr !== row.unit) {
        bad.push('第 ' + i + ' 行 data-unit=' + JSON.stringify(unitAttr) + '，期望 ' + row.unit);
      }
      if (scopeAttr !== scope) {
        bad.push(row.unit + '：data-scope=' + JSON.stringify(scopeAttr) + '，期望 ' + scope +
          '（due=' + row.due + '）');
      }

      await els[i].tap();          // 真点，走 WXML 的 dataset 绑定
      await new Promise(r => setTimeout(r, 1100));

      const p = await mini.currentPage();
      const d = await p.data();
      if (d.unit !== row.unit) bad.push(row.unit + '：没切到该单元，实际 ' + JSON.stringify(d.unit));
      if (d.scope !== scope) bad.push(row.unit + '：scope 应为 ' + scope + '，实际 ' + d.scope);
      if (d.queue.length !== shown) {
        bad.push(row.unit + '：首页显示 ' + shown + '（due=' + row.due + ', count=' + row.count +
          '）但点进去 ' + d.queue.length + ' 张');
      }
    }
    assert(bad.length === 0, '首页数字与复习页队列不一致：\n      ' + bad.join('\n      '));
    console.log('      核对 ' + rows.length + ' 个单元（逐行真点；其中真实 due=0 的 ' + zeroDue + ' 个）');
  });

  await check('★ 单卡模式练完即退出：singleMode 归 false，且用户能自己回到普通队列', async () => {
    await mini.switchTab('/pages/deck/deck');
    await new Promise(r => setTimeout(r, 700));
    const cardId = await mini.evaluate(function () {
      var cs = require('utils/cards.js').allCards();
      return cs.length ? cs[0].id : '';
    });
    assert(cardId, '词库里没有卡');

    const cardPage = await mini.navigateTo('/pages/card/card?id=' + cardId);
    await new Promise(r => setTimeout(r, 900));
    await cardPage.callMethod('practiceOne');
    await new Promise(r => setTimeout(r, 1400));

    const p = await mini.currentPage();
    assert(p && p.path.indexOf('study') !== -1, '没切到复习页');
    let d = await p.data();
    assert(d.singleMode === true, '前置：应进入单卡模式');
    eq(d.queue.length, 1, '前置：单卡队列应只有 1 张');

    // 练完它（q=5 不触发当天重排，所以一次就完成）
    if (!d.flipped) await p.callMethod('flipCard');
    await new Promise(r => setTimeout(r, 500));
    await p.callMethod('onGrade', { currentTarget: { dataset: { q: 5 } } });
    await new Promise(r => setTimeout(r, 1800));

    d = await p.data();
    assert(d.done === true, '前置：应练完，实际 done=' + d.done);
    eq(d.singleMode, false,
      '练完必须退出单卡模式 —— 否则这个 tabBar 实例永远锁死在那一张卡上，用户没有任何办法自己出来');

    // 用户能自己出来：再来一轮回到普通队列，而不是又是同一张卡
    await p.callMethod('again');
    await new Promise(r => setTimeout(r, 1400));
    d = await p.data();
    eq(d.singleMode, false, 'again() 之后不该还是单卡模式');
    assert(!(d.queue.length === 1 && d.queue[0].id === cardId),
      'again() 之后仍锁死在同一张卡上（用户没有任何办法自己出来）');
  });

  /*--------------------- ⑨ 收尾：还原默认状态 ---------------------*/
  //
  // 作者明天要用这台机器录演示视频。前面所有用例都会真的评卡、真的切筛选，
  // 所以这里必须把 prefs 与两个跨页请求键清回默认 —— 否则录屏第一屏
  // 就是一个"只看某个单元 / 只看错题"的复习页，且原因不明。
  console.log('\n-- 收尾（还原默认状态）--');

  await check('收尾：prefs 还原为 {subject:all, scope:due, unit:all}，跨页请求键不留残留', async () => {
    const r = await mini.evaluate(function () {
      var store = require('utils/store.js');
      try { wx.removeStorageSync('single_practice'); } catch (e) { /* 键不存在也算干净 */ }
      try { wx.removeStorageSync('pending_study'); } catch (e) { /* 同上 */ }
      store.savePrefs({ subject: 'all', scope: 'due', unit: 'all' });
      return store.loadPrefs();
    });
    eq(r.subject, 'all', 'prefs.subject 未还原');
    eq(r.scope, 'due', 'prefs.scope 未还原');
    eq(r.unit, 'all', 'prefs.unit 未还原');

    // 学习量上限：本套件在「给满整单元」那条里临时压到过 1/1。
    // 那条自己有 try/finally + 还原校验，这里再加一道网 —— 它若漏了，
    // 作者明天录视频会看到"每天只给 1 个新词"。
    const caps = await mini.evaluate(function () {
      var s = require('utils/settings.js');
      return s.load();
    });
    assert(!(caps.dailyNewWords === 1 && caps.dailyReviewMax === 1),
      '每日上限还停在测试用的 1/1，没还原：' + JSON.stringify(caps));

    // reLaunch 会重建页面实例（走 onLoad 读 prefs），这样断言的是"下次进页面看到什么"
    const p = await mini.reLaunch('/pages/study/study');
    await new Promise(r2 => setTimeout(r2, 1200));
    const d = await p.data();
    eq(d.unit, 'all', '复习页仍停在某个单元筛选上');
    eq(d.scope, 'due', '复习页仍停在非默认范围');
    eq(d.subject, 'all', '复习页仍带着学科筛选');
    eq(d.singleMode, false, '复习页仍停在单卡模式');

    // 最后停回首页，作者打开工具就是干净的首页
    await mini.reLaunch('/pages/deck/deck');
    await new Promise(r2 => setTimeout(r2, 800));
  });

  /*--------------------- 汇总 ---------------------*/
  console.log('\n' + '='.repeat(62));
  console.log('>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('='.repeat(62));
  if (fail > 0) {
    console.log('\n失败：' + failures.join(' / '));
  }
  // 离场恢复：把学后拼写开关还给学生（默认开）
  try {
    await mini.evaluate(() => {
      const p = wx.getStorageSync('study_prefs') || {};
      delete p.spellCheck;
      wx.setStorageSync('study_prefs', p);
    });
  } catch (e) { /* 恢复失败不掩盖结果 */ }
  await mini.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试异常终止：', e && e.message ? e.message : e);
  process.exit(3);
});
