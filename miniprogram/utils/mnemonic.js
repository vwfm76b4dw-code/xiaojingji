/**
 * 静态记忆技巧库（契约 §2.5）：tipFor(word) => {text, source}|null。
 *
 * 位置：词条自带 mnemonic → short-hooks 短版 → 本模块兜底 → 都没有就不渲染。
 * 服务对象：用户手录的词 + 初中 7 册教材约 4500 个无钩子的词（24 册 5740 词实测）。
 *
 * 内容：(a) docs/增长机制研究与文案库.md §3.2 的 19 条未用记忆法（#20 lantern 已入教材数据）；
 *       (b) 四类模式兜底：音译词 / 复合词 / -tion / -er。
 * 纪律：钩子 ≤ 30 字、画面感；**禁止生僻部件记常用词**（lantern"tern=海燕"是反例）——
 *       模式表用白名单；拆不出可信含义就返回 null，宁缺勿滥。
 * 纯函数零 wx：门禁（tools/verify-keyboard.js）在 Node 里对 6000+ 词全量跑。
 */
'use strict';

/*---- (a) 19 条人工记忆法：word: [text, source] ----*/
var STATIC_RAW = {
  absent: ['ab（离开）+ sent（被送走）→ 人不在，缺席', '拆词'],
  adventure: ['ad（去）+ venture（冒险）→ 出门闯荡的历险', '拆词'],
  balloon: ['ball（球）+ oon → 松手就飘上天的大球', '拆词'],
  bamboo: ['bam-boo 两个音，像竹节一节一节往上长', '拟声'],
  biscuit: ['bis（两次）+ cuit（烤）→ 烤了两遍的脆饼', '词源'],
  breathe: ['breath 是一口气，末尾加个 e 就是「呼吸」', '形近'],
  challenge: ['chal（喊）+ lenge → 有人喊你上场比一比', '拆词'],
  chemistry: ['chem（炼金）+ istry（学问）→ 化学像现代炼金术', '词缀'],
  cucumber: ['cu-cum-ber 三节，像黄瓜皮上的纹路', '拟声'],
  dolphin: ['里面藏着 doll（玩偶）→ 海豚像会跳的玩偶', '画面'],
  dumpling: ['dump（丢）+ ling（小）→ 把馅「丢」进小面皮', '拆词'],
  eraser: ['erase（擦掉）+ er（工具）→ 专门擦的东西', '词缀'],
  fantastic: ['fantasy（幻想）+ tic → 好得像做梦', '词缀'],
  firework: ['fire（火）+ work（作品）→ 火做成的作品', '复合'],
  geography: ['geo（地）+ graphy（画）→ 把地球画下来的学问', '词缀'],
  harmony: ['harmon（和声）+ y → 声音合在一起才好听', '词缀'],
  husband: ['hus（房子）+ band（绑）→ 旧时守在房子里当家的人', '词源'],
  rainforest: ['rain（雨）+ forest（森林）→ 天天下雨的林子', '复合'],
  sunflower: ['sun（太阳）+ flower（花）→ 追着太阳转的花', '复合']
};

/*---- (b-1) 音译词：中文词就是它音译来的，联想零损耗 ----*/
var LOAN_RAW = {
  coffee: ['发音就是「咖啡」—— 中文词就是它音译来的', '音译'],
  sofa: ['发音就是「沙发」—— 念一遍想想瘫上去的感觉', '音译'],
  salad: ['发音就是「沙拉」—— 生菜拌出来的冷盘', '音译'],
  hamburger: ['发音就是「汉堡」—— 夹肉面包来自汉堡市', '音译'],
  cola: ['发音就是「可乐」—— 念出来就是它的名字', '音译'],
  mango: ['发音就是「芒果」—— 念一遍就记住', '音译'],
  lemon: ['发音就是「柠檬」—— 酸得眯眼的黄果子', '音译'],
  cartoon: ['发音就是「卡通」—— 动画片就是它', '音译'],
  guitar: ['音译成「吉他」，六根弦一拨就响', '音译'],
  tofu: ['它本来就是「豆腐」传出去的词，发音和中文几乎一样', '音译'],
  'kung fu': ['发音就是「功夫」—— 中国武术的英文名', '音译'],
  typhoon: ['发音就是「台风」—— 从中文传出去的词', '音译'],
  bus: ['音译「巴士」—— 一车装很多人的公共汽车', '音译'],
  'ping-pong': ['乒乓 —— 拟声词：小球在桌上「乒、乓」两声', '音译']
};

/*---- (b-2a) 高频复合词人工版：组合含义比模板更有画面 ----*/
var COMPOUND_RAW = {
  classroom: ['class（班级）+ room（房间）→ 上课的教室', '复合'],
  bedroom: ['bed（床）+ room（房间）→ 放床的房间', '复合'],
  notebook: ['note（笔记）+ book（本子）→ 记笔记的本子', '复合'],
  football: ['foot（脚）+ ball（球）→ 用脚踢的球', '复合'],
  homework: ['home（家）+ work（功课）→ 带回家做的功课', '复合'],
  weekend: ['week（周）+ end（末尾）→ 一周的末尾', '复合'],
  birthday: ['birth（出生）+ day（日子）→ 出生的日子', '复合'],
  sometimes: ['some（某）+ times（次）→ 某些时候', '复合'],
  afternoon: ['after（之后）+ noon（中午）→ 中午过后', '复合'],
  blackboard: ['black（黑）+ board（板）→ 老师写字的黑板', '复合'],
  playground: ['play（玩）+ ground（场地）→ 下课玩耍的场地', '复合'],
  newspaper: ['news（新闻）+ paper（纸）→ 印着新闻的纸', '复合'],
  supermarket: ['super（超级）+ market（市场）→ 什么都有的大卖场', '复合'],
  headmaster: ['head（头儿）+ master（能手）→ 一校之长', '复合'],
  classmate: ['class（班级）+ mate（伙伴）→ 同班同学', '复合'],
  timetable: ['time（时间）+ table（表格）→ 写满时间的表：课程表', '复合'],
  headache: ['head（头）+ ache（疼）→ 头疼', '复合'],
  grandmother: ['grand（隔一辈）+ mother（妈妈）→ 奶奶或外婆', '复合'],
  grandfather: ['grand（隔一辈）+ father（爸爸）→ 爷爷或外公', '复合'],
  headteacher: ['head（头儿）+ teacher（老师）→ 老师们的头儿：校长', '复合']
};

/*---- (b-2b) 复合词部件白名单：两边都认识才拼 ----
 * 前 41 个是 24 册语料命中所必需；后面是初中生常写词的常用部件。
 * 不收：ship（friendship 的 -ship 是后缀，与"轮船"无关）。 */
var PARTS_RAW = 'ache疼,after之后,bag包,bed床,boat小船,body身体,book本子,cake蛋糕,coat外套,' +
  'cup杯子,day日子,every每,fire火,flower花,hand手,house房子,ice冰,land陆地,light光,' +
  'man男人,melon瓜,moon月亮,one一,over越过,police警察,post邮寄,rain雨,school学校,shop商店,' +
  'side边,snow雪,some某,stomach胃,sun太阳,tea茶,thing东西,time时间,tooth牙齿,water水,' +
  'week周,work工作,' +
  'home家,room房间,class班级,mate伙伴,foot脚,ball球,note笔记,birth出生,noon中午,night夜,' +
  'play玩,ground场地,news新闻,paper纸,market市场,super超级,black黑,board板,end末尾,' +
  'shine照耀,come来,fall落下,store店铺,door门,star星,wind风,tree树,friend朋友,girl女孩,boy男孩';

/*---- (b-3) -tion 词干：只覆盖三种可验证变形（stem+ion / +ation / 去e+ion）----*/
var TION_RAW = 'act行动,direct指导,inform告知,invent发明,educate教育,pollute污染,' +
  'celebrate庆祝,invite邀请,collect收集,suggest建议,communicate交流,populate居住,' +
  'describe描述,connect连接,protect保护,graduate毕业,introduce介绍,congratulate祝贺';

/* 个别词通用句式会失真，逐词改写（populate"居住"→人口） */
var TION_OVERRIDE = { population: '住在一个地方的人：人口' };

/*---- (b-4) -er 词干：只收加 er 不变形的动词（runner/winner 双写形态宁缺勿滥）----*/
var ER_RAW = 'teach教,work工作,play玩,sing唱歌,drive驾驶,write写,read读,farm耕种,' +
  'clean打扫,report报道,speak说,jump跳,help帮助,learn学习,paint画,own拥有,' +
  'dance跳舞,skate滑冰,ski滑雪,garden园艺,manage管理,train训练,keep看守';

/* 形似复合、实义不合（handsome 的 some 是后缀不是"某"） */
var COMPOUND_EXCLUDE = { handsome: 1 };

/*------------------------- 查询逻辑 -------------------------*/

/** [text, source] → 契约的 {text, source} */
function wrap(raw) {
  var out = {};
  for (var k in raw) out[k] = { text: raw[k][0], source: raw[k][1] };
  return out;
}

/** 'word义,word2义2' → {word: 义}（数据表用 CSV 存，比对象字面量省一半字节） */
function parse(s) {
  var out = {};
  s.split(',').forEach(function (pair) {
    var m = pair.match(/^([a-z-]+)([\u4e00-\u9fa5（）·]+)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

var STATIC_TIPS = wrap(STATIC_RAW);
var LOAN_TIPS = wrap(LOAN_RAW);
var COMPOUND_TIPS = wrap(COMPOUND_RAW);
var COMPOUND_PARTS = parse(PARTS_RAW);
var TION_STEMS = parse(TION_RAW);
var ER_VERBS = parse(ER_RAW);

/** 归一化：小写；race（v.）之类脏词形取打头拉丁段（括注不参与匹配） */
function normalize(word) {
  if (word == null) return null;
  var w = String(word).toLowerCase().replace(/^\s+|\s+$/g, '');
  if (!w) return null;
  var m = w.match(/[a-z][a-z -]*/);
  return m ? m[0].replace(/[ -]+$/, '') : null;
}

/** 复合词通用匹配：head+tail（各 ≥3 字母）都在部件表里才拼 */
function compoundGeneric(w) {
  if (w.length < 6 || /[ -]/.test(w) || COMPOUND_EXCLUDE[w]) return null;
  for (var i = 3; i <= w.length - 3; i++) {
    var h = w.slice(0, i), t = w.slice(i);
    if (COMPOUND_PARTS[h] && COMPOUND_PARTS[t]) {
      return { text: h + '（' + COMPOUND_PARTS[h] + '）+ ' + t + '（' + COMPOUND_PARTS[t] +
        '）→ 字面拼起来就是它的意思', source: '复合' };
    }
  }
  return null;
}

function tionTip(w) {
  if (w.slice(-4) !== 'tion') return null;
  for (var stem in TION_STEMS) {
    var b = stem.replace(/e$/, '');
    if (w === stem + 'ion' || w === stem + 'ation' || w === b + 'ion' || w === b + 'ation') {
      return { text: stem + '（' + TION_STEMS[stem] + '）+ tion → ' +
        (TION_OVERRIDE[w] || '「' + TION_STEMS[stem] + '」这件事'), source: '词缀' };
    }
  }
  return null;
}

function erTip(w) {
  if (w.length < 5 || w.slice(-2) !== 'er') return null;
  var stem = w.slice(0, -2);
  return ER_VERBS[stem]
    ? { text: stem + '（' + ER_VERBS[stem] + '）+ er → 做「' + ER_VERBS[stem] + '」的人', source: '词缀' }
    : null;
}

/**
 * 契约入口。查找顺序 = 可信度降序：
 * 人工 19 条 → 音译 → 人工复合词 → 复合通用 → -tion → -er → null。
 * 复数先剥 s 走模式；人工表在剥 s 前查（否则 sometimes 被剥成 sometime 走通用模板）。
 */
function tipFor(word) {
  var w = normalize(word);
  if (!w) return null;
  if (STATIC_TIPS[w]) return STATIC_TIPS[w];
  if (LOAN_TIPS[w]) return LOAN_TIPS[w];
  if (COMPOUND_TIPS[w]) return COMPOUND_TIPS[w];

  var base = (w.length > 3 && w.slice(-1) === 's') ? w.slice(0, -1) : w;
  if (base !== w) {
    if (STATIC_TIPS[base]) return STATIC_TIPS[base];
    if (COMPOUND_TIPS[base]) return COMPOUND_TIPS[base];
  }
  return compoundGeneric(base) || tionTip(base) || erTip(base) || null;
}

/* 模式表一并导出：门禁要断言"部件全部是常见词"（生僻部件防线的可测化） */
module.exports = {
  tipFor: tipFor,
  STATIC_TIPS: STATIC_TIPS, LOAN_TIPS: LOAN_TIPS, COMPOUND_TIPS: COMPOUND_TIPS,
  COMPOUND_PARTS: COMPOUND_PARTS, TION_STEMS: TION_STEMS, ER_VERBS: ER_VERBS
};
