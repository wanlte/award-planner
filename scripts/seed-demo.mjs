/**
 * 灌入示例任务，方便第一次打开时看到完整效果。
 * 用法：node scripts/seed-demo.mjs   （已有任务时不会重复灌入）
 */
const BASE = process.env.BASE_URL || 'http://localhost:3210';

async function call(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || res.status);
  return data;
}

const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const demoTasks = [
  {
    title: '刷完 30 道算法题 + 错题复盘',
    content: '按专题刷「数组 / 双指针 / 二分」，每道题先自己想 15 分钟再看题解。',
    startAt: hoursFromNow(-2),
    endAt: hoursFromNow(6),
    difficulty: 'hard',
    reward: 45,
    metrics: {
      description: '30 道全部有思路 + 错题写进复盘笔记',
      checklist: [
        { text: '看完三个专题的模板', done: true },
        { text: '刷完 30 道并记录用时', done: false },
        { text: '错题归档到笔记', done: false },
      ],
      numeric: { enabled: true, target: 30, current: 12, unit: '题' },
    },
  },
  {
    title: '数学建模论文初稿',
    content: '把模型的假设、求解和结果分析先写成能读通的版本，不求完美。',
    startAt: hoursFromNow(1),
    endAt: hoursFromNow(50),
    difficulty: 'medium',
    reward: 30,
    metrics: {
      description: '初稿五个章节全部写完',
      checklist: [
        { text: '问题重述 + 模型假设', done: true },
        { text: '符号说明与模型建立', done: false },
        { text: '求解过程与灵敏度分析', done: false },
      ],
      numeric: { enabled: true, target: 5, current: 2, unit: '章' },
    },
  },
  {
    title: '整理本周错题进 Anki',
    content: '把纸质错题拍照转文字，做成 20 张卡片。',
    startAt: hoursFromNow(-26),
    endAt: hoursFromNow(-20),
    difficulty: 'easy',
    reward: 15,
    metrics: {
      description: '20 张卡片导入完成',
      checklist: [],
      numeric: { enabled: false, target: 0, current: 0, unit: '' },
    },
    done: true,
  },
  {
    title: '最优化理论第三章作业',
    content: 'KKT 条件的推导题全部手推一遍。',
    startAt: hoursFromNow(-8),
    endAt: hoursFromNow(-4),
    difficulty: 'hard',
    reward: 45,
    metrics: {
      description: '6 道题全部手推完成',
      checklist: [],
      numeric: { enabled: false, target: 0, current: 0, unit: '' },
    },
    done: true,
  },
];

async function main() {
  const state = await call('/state');
  if (state.tasks.length > 0) {
    console.log(`已有 ${state.tasks.length} 条任务，跳过示例灌入。`);
    return;
  }

  await call(`/goals/${state.goal.id}`, 'PATCH', { name: '旅行基金', target: 500, note: '寒假去大理' });

  for (const item of demoTasks) {
    const created = await call('/tasks', 'POST', item);
    const task = created.task;
    if (item.metrics.checklist.length) {
      for (const ck of item.metrics.checklist.filter((i) => i.done)) {
        const inDb = task.metrics.checklist.find((i) => i.text === ck.text);
        if (inDb) await call(`/tasks/${task.id}/checklist/${inDb.id}`, 'PATCH', { done: true });
      }
    }
    if (item.done) {
      await call(`/tasks/${task.id}/settle`, 'POST', { actualReward: item.reward });
    }
    console.log(`已创建：${item.title}`);
  }

  const final = await call('/state');
  console.log(`完成，共 ${final.tasks.length} 条任务，已入账 ¥${final.goal.earned} / ¥${final.goal.target}`);
}

main().catch((err) => {
  console.error('灌入示例失败:', err.message);
  process.exit(1);
});
