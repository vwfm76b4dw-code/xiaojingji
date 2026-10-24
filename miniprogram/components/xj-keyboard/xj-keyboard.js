/**
 * 小鲸自带键盘 —— 26 键 QWERTY + 联想条 + 语音（契约 §2.3）。
 *
 * ## 为什么用 view 模拟输入而不是 <input disabled>
 * disabled 输入框在部分机型上点击仍会拉起系统键盘，"禁用系统输入法"就落空了；
 * 且 disabled 灰态传达的是"这里不可用"，对学生是错误信号。代价是焦点/光标要自己管，
 * 换来的是输入行为完全受控 —— 值得。
 *
 * ## 为什么组件只做纯 UI
 * 联想候选由页面传入（页面用 cards.js 的当前词表做前缀匹配），
 * 语音按下/松开抛给页面（页面走 utils/asr.js）—— 组件不知道词库和云服务长什么样，
 * 换个页面就能换个联想来源。所有可测逻辑在 keyboard-core.js（纯函数，门禁可跑）。
 *
 * ## 值的所有权
 * properties.value 是页面的事实源；组件内维护 _val 镜像做增量拼接 ——
 * 为什么不直接读 property：连打两个键时页面的 setData 可能还没回流，
 * 读 property 会丢第二个键（异步窗口竞态）。镜像 + observer 对账是双保险。
 */
var core = require('./keyboard-core.js');

Component({
  properties: {
    mode: { type: String, value: 'word' },        // letters：纯键盘（无联想/空格）；word：单词录入全套
    value: {
      type: String, value: '',
      observer: function (v) {
        // 页面侧改值（语音填入/清空/程序赋值）时同步镜像；打字回流的相同值跳过
        if (v !== this._val) {
          this._val = v || '';
          this._syncShift();
        }
      }
    },
    placeholder: { type: String, value: '' },
    suggestions: { type: Array, value: [] },      // 调用方过滤好的候选（≤5 条），组件不二次过滤
    voiceEnabled: { type: Boolean, value: false },// asr 不可用时页面传 false → 置灰 + toast
    autoCapitalize: { type: Boolean, value: false } // 句首大写（可选能力）：默认关 —— 词库词条以小写为规范形，
                                                    // 自动大写会让存进去的词和教材对不上；需要时页面自己开
  },

  data: {
    rows: core.buildRows(),
    shift: 'off'
  },

  lifetimes: {
    attached: function () {
      this._val = this.data.value || '';
      this._syncShift();
    },
    detached: function () {
      // 连删定时器不清理会带着 this 活到页面销毁后，下一拍 deleteOne 就是在操作死组件
      this._stopRepeat();
    }
  },

  methods: {
    /*------------------------- 内部 -------------------------*/

    _emit: function (name, value) {
      this.triggerEvent(name, { value: value });
    },

    _vibrate: function () {
      // type:'light' 是契约定值；老基础库没有这个 API 或不认 type，静默跳过
      try {
        if (typeof wx !== 'undefined' && typeof wx.vibrateShort === 'function') {
          wx.vibrateShort({ type: 'light' });
        }
      } catch (e) { /* 震动失败不该打断打字 */ }
    },

    /** 句首大写预备位：值清空且开启 autoCapitalize 时回 auto；否则 auto 用掉一次后归 off */
    _syncShift: function () {
      var want;
      if (this.data.autoCapitalize && this.data.mode === 'word' && !(this._val && this._val.length)) {
        want = 'auto';
      } else {
        want = this.data.shift === 'auto' ? 'off' : this.data.shift;
      }
      if (want !== this.data.shift) this.setData({ shift: want });
    },

    _deleteOne: function () {
      if (!this._val || !this._val.length) return;
      this._val = this._val.slice(0, this._val.length - 1);
      this._syncShift();               // 可能删空 → 回到句首大写预备位
      this._emit('input', this._val);
    },

    _stopRepeat: function () {
      if (this._bsTimer) { clearInterval(this._bsTimer); this._bsTimer = null; }
      if (this._bs) { this._bs.release(); }
    },

    /*------------------------- 键面事件（一律 catch：不让触摸落到页面，
       否则录入页"点表单空白关键盘"的逻辑会把正在打的字打断） -------------------------*/

    onKey: function (e) {
      var ch = e.currentTarget.dataset.ch;
      if (!ch) return;
      this._vibrate();
      var shift = this.data.shift;
      this._val = (this._val || '') + core.charFor(ch, shift);
      if (shift !== 'off') this.setData({ shift: 'off' });   // 单发大写：用掉一次即回位
      this._emit('input', this._val);
    },

    onShift: function () {
      this._vibrate();
      this.setData({ shift: core.shiftAfterTap(this.data.shift) });
    },

    onSpace: function () {
      if (this.data.mode !== 'word') return;   // letters 模式不渲染空格键，这里防御
      this._vibrate();
      this._val = (this._val || '') + ' ';     // 词库里有词组（red scarf / in fact），空格承重
      this._emit('input', this._val);
    },

    onBsStart: function () {
      this._vibrate();
      this._stopRepeat();
      this._bs = core.createBackspace();
      this._bs.press(Date.now());
      this._deleteOne();                        // 按下立即删一个，不等 300ms
      var self = this;
      // 30ms 轮询问状态机"这一拍删不删"：连删间隔在加速，轮询让节奏完全由状态机决定
      this._bsTimer = setInterval(function () {
        if (self._bs.tick(Date.now()) > 0) self._deleteOne();
      }, 30);
    },

    onBsEnd: function () {
      this._stopRepeat();
    },

    onSuggestion: function (e) {
      var v = e.currentTarget.dataset.v;
      if (!v) return;
      this._vibrate();
      this._val = v;
      this._syncShift();
      // 只发 suggestion 不发 input：契约里这是两个语义（候选命中 vs 逐键输入），
      // 页面接哪个听哪个，避免同一笔输入触发两轮处理
      this.triggerEvent('suggestion', { value: v });
    },

    onSubmit: function () {
      this._vibrate();
      this.triggerEvent('submit', { value: this._val || '' });
    },

    /*------------------------- 语音（按住说，松手出结果） -------------------------*/

    onVoiceStart: function () {
      if (!this.data.voiceEnabled) {
        // 契约：不可用时置灰 + toast。置灰是样式，这句 toast 是组件内的兜底解释 ——
        // 不发给页面（voiceEnabled=false 时页面通常也没有录音路径可走）
        try { wx.showToast({ title: '语音输入暂不可用', icon: 'none' }); } catch (e) { /* 忽略 */ }
        return;
      }
      this._voiceOn = true;
      this.triggerEvent('voice', { start: true });
    },

    onVoiceEnd: function () {
      // touchend/touchcancel 都会来，且可能没配对 start：用 _voiceOn 挡掉孤儿的 stop
      if (!this._voiceOn) return;
      this._voiceOn = false;
      this.triggerEvent('voice', { start: false });
    },

    /** 键盘空白区（内边距）的兜底吞 tap：组件根节点不接也会冒泡到页面上误触"关闭键盘" */
    noop: function () { }
  }
});
