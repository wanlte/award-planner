/**
 * 接口冒烟测试：跑通「创建 → 勾选子项 → 数值进度 → 结算入账 → 撤销 → 删除」全链路。
 * 用法：node test/smoke.mjs   （需先 npm start，或设置 BASE_URL）
 */
const BASE = process.env.BASE_URL || 'http://localhost:3210';

let passed = 0;
let failed = 0;
const pending = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

async function call(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function plusHours(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString();
}

async function main() {
  console.log(`smoke: ${BASE}`);

  const initial = await call('/state');
  check('GET /state 200', initial.status === 200, initial.status);
  check('初始有 goal 字段', Boolean(initial.data?.goal?.name));

  // 创建任务：困难，带清单 + 数值目标
  const created = await call('/tasks', 'POST', {
    title: '冒烟测试任务',
    content: '验证全链路',
    startAt: plusHours(0),
    endAt: plusHours(4),
    difficulty: 'hard',
    reward: 45,
    metrics: {
      description: '清单全部勾完并且进度到 10',
      checklist: [{ text: '第一步' }, { text: '第二步' }, { text: '第三步' }],
      numeric: { enabled: true, target: 10, current: 0, unit: '题' },
    },
  });
  check('POST /tasks 201', created.status === 201, created.status);
  const task = created.data?.task;
  check('返回任务 id', Boolean(task?.id));
  check('子项自动生成 id', task?.metrics?.checklist.every((i) => i.id));
  check('初始 earned 为 0', created.data?.snapshot?.goal?.earned === 0);
  pending.push(task?.id);

  // 金额只挡非正数，60 这种大额可以自己填
  const badReward = await call('/tasks', 'POST', {
    title: '非法金额', startAt: plusHours(0), endAt: plusHours(1), difficulty: 'easy', reward: 0,
  });
  check('奖励 0 被拒绝', badReward.status === 400 && /大于 0/.test(badReward.data?.error || ''), badReward.status);

  const bigReward = await call('/tasks', 'POST', {
    title: '大额任务', startAt: plusHours(0), endAt: plusHours(1), difficulty: 'hard', reward: 60,
  });
  check('奖励 60 可以创建', bigReward.status === 201, bigReward.status);
  if (bigReward.data?.task?.id) await call(`/tasks/${bigReward.data.task.id}`, 'DELETE');

  // 非法时间段
  const badTime = await call('/tasks', 'POST', {
    title: '非法时间', startAt: plusHours(5), endAt: plusHours(1), difficulty: 'easy', reward: 15,
  });
  check('结束早于开始被拒绝', badTime.status === 400, badTime.status);

  // 勾选全部子项
  let snapshot = created.data.snapshot;
  for (const item of task.metrics.checklist) {
    const res = await call(`/tasks/${task.id}/checklist/${item.id}`, 'PATCH', { done: true });
    check(`勾选「${item.text}」`, res.status === 200, res.status);
    snapshot = res.data?.snapshot;
  }
  const afterToggle = snapshot?.tasks.find((t) => t.id === task.id);
  check('清单进度 3/3', afterToggle?.metrics?.checklistDone === 3);
  check('状态自动变 doing', afterToggle?.status === 'doing');

  // 数值进度
  const numeric = await call(`/tasks/${task.id}/numeric`, 'PATCH', { current: 10 });
  const afterNumeric = numeric.data?.snapshot?.tasks.find((t) => t.id === task.id);
  check('数值进度 10/10', afterNumeric?.metrics?.numeric?.current === 10);
  check('指标达成标记 achieved', afterNumeric?.derived?.achieved === true);

  // 结算，实拿 45
  const settled = await call(`/tasks/${task.id}/settle`, 'POST', { actualReward: 45 });
  check('结算 200', settled.status === 200, settled.status);
  check('任务变 done', settled.data?.task?.status === 'done');
  check('累计入账 45', settled.data?.snapshot?.goal?.earned === 45, settled.data?.snapshot?.goal?.earned);

  // 修改目标 → 百分比联动
  const goalId = initial.data?.goal?.id;
  const goal = await call(`/goals/${goalId}`, 'PATCH', { name: '冒烟目标', target: 200 });
  check('目标改名成功', goal.data?.snapshot?.goal?.name === '冒烟目标');
  check('进度 22.5%', goal.data?.snapshot?.goal?.percent === 22.5, goal.data?.snapshot?.goal?.percent);

  // 不能重复结算
  const settleAgain = await call(`/tasks/${task.id}/settle`, 'POST', { actualReward: 45 });
  check('重复结算被拒绝', settleAgain.status === 400, settleAgain.status);

  // 撤销完成
  const reopened = await call(`/tasks/${task.id}/reopen`, 'POST', {});
  check('撤销后状态 doing', reopened.data?.snapshot?.tasks.find((t) => t.id === task.id)?.status === 'doing');
  check('撤销后入账 0', reopened.data?.snapshot?.goal?.earned === 0, reopened.data?.snapshot?.goal?.earned);

  // 部分完成时的计划额统计
  check('计划总额 45', reopened.data?.snapshot?.stats?.plannedTotal === 45, reopened.data?.snapshot?.stats?.plannedTotal);

  // 删除
  for (const id of pending) {
    if (!id) continue;
    const del = await call(`/tasks/${id}`, 'DELETE');
    check('删除任务 200', del.status === 200, del.status);
  }
  const final = await call('/state');
  check('任务清空', final.data?.tasks?.length === 0, final.data?.tasks?.length);

  // 还原目标
  await call('/goal', 'PATCH', { name: '旅行基金', target: 1000, note: '' });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
