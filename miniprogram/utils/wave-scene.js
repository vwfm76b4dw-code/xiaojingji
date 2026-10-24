/* wave-scene.js —— 开屏水面场景的共享绘制代码
 *
 * 为什么单独成文件
 * ----------------
 * 同一份绘制代码要被两处使用：HTML 原型（快速迭代）与小程序
 * <canvas type="2d">（最终交付）。写在同一个文件里用 UMD 包装，
 * 原型内联、小程序 require，两边不可能漂开。
 *
 * 只用 Canvas 2D 的基础 API（路径 / 渐变 / 变换 / globalAlpha / arc）。
 * 刻意避开 filter、shadowBlur、Path2D、roundRect —— 这些在小程序的
 * canvas 2d 上支持情况不确定，踩了会很难查。
 *
 * 坐标系
 * ------
 * 调用方传入**逻辑**宽高 (W, H)，且已按 dpr 缩放好 ctx。
 * 本模块内部一律用相对比例（H*0.40、W*0.48 这种），不出现绝对像素，
 * 换设备不会跑版。
 *
 * 水面即裁剪面
 * ------------
 * 鲸鱼不是"摆在水面下"，而是**被水面路径裁掉**：每帧用同一条波浪曲线
 * 建立裁剪区，鲸鱼画在里面。所以波峰抬高时天然会切住鱼背，
 * "在水面上看不见这条鱼"是几何保证，不靠调参数。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaveScene = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ================= 时间轴（毫秒） =================
   * 改这里必须同步改 deck.js 的 SPLASH_HOLD_MS / SPLASH_FADE_MS，
   * 以及 deck.wxss 里品牌字的 animation-delay。
   */
  var T = {
    SURFACE_IN: 0, SURFACE_DUR: 500,   // 水面淡入
    SWIM_START: 140, SWIM_DUR: 1150,   // 鲸鱼从画外（右侧）游到中央
    MARK: 900,                          // 品牌字开始淡入
    SUB: 1030,                          // 副标题开始淡入
    TEXT_FADE: 340,                     // 两者淡入时长
    HOLD: 1480,                         // 开始淡出
    FADE: 280                           // 淡出时长
  };

  /* ================= 鲸鱼几何 + 脊骨行波 =================
   * 来源 assets/splash-whale.svg（一条闭合路径，身体与尾鳍本就在一起）。
   * 坐标已预先代入 SVG 自带的分组变换 translate(72 78) scale(0.90) translate(-72 -72)。
   *
   * 游动怎么做：**脊骨行波（spine traveling wave）**
   * --------------------------------------------------
   * 鱼/鲸的 BCF（体-尾鳍推进）游动在生物力学里被描述为一列沿体轴传播的行波：
   *
   *     y(x, t) = A(x) · sin(2π(x − x₀)/λ − ωt)
   *     A(x)    = A_max · u^p ,   u = (x − x₀)/L ,   p ≈ 2
   *
   * 波幅 A(x) 向尾部递增（p=2 让头部几乎不动、摆幅集中到后半身），相位沿 x
   * 滞后，于是波形从头部向尾部"跑"—— 这就是"游"的本质。游戏里做鱼/鲸游动的
   * 标准做法（骨骼 + 蒙皮权重 + 网格变形）本质上是同一件事。
   *
   * 鲸属鲔行（thunniform）：躯干僵直、波动集中在尾柄。完全照做会显得生硬，
   * 所以取**亚鲹行（subcarangiform）**作折中：后半身波动、头部稳定 ——
   * 吉祥物的脸不能晃，否则辨识度会掉。
   *
   * 为什么用**纯竖直剪切**（只改 y、不改 x）而不是骨链 + 蒙皮权重：
   *   · 剪切映射 (x,y) → (x, y+h(x)) 的雅可比行列式恒为 1 > 0，
   *     所以它**结构上不可能自交**，轮廓永远是简单多边形；
   *     骨链 LBS 需要额外验证权重不产生折叠，那是另一类 bug。
   *   · 侧视图里体波本来就表现为"各横截面上下错开"，剪切是它的直接表达。
   *
   * 顺带彻底解决了关节问题：身体与尾鳍是**同一块形状的连续形变**，
   * 不存在关节缝 —— 原先那套"体/尾拆分 + 关节圆盘 + 搭接舌"整个删掉了，
   * 之前踩的两个坑（半透明重叠叠深、搭接舌跟着转走）也随之消失。
   */
  var WHALE = [
    ['M', 25.2, 85.2],
    ['C', 25.2, 65.4, 43.2, 51.0, 66.6, 51.0],
    ['C', 84.6, 51.0, 95.4, 60.0, 99.9, 70.8],
    ['C', 102.6, 61.8, 109.8, 52.8, 120.6, 45.6],
    ['C', 117.9, 58.2, 113.4, 67.2, 106.2, 74.4],
    ['C', 106.2, 76.2, 106.2, 78.0, 106.2, 79.8],
    ['C', 113.4, 85.8, 117.9, 94.8, 120.6, 107.4],
    ['C', 109.8, 100.2, 102.6, 92.4, 99.9, 83.4],
    ['C', 95.4, 92.4, 84.6, 99.6, 66.6, 99.6],
    ['C', 43.2, 99.6, 25.2, 96.0, 25.2, 85.2],
    ['Z']
  ];
  var MOUTH = [['M', 25.2, 88.8], ['Q', 43.2, 96.9, 57.6, 93.3]];
  var EYE = { x: 41.4, y: 73.5, r: 5.04 };
  var MOUTH_W = 3.96;
  var WHALE_CX = 72.9, WHALE_CY = 77.1, WHALE_W = 95.4;
  var WHALE_X0 = 25.2;                 // 体轴起点（吻部）

  /* 行波参数。改这四个数就能调游动的性格：
   *   amp     尾部最大横摆（局部单位；鲸高 63，故 11 约为 ±17% 体高）。
   *           上限由**水面余量**卡住，不是自交：扫描实测 amp=13 时尾鳍上叶距水面
   *           只剩 19.5px、amp=15 只剩 10.9px，太容易被波峰切到。
   *           amp=11 时余量 27px、尾部转角 37.4°、雅可比最小 0.52。
   *   lamK    波长 = lamK × 体长。生物实测多在 0.9~1.2；取 2.2 有双重好处：
   *           ① 把截面转角梯度摊平，雅可比余量从 0.36 升到 0.52（同样的摆幅下更安全）；
   *           ② 体轴上的相位差变小（约 163°），躯干更稳、波动集中在尾柄 ——
   *           这反而更接近鲸的鲔行特征。
   *   period  摆尾周期 ms。700ms ≈ 1.43 次/秒，与"缓速巡航"相称。
   *   power   包络幂次。取 1.8：2 次幂把摆幅几乎全压在尾鳍上、中段不动；
   *           1.5 又让波动过于均匀。1.8 让后三分之一明显波动，头区（u<0.2）仍静止。
   */
  var WAVE = { amp: 11.0, lamK: 2.20, period: 700, power: 1.8 };

  /** 体波在体轴 x 处的横向位移（局部单位）。 */
  function waveOffset(x, t) {
    var u = clamp((x - WHALE_X0) / WHALE_W, 0, 1);
    var a = WAVE.amp * Math.pow(u, WAVE.power);
    var lam = WAVE.lamK * WHALE_W;
    return a * Math.sin(2 * Math.PI * (x - WHALE_X0) / lam
                        - 2 * Math.PI * t / WAVE.period);
  }

  /** 体波在体轴 x 处的**局部转角** θ = dh/dx（弧度）。 */
  function waveSlope(x, t) {
    var u = clamp((x - WHALE_X0) / WHALE_W, 0, 1);
    var k = 2 * Math.PI / (WAVE.lamK * WHALE_W);
    var A = WAVE.amp * Math.pow(u, WAVE.power);
    var dA = WAVE.amp * WAVE.power * Math.pow(u, WAVE.power - 1) / WHALE_W;
    var ph = k * (x - WHALE_X0) - 2 * Math.PI * t / WAVE.period;
    return dA * Math.sin(ph) + A * k * Math.cos(ph);
  }

  /**
   * 把局部坐标点按体波变形。
   *
   * 关键：截面是**旋转**的，不是平移的 —— 点相对脊柱的偏移按局部转角 θ=dh/dx 旋转。
   * 一开始我用的是纯竖直剪切（只改 y），雅可比恒为 1、绝不自交，看起来更安全，
   * 但实测发现它有个致命缺陷：上下叶尖端在同一个 x 上，剪切让它们**整体平移**，
   * 尾鳍只能"上下滑动"、摆不出"张开合上"（四帧包围盒高度几乎不变，
   * 270~279px，就是这个症状）。旋转才是鱼体波模型的完整形式。
   *
   * 代价是雅可比不再恒为 1，需要**实测**最小行列式（见 wave_check.js 第 7 节）。
   */
  function deform(x, y, t) {
    var h = waveOffset(x, t);
    var th = waveSlope(x, t);
    var dy = y - WHALE_CY;
    var cs = Math.cos(th), sn = Math.sin(th);
    return [x - dy * sn, WHALE_CY + h + dy * cs];
  }

  /** 把贝塞尔路径采样成折线。
   *  形变必须在**点**上做：贝塞尔控制点做不了非线性形变，硬改控制点会走形。 */
  function samplePath(cmds, per) {
    var pts = [], cx = 0, cy = 0, sx = 0, sy = 0, i, k, m;
    for (i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c[0] === 'M') { cx = sx = c[1]; cy = sy = c[2]; pts.push([cx, cy]); }
      else if (c[0] === 'L') { cx = c[1]; cy = c[2]; pts.push([cx, cy]); }
      else if (c[0] === 'Q') {
        var qx = cx, qy = cy;
        for (k = 1; k <= per; k++) {
          m = k / per;
          pts.push([(1-m)*(1-m)*qx + 2*(1-m)*m*c[1] + m*m*c[3],
                    (1-m)*(1-m)*qy + 2*(1-m)*m*c[2] + m*m*c[4]]);
        }
        cx = c[3]; cy = c[4];
      }
      else if (c[0] === 'C') {
        var bx = cx, by = cy;
        for (k = 1; k <= per; k++) {
          m = k / per;
          var u1 = 1 - m;
          pts.push([u1*u1*u1*bx + 3*u1*u1*m*c[1] + 3*u1*m*m*c[3] + m*m*m*c[5],
                    u1*u1*u1*by + 3*u1*u1*m*c[2] + 3*u1*m*m*c[4] + m*m*m*c[6]]);
        }
        cx = c[5]; cy = c[6];
      }
      else if (c[0] === 'Z') { pts.push([sx, sy]); }
    }
    return pts;
  }

  /* 采样一次逐帧复用：每帧重采样纯属浪费。
     密度可调（见 setSampleDensity）：形变必须在**点**上做，采样太稀会让轮廓
     出现削角 —— 实测每段 10 点时最大偏离 1.24 局部单位（屏上 5.3px），肉眼可见。 */
  var SAMPLE_PER = 32;
  var WHALE_PTS = samplePath(WHALE, SAMPLE_PER);
  var MOUTH_PTS = samplePath(MOUTH, SAMPLE_PER);

  /** 调整轮廓采样密度（调参/对比用）。返回实际使用的每段点数。 */
  function setSampleDensity(per) {
    SAMPLE_PER = Math.max(4, Math.min(200, per | 0));
    WHALE_PTS = samplePath(WHALE, SAMPLE_PER);
    MOUTH_PTS = samplePath(MOUTH, SAMPLE_PER);
    return SAMPLE_PER;
  }

  /* 水下鲸鱼的填充色：品牌绿 #00825C 向纸底提亮约 20%。
     不用"品牌绿 + 半透明"是因为半透明重叠会叠深（见上面的关节说明）；
     也不用纯品牌绿，那在浅水里太跳，读起来像贴在水面之上。 */
  var WHALE_FILL = '#32997A';
  var PAPER = '#FAF6EC';
  var INK = '46,74,98';        // --ink #2E4A62 的 rgb 分量，便于拼 rgba

  /* ================= 小工具 ================= */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, u) { return a + (b - a) * u; }

  function trace(ctx, cmds) {
    ctx.beginPath();
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
      else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
      else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else if (c[0] === 'Z') ctx.closePath();
    }
  }

  /* ================= 水面 =================
   * 三组长波长正弦叠加。
   *
   * 为什么不用短波：第一版叠了 5 组（最短波长 41px、振幅 1px），
   * 渲染出来边缘是**锯齿状的噪点**，不是优雅的浪 —— 短波在折线采样下
   * 只会变成高频抖动。参考华为/苹果那种开屏，水面的高级感来自
   * "长波 + 慢速 + 平滑"，不是"细节多"。
   * 波长取 975 / 465 / 232px，振幅合计约 18px（占屏高约 1.1%）。
   * 周期取 10s / 6.4s / 4.4s：开屏只有 1.76s，周期再长（试过 13s）
   * 整段里波峰只漂 130px、定点高度只变 5px，会被看成静止水面。
   */
  var WAVES = [
    { lam: 1.30, amp: 0.0125, per: 10000, ph: 0.0 },
    { lam: 0.62, amp: 0.0080, per: 6400, ph: 1.1 },
    { lam: 0.31, amp: 0.0042, per: 4400, ph: 2.4 }
  ];
  var SURFACE_Y = 0.43;   // 水面基准高度（占屏高）
  var WHALE_Y = 0.562;    // 鲸鱼中心高度：贴在水面下方一点，既看得出"在水里"，
                          // 又留出余量不让波谷切到鱼背（余量由 wave_check.js 校验）

  /**
   * 鲸鱼尾迹：以鲸鱼位置为中心的高斯包络，波长更短、向外扩散。
   * 身后（游向的反侧）包络更宽 —— 尾迹本来就是拖在后面的。
   * 没有这一项，水面的波动与鲸鱼无关，读起来像"鱼贴在会动的壁纸上"。
   */
  function wakeOffset(x, t, W, wk) {
    if (!wk || wk.amp <= 0) return 0;
    var dx = x - wk.x;
    /* 身后更宽。鲸鱼从右往左游，所以"身后"是 dx > 0 那一侧 ——
       方向反了尾迹会拖在胸前，看起来像倒着游（这个错误犯过一次）。 */
    var sig = (dx > 0 ? 0.17 : 0.10) * W;
    var env = Math.exp(-(dx * dx) / (2 * sig * sig));
    return wk.amp * env * Math.sin(dx / (0.045 * W) - t * 0.0042);
  }

  function surfaceY(x, t, W, H, wk) {
    var s = 0;
    for (var i = 0; i < WAVES.length; i++) {
      var w = WAVES[i];
      s += (w.amp * W) * Math.sin(2 * Math.PI * x / (w.lam * W)
                                  - 2 * Math.PI * t / w.per + w.ph);
    }
    return H * SURFACE_Y + s + wakeOffset(x, t, W, wk);
  }

  /* 沿水面走一条折线；close=true 时补到画面底边形成闭合区域（用于裁剪/填充）。
     采样步长要足够细：粗采样会把波形折成有棱角的折线，肉眼可见"折"。
     最短波长 232px 时，1.5px 步长每波约 155 个采样点，足够平滑。 */
  function surfacePath(ctx, W, H, t, wk, close) {
    var step = Math.max(1.5, W / 500);
    ctx.beginPath();
    for (var x = 0; x <= W + step; x += step) {
      var y = surfaceY(x, t, W, H, wk);
      if (x === 0) ctx.moveTo(0, y); else ctx.lineTo(x, y);
    }
    if (close) {
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
    }
  }

  /* ================= 鲸鱼的运动状态 ================= */
  /**
   * 两条运动各自叠加两个不同频率的正弦（单频正弦是节拍器，双频才像活的）：
   *   · 浮沉 bob —— 0.0068W 与 0.0038W 两个幅值
   *   · 俯仰 rot —— 约 ±2.5°
   * 摆尾不再由这里驱动：它已交给脊骨行波（见上文的 waveOffset）。
   * 两处都做摆尾会叠加成双重摆尾，那是另一种假。
   */
  function whaleState(t, W, H) {
    var u = clamp((t - T.SWIM_START) / T.SWIM_DUR, 0, 1);
    var e = 1 - (1 - u) * (1 - u);                 // easeOutQuad：起步略快，收得柔
    /* 行进方向：**从右往左**，1.34W → 0.50W。
     *
     * ⚠️ 方向不能随便定。资产 splash-whale.svg 里眼睛在 x≈38、嘴在 x≈25~56、
     * 尾鳍在 x≈100~126，即**鲸鱼面向左**。早期版本让它从左侧向右移动，
     * 结果是"面向左却向右游"——倒着游。当时鲸鱼是往上跃的，没有"游"的读感，
     * 所以一直没暴露；改成游动后抽帧才看出来（入画时先进来的是尾鳍的叉形）。
     * 要么反过来游，要么水平翻转资产；这里选前者，不动品牌资产。
     *
     * 起点 1.34W：体波的截面旋转会给尾鳍带来最多约 30px 的横向外扩，
     * 留够余量后整只鱼在 t=0 完全在画外，于是不必靠淡入掩盖入画。 */
    var x0 = 1.34 * W, x1 = 0.50 * W;
    var cx = lerp(x0, x1, e);
    /* 浮沉与俯仰各叠两个频率（单频是节拍器）。
       俯仰幅度比"无体波"那版减半 —— 现在身体自己会波动，整只鱼再大幅俯仰就晃得慌。 */
    var bob = (0.0068 * W) * Math.sin(t * 0.00205)
            + (0.0038 * W) * Math.sin(t * 0.00317 + 1.3);
    var rot = 0.028 * Math.sin(t * 0.00171 + 0.4)
            + 0.015 * Math.sin(t * 0.00289 + 2.1);
    // 速度（px/ms）：easeOutQuad 的导数，用来驱动尾迹强度
    var speed = (x1 - x0) * 2 * (1 - u) / T.SWIM_DUR;
    return { x: cx, y: H * WHALE_Y + bob, rot: rot, speed: speed, swim: u };
  }

  /**
   * 鲸鱼当前最高点的 y（屏幕坐标）。
   *
   * 为什么遍历采样点而不是取包围盒四角：体波会把最高点挪到别处，
   * 用四角会低估（最多差十几 px），而"鲸鱼是否露出水面"这条判据就靠它。
   *
   * 为什么必须用**未被裁剪**的几何值：露出水面的部分正好被水面裁掉，
   * 从渲染结果里量到的永远是裁剪后的顶，结论必然是通过。
   */
  function whaleTopY(t, W, H, whaleW) {
    var S = (whaleW || 0.54) * W / WHALE_W;
    var st = whaleState(t, W, H);
    var cs = Math.cos(st.rot), sn = Math.sin(st.rot);
    var top = Infinity;
    for (var i = 0; i < WHALE_PTS.length; i++) {
      var q = deform(WHALE_PTS[i][0], WHALE_PTS[i][1], t);
      var py = st.y + S * ((q[0] - WHALE_CX) * sn + (q[1] - WHALE_CY) * cs);
      if (py < top) top = py;
    }
    return top;
  }

  /** 一帧的全部可验证量，供原型探针与小程序自检共用。
   *  margin = whaleTop - surface，**y 向下为正**，所以 >0 表示鲸鱼最高点
   *  在水面之下（正确状态）。符号写反会让"通过"读成"失败"。 */
  function sceneInfo(t, W, H, whaleW) {
    var st = whaleState(t, W, H);
    var wk = { x: st.x, amp: clamp(st.speed / 1.05, 0, 1.25) * 0.0062 * W };
    var top = whaleTopY(t, W, H, whaleW);
    var surf = surfaceY(st.x, t, W, H, wk);
    return {
      state: st,
      wake: wk,
      whaleTop: top,
      surfaceAtWhale: surf,
      margin: top - surf
    };
  }

  /* ================= 绘制 ================= */
  /**
   * 画鲸鱼。
   *
   * 形变在**局部坐标**里做（只改 y），再套全局变换（位移 / 俯仰 / 缩放）。
   * 身体与尾鳍是同一块形状的连续形变，不存在关节缝 —— 所以既不需要
   * "体/尾拆分 + 关节圆盘"，也不会遇到"半透明重叠叠深"。
   *
   * 全程不透明填充：水下感由调用方叠加的水色覆盖层负责。
   */
  function drawWhale(ctx, st, S, t) {
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(st.rot);
    ctx.scale(S, S);
    ctx.translate(-WHALE_CX, -WHALE_CY);

    var i, p;
    ctx.beginPath();
    for (i = 0; i < WHALE_PTS.length; i++) {
      p = deform(WHALE_PTS[i][0], WHALE_PTS[i][1], t);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fillStyle = WHALE_FILL;
    ctx.fill();

    // 嘴线走同一形变，否则会跟身体脱开
    ctx.beginPath();
    for (i = 0; i < MOUTH_PTS.length; i++) {
      p = deform(MOUTH_PTS[i][0], MOUTH_PTS[i][1], t);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = MOUTH_W;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 眼：只跟随该处体波的位移，保持正圆（它在头部，包络值本就接近 0）
    ctx.beginPath();
    var ep = deform(EYE.x, EYE.y, t);
    ctx.arc(ep[0], ep[1], EYE.r, 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();

    ctx.restore();
  }

  /** 水下光带：几条**宽而软**的波带。
   *  第一版用的是细线，在这么浅的水体上读起来像划痕，且纸白叠纸白几乎看不见。
   *  改成宽波带才有"水在流动"的体量感。波长取得很长（0.75~1.15 屏宽），
   *  配合慢速漂移 —— 优雅来自慢，不来自快。
   *
   * ⚠️ 曾经怀疑"波带上下边界是波浪形、而填充是屏幕垂直渐变，两者不重合
   *    会在边缘切出硬线"，并按此改过一版（把渐变端点外扩一个波幅）。
   *    实测**否证**了这个怀疑：改前改后水体逐行亮度最大跳变都是 3.33 级
   *    （中位 1.33），6 倍对比度放大也看不到边。
   *    分析上也说不通：边缘处 alpha = a·amp·sinθ/half ≈ 0.154a ≈ 0.15/255 级。
   *    所以这里保持原样，不要再"修"它。
   */
  function drawWaterBands(ctx, W, H, t) {
    var BANDS = [
      { y: 0.585, h: 0.060, lam: 0.90, per: 9000,  a: 0.060, ph: 0.0 },
      { y: 0.720, h: 0.075, lam: 1.15, per: 11500, a: 0.052, ph: 1.7 },
      { y: 0.875, h: 0.090, lam: 0.78, per: 7600,  a: 0.044, ph: 3.0 }
    ];
    var step = Math.max(2, W / 200);
    for (var i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      var yc = H * b.y, half = H * b.h / 2;
      var amp = 0.010 * W, lam = b.lam * W, om = 2 * Math.PI / b.per;
      var g = ctx.createLinearGradient(0, yc - half, 0, yc + half);
      g.addColorStop(0, 'rgba(' + INK + ',0)');
      g.addColorStop(0.5, 'rgba(' + INK + ',' + b.a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + INK + ',0)');
      var x, y;
      ctx.beginPath();
      for (x = 0; x <= W + step; x += step) {
        y = yc - half + amp * Math.sin(2 * Math.PI * x / lam - om * t + b.ph);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (x = W; x >= 0; x -= step) {
        ctx.lineTo(x, yc + half + amp * Math.sin(2 * Math.PI * x / lam - om * t + b.ph));
      }
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  /** 水面本身：下方一段渐隐的"厚度" + 一条墨线 + 浪尖上的高光。
   *  三层缺一不可：只有线会像贴纸，只有带会像灰块，加了高光才有"水面反光"。 */
  function drawSurface(ctx, W, H, t, wk) {
    var baseY = H * SURFACE_Y;
    var bandH = H * 0.020;
    var step = Math.max(1.5, W / 500);

    // 水面厚度：从墨线往下 2%H 渐隐到透明
    surfacePath(ctx, W, H, t, wk, false);
    for (var x = W; x >= 0; x -= step) {
      ctx.lineTo(x, surfaceY(x, t, W, H, wk) + bandH);
    }
    ctx.closePath();
    var gb = ctx.createLinearGradient(0, baseY - 0.02 * H, 0, baseY + bandH + 0.02 * H);
    gb.addColorStop(0, 'rgba(' + INK + ',0.085)');
    gb.addColorStop(1, 'rgba(' + INK + ',0)');
    ctx.fillStyle = gb;
    ctx.fill();

    // 浪尖高光：整条曲线向上偏 1.4px 再描一次纸白，浪尖自然更亮
    ctx.save();
    ctx.translate(0, -1.4);
    surfacePath(ctx, W, H, t, wk, false);
    ctx.strokeStyle = 'rgba(250,246,236,0.62)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // 水面墨线：整条曲线的"硬边"，是水面的主要读数
    surfacePath(ctx, W, H, t, wk, false);
    ctx.strokeStyle = 'rgba(' + INK + ',0.38)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /**
   * 画一帧。t 为毫秒。
   * opts.whaleW  鲸鱼宽度占屏宽比例（默认 0.54）
   * opts.top     画布顶边在**整屏坐标**里的位置（默认 0）
   *
   * 为什么要 top：小程序里 <canvas> 是原生组件，普通节点盖不住它。
   * 品牌字必须是 WXML 节点（要保留字距、要能被读屏识别），所以只能让画布
   * **只覆盖下半段**（水面以下那部分），字留在上方纸白区 —— 两者不重叠，
   * 就不存在层级问题。代价是画布里的 y 要减去 top，见下面的 translate。
   *
   * 水体刻意做得很淡：品牌底色是纸白，水一旦压重就会变成一块灰板，
   * 与"优雅、品牌感"相反。水的感觉由三样东西承担：
   *   · 一条清晰的波浪墨线（水面）
   *   · 水面下方一段被提亮的"透光带"（光从水面进来）
   *   · 越深越暗的极淡墨蓝渐变 + 几条宽波带（深度）
   */
  function drawScene(ctx, W, H, t, opts) {
    opts = opts || {};
    var whaleW = opts.whaleW || 0.54;
    var top = opts.top || 0;
    var S = whaleW * W / WHALE_W;

    var st = whaleState(t, W, H);
    var wk = { x: st.x, amp: clamp(st.speed / 1.05, 0, 1.25) * 0.0062 * W };
    var appear = clamp(t / T.SURFACE_DUR, 0, 1);

    ctx.save();
    if (top) ctx.translate(0, -top);

    // 1 天：纯纸底。刻意不加渐变 —— 遮罩淡出时要与 App 的 --paper 完全同色，
    //   否则开屏结束的瞬间会闪一下色差。
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);

    // 2 水体 + 鲸鱼 + 覆盖 + 光带，全部裁在水面之下
    ctx.save();
    surfacePath(ctx, W, H, t, wk, true);
    ctx.clip();
    ctx.globalAlpha = appear;

    var g = ctx.createLinearGradient(0, H * SURFACE_Y, 0, H);
    g.addColorStop(0, 'rgba(' + INK + ',0.020)');
    g.addColorStop(1, 'rgba(' + INK + ',0.115)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var gl = ctx.createLinearGradient(0, H * SURFACE_Y, 0, H * (SURFACE_Y + 0.17));
    gl.addColorStop(0, 'rgba(250,246,236,0.62)');
    gl.addColorStop(1, 'rgba(250,246,236,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(0, 0, W, H);

    /* 鲸鱼**不参与淡入**（globalAlpha 归 1）：它 t=0 时整只在画外，
       入画靠"游进来"而不是"淡出来"。若跟着水面一起淡入，实测 t=180ms 时
       尾缘已进画 60px、不透明度却只有 0.36 —— 看起来是半透明地飘进来。 */
    ctx.globalAlpha = 1;
    drawWhale(ctx, st, S, t);
    ctx.globalAlpha = appear;

    // 覆盖层：再压一层水色，鲸鱼才像"在水里"而不是"贴在水的后面"
    var gv = ctx.createLinearGradient(0, H * SURFACE_Y, 0, H);
    gv.addColorStop(0, 'rgba(' + INK + ',0.030)');
    gv.addColorStop(1, 'rgba(' + INK + ',0.055)');
    ctx.fillStyle = gv;
    ctx.fillRect(0, 0, W, H);

    drawWaterBands(ctx, W, H, t);
    ctx.restore();

    // 3 水面（画在裁剪区之外，否则自身的墨线会被裁掉一半）
    ctx.globalAlpha = appear;
    drawSurface(ctx, W, H, t, wk);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  return {
    drawScene: drawScene,
    whaleState: whaleState,
    whaleTopY: whaleTopY,
    sceneInfo: sceneInfo,
    surfaceY: surfaceY,
    T: T,
    GEOM: {
      WHALE: WHALE, MOUTH: MOUTH, EYE: EYE, MOUTH_W: MOUTH_W,
      CX: WHALE_CX, CY: WHALE_CY, W: WHALE_W, X0: WHALE_X0,
      SURFACE_Y: SURFACE_Y, WHALE_Y: WHALE_Y,
      FILL: WHALE_FILL, PAPER: PAPER,
      WAVE: WAVE, waveOffset: waveOffset, waveSlope: waveSlope, deform: deform,
      setSampleDensity: setSampleDensity, samplePath: samplePath,
      pts: function () { return WHALE_PTS; }
    }
  };
});
