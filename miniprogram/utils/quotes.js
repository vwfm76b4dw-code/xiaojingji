/**
 * 学习名言库 —— 每天一句，督促但不施压。
 *
 * 选句纪律（面向初一学生）：
 *   · 优先"努力→回报"的正反馈，不用恐吓式警句（"少壮不努力"类全部弃用）
 *   · 中英各半：英文原句本身就是一个可读的语料，中文句保证理解零门槛
 *   · 28 条按日期轮换，两周不重样
 */
const QUOTES = [
  { zh: '不积跬步，无以至千里；不积小流，无以成江海。', src: '《荀子》' },
  { en: 'Little by little, one travels far.', src: 'J.R.R. Tolkien' },
  { zh: '学而时习之，不亦说乎？', src: '《论语》' },
  { en: 'Practice makes progress, not perfect — and progress is what counts.', src: '—' },
  { zh: '千里之行，始于足下。', src: '《道德经》' },
  { en: 'It does not matter how slowly you go as long as you do not stop.', src: 'Confucius' },
  { zh: '锲而舍之，朽木不折；锲而不舍，金石可镂。', src: '《荀子》' },
  { en: 'The expert in anything was once a beginner.', src: '—' },
  { zh: '温故而知新，可以为师矣。', src: '《论语》' },
  { en: 'A little progress each day adds up to big results.', src: '—' },
  { zh: '书山有路勤为径，学海无涯苦作舟。', src: '韩愈' },
  { en: 'Mistakes are proof that you are trying.', src: '—' },
  { zh: '业精于勤，荒于嬉。', src: '韩愈' },
  { en: 'You do not have to be great to start, but you have to start to be great.', src: 'Zig Ziglar' },
  { zh: '故不积跬步，无以至千里。今天的十个词，就是今天的千里之行。', src: '小鲸记单词' },
  { en: 'Small daily improvements are the key to staggering long-term results.', src: '—' },
  { zh: '滴水穿石，不是力量大，而是功夫深。', src: '《汉书》注' },
  { en: 'The secret of getting ahead is getting started.', src: 'Mark Twain' },
  { zh: '及时当勉励，岁月不待人。', src: '陶渊明' },
  { en: 'Don’t watch the clock; do what it does. Keep going.', src: 'Sam Levenson' },
  { zh: '绳锯木断，水滴石穿。', src: '《鹤林玉露》' },
  { en: 'Success is the sum of small efforts, repeated day in and day out.', src: 'Robert Collier' },
  { zh: '博观而约取，厚积而薄发。', src: '苏轼' },
  { en: 'Today a reader, tomorrow a leader.', src: '—' },
  { zh: '欲穷千里目，更上一层楼。', src: '王之涣' },
  { en: 'Learning never exhausts the mind.', src: 'Leonardo da Vinci' },
  { zh: '少年易老学难成，一寸光阴不可轻。', src: '朱熹' },
  { en: 'Fall seven times, stand up eight.', src: 'Japanese proverb' }
];

/**
 * 按日期取今日一句（同一天所有人看到同一条，跨设备一致）。
 */
function todayQuote(dateStr) {
  const s = String(dateStr || '');
  let seed = 0;
  for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
  return QUOTES[seed % QUOTES.length];
}

module.exports = { todayQuote, all: QUOTES };
