/**
 * SM-2 算法验证脚本
 * 目的：在写进小程序之前，先证明算法行为符合预期
 * 运行：node verify-sm2.js
 */

function sm2(item, q) {
  let ef = item.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;

  let reps = item.reps;
  let interval = item.interval;

  if (q < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps = reps + 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }

  return {
    ...item,
    ef: Math.round(ef * 100) / 100,
    reps,
    interval
  };
}

// ============ 测试 ============
const RECOGNIZE = 5, VAGUE = 3, FORGOT = 1;

console.log('='.repeat(62));
console.log('测试 1：连续"认识"3 次以上，观察间隔递增');
console.log('='.repeat(62));
let it = { ef: 2.5, reps: 0, interval: 0 };
console.log(`初始          EF=${it.ef}  reps=${it.reps}  interval=${it.interval}`);
for (let i = 1; i <= 5; i++) {
  it = sm2(it, RECOGNIZE);
  console.log(`第${i}次认识   EF=${it.ef}  reps=${it.reps}  interval=${it.interval}`);
}

console.log();
console.log('='.repeat(62));
console.log('测试 2：递增中途点"不认识"，观察是否重置');
console.log('='.repeat(62));
it = sm2(it, FORGOT);
console.log(`点不认识      EF=${it.ef}  reps=${it.reps}  interval=${it.interval}`);

console.log();
console.log('='.repeat(62));
console.log('测试 3：点"模糊"应让 EF 下降');
console.log('='.repeat(62));
let it2 = { ef: 2.5, reps: 2, interval: 6 };
console.log(`模糊前        EF=${it2.ef}  interval=${it2.interval}`);
it2 = sm2(it2, VAGUE);
console.log(`模糊后        EF=${it2.ef}  interval=${it2.interval}  (EF 应下降)`);

console.log();
console.log('='.repeat(62));
console.log('测试 4：连续"不认识"10 次，EF 不得低于 1.3');
console.log('='.repeat(62));
let it3 = { ef: 2.5, reps: 0, interval: 0 };
for (let i = 0; i < 10; i++) it3 = sm2(it3, FORGOT);
console.log(`连续10次不认识 → EF=${it3.ef}  (必须 >= 1.3)`);

console.log();
console.log('='.repeat(62));
console.log('判定');
console.log('='.repeat(62));
let pass = true;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) pass = false;
};

let t = { ef: 2.5, reps: 0, interval: 0 };
const seq = [];
for (let i = 0; i < 4; i++) { t = sm2(t, RECOGNIZE); seq.push(t.interval); }
check('连续认识间隔为 1 → 6 → 递增 → 递增', seq[0] === 1 && seq[1] === 6 && seq[2] > seq[1] && seq[3] > seq[2]);
check('第3次间隔约为 17 (round(6*2.8))', seq[2] === 17);

let t2 = sm2(t, FORGOT);
check('答错后 interval 重置为 1', t2.interval === 1);
check('答错后 reps 归零', t2.reps === 0);

let t3 = { ef: 2.5, reps: 0, interval: 0 };
for (let i = 0; i < 10; i++) t3 = sm2(t3, FORGOT);
check('连续答错 EF 不低于 1.3', t3.ef >= 1.3);

console.log();
console.log(pass ? '>>> 全部通过，算法可用于实现' : '>>> 存在失败项，需修正');
