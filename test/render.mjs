/**
 * 前端 DOM 级冒烟测试：用 jsdom 真正执行 public/app.js，
 * 覆盖「加载渲染 → 新建任务 → 勾指标 → 结算入账 → 删除」。
 * 用法：node test/render.mjs（需先 npm start）
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const BASE = process.env.BASE_URL || 'http://localhost:3210';
const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_TITLE = 'DOM 测试任务';
const SEED_TITLE = '占位任务';

let passed = 0;
let failed = 0;
const errors = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra !== '' ? ' -> ' + extra : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 5000, interval = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch { /* 等待期间忽略 */ }
    await sleep(interval);
  }
  return false;
}

async function apiCall(p, method = 'GET', body) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function localInput(hours) {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

async function cleanup() {
  const state = await apiCall('/state');
  const leftovers = (state.data?.tasks || []).filter((t) => t.title === TEST_TITLE);
  for (const task of leftovers) await apiCall(`/tasks/${task.id}`, 'DELETE');
  return leftovers.length;
}

async function main() {
  console.log(`render smoke: ${BASE}`);
  await cleanup();

  // 空库时先建一条占位任务：真实使用中列表总是有内容的，
  // 这样「页面加载后渲染出任务卡」这条断言在全新数据目录上也能成立
  let seedId = null;
  const initial = (await apiCall('/state')).data;
  if (!initial.tasks.length) {
    const created = await apiCall(`/tasks?goal=${encodeURIComponent(initial.goal.id)}`, 'POST', {
      title: SEED_TITLE,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600_000).toISOString(),
      difficulty: 'easy',
      reward: 10,
    });
    seedId = created.data?.task?.id ?? null;
    if (!seedId) throw new Error('占位任务创建失败，检查 POST /api/tasks');
  }

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  window.fetch = (input, init) => fetch(new URL(String(input), BASE).href, init);
  window.confirm = () => true;
  window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));

  try {
    window.eval(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
  } catch (err) {
    errors.push(err.stack || String(err));
  }

  const cards = () => document.querySelectorAll('.task-card');
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';

  const loaded = await waitFor(() => cards().length > 0);
  check('页面加载后渲染出任务卡', loaded, cards().length);
  check('前端执行无报错', errors.length === 0, errors.join(' | '));

  const state = (await apiCall('/state')).data;
  check('任务卡数量与接口一致', cards().length === state.tasks.length, `${cards().length} vs ${state.tasks.length}`);
  check('累计入账显示正确', text('#earnedAmount') === String(state.goal.earned), text('#earnedAmount'));
  check('目标名称显示正确', text('#goalName') === state.goal.name, text('#goalName'));
  check('进度条宽度已设置', document.querySelector('#fundFill').style.width !== '', document.querySelector('#fundFill').style.width);
  check('统计·全部任务', text('#statTotal') === String(state.stats.total), text('#statTotal'));
  check('统计·已完成', text('#statDone') === String(state.stats.done), text('#statDone'));

  const hardCount = state.stats.difficultyCounts.hard;
  check('难度计数·困难', text('#countHard') === String(hardCount), `${text('#countHard')} vs ${hardCount}`);
  check('难度标签渲染', document.querySelectorAll('.level-chip').length === state.tasks.length);

  // 打开新建弹窗
  document.querySelector('#newTaskBtn').click();
  check('新建弹窗打开', !document.querySelector('#taskModal').hidden);
  check('默认难度为中等', document.querySelector('.level-option.is-selected')?.dataset.level === 'medium');
  check('默认金额跟随建议 40', document.querySelector('#fRewardNumber').value === '40', document.querySelector('#fRewardNumber').value);

  // 选难度 → 金额联动
  document.querySelector('.level-option[data-level="easy"]').click();
  check('切换容易后金额变 20', document.querySelector('#fRewardNumber').value === '20', document.querySelector('#fRewardNumber').value);

  // 金额可以自由填，不局限在建议区间里
  document.querySelector('#fRewardNumber').value = '88';
  document.querySelector('#fRewardNumber').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('金额可自由填写 88', document.querySelector('#fRewardNumber').value === '88');
  document.querySelector('#fRewardNumber').value = '150';
  document.querySelector('#fRewardNumber').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('超出滑杆范围时停在 100', document.querySelector('#fRewardRange').value === '100', document.querySelector('#fRewardRange').value);
  check('输入框仍保留 150', document.querySelector('#fRewardNumber').value === '150', document.querySelector('#fRewardNumber').value);
  document.querySelector('#fRewardNumber').value = '20';
  document.querySelector('#fRewardNumber').dispatchEvent(new window.Event('input', { bubbles: true }));

  // 填表单
  const inputs = {
    title: document.querySelector('#fTitle'),
    content: document.querySelector('#fContent'),
    desc: document.querySelector('#fMetricDesc'),
    start: document.querySelector('#fStart'),
    end: document.querySelector('#fEnd'),
    numericCurrent: document.querySelector('#fNumericCurrent'),
    numericTarget: document.querySelector('#fNumericTarget'),
    numericUnit: document.querySelector('#fNumericUnit'),
  };
  inputs.title.value = TEST_TITLE;
  inputs.content.value = '验证前端渲染与接口联动';
  inputs.desc.value = '勾完清单即达成';
  inputs.start.value = localInput(0);
  inputs.end.value = localInput(3);

  // 子项清单
  document.querySelector('#addChecklistBtn').click();
  document.querySelector('#addChecklistBtn').click();
  const ckInputs = document.querySelectorAll('#checklistEditor input[data-idx]');
  check('清单编辑器生成 2 行', ckInputs.length === 2, ckInputs.length);
  ckInputs.forEach((input, i) => {
    input.value = `子项 ${i + 1}`;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

  // 数值目标
  const toggle = document.querySelector('#fNumericEnabled');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('数值目标编辑器展开', !document.querySelector('#numericEditor').hidden);
  inputs.numericCurrent.value = '2';
  inputs.numericTarget.value = '5';
  inputs.numericUnit.value = '章';

  document.querySelector('#saveTaskBtn').click();
  const created = await waitFor(() => cards().length === state.tasks.length + 1);
  check('保存后新增任务卡', created, cards().length);
  check('弹窗已关闭', document.querySelector('#taskModal').hidden);

  const newCard = Array.from(cards()).find((card) => card.textContent.includes(TEST_TITLE));
  check('新任务卡包含标题', Boolean(newCard));
  check('新任务卡是容易档', newCard?.dataset.level === 'easy', newCard?.dataset.level);
  const numInput = newCard?.querySelector('input.num-inline');
  check('新任务卡渲染清单 2 项', newCard?.querySelectorAll('.ck').length === 2, newCard?.querySelectorAll('.ck').length);
  check('新任务卡显示数值进度', numInput?.value === '2' && newCard?.textContent.includes('/ 5章'), `${numInput?.value} | ${newCard?.textContent.includes('5章')}`);

  const newState = (await apiCall('/state')).data;
  const createdTask = newState.tasks.find((t) => t.title === TEST_TITLE);
  check('接口已写入清单 2 项', createdTask?.metrics?.checklist?.length === 2, createdTask?.metrics?.checklist?.length);
  check('接口已写入数值目标', createdTask?.metrics?.numeric?.target === 5, createdTask?.metrics?.numeric?.target);

  // 勾选清单第一项，检查进度更新
  const firstCk = newCard?.querySelector('.ck');
  firstCk?.click();
  await waitFor(async () => {
    const s = (await apiCall('/state')).data;
    return s.tasks.find((t) => t.title === TEST_TITLE)?.metrics?.checklist?.[0]?.done === true;
  });
  check('勾选第一项写入成功', (await apiCall('/state')).data.tasks.find((t) => t.title === TEST_TITLE).metrics.checklist[0].done === true);

  // 结算
  const earnedBefore = Number(text('#earnedAmount').replace(/,/g, ''));
  const freshCard = Array.from(cards()).find((card) => card.textContent.includes(TEST_TITLE));
  freshCard?.querySelector('.settle-btn')?.click();
  check('结算弹窗打开', !document.querySelector('#settleModal').hidden);
  check('结算金额预填计划值', document.querySelector('#settleAmount').value === '20', document.querySelector('#settleAmount').value);

  document.querySelector('#settleAmount').value = '12';
  document.querySelector('#confirmSettle').click();
  const settled = await waitFor(() => Number(text('#earnedAmount').replace(/,/g, '')) === earnedBefore + 12);
  check('结算后总额 +12', settled, text('#earnedAmount'));
  check('结算弹窗已关闭', document.querySelector('#settleModal').hidden);
  check('流水列表含新任务', document.querySelector('#ledgerList').textContent.includes(TEST_TITLE));
  check('金额可小于计划金额', (await apiCall('/state')).data.tasks.find((t) => t.title === TEST_TITLE).actualReward === 12);

  // 删除
  const doneCard = Array.from(cards()).find((card) => card.textContent.includes(TEST_TITLE));
  doneCard?.querySelector('[data-action="edit"]')?.click();
  check('删除按钮在编辑时可见', !document.querySelector('#deleteTaskBtn').hidden);
  document.querySelector('#deleteTaskBtn').click();
  const deleted = await waitFor(() => cards().length === state.tasks.length);
  check('删除后任务卡消失', deleted, cards().length);
  check('删除后总额回落到原值', Number(text('#earnedAmount').replace(/,/g, '')) === earnedBefore, text('#earnedAmount'));

  check('全程无未捕获错误', errors.length === 0, errors.join(' | '));

  if (seedId) await apiCall(`/tasks/${seedId}`, 'DELETE');

  const leftover = await cleanup();
  check('测试数据已清理', leftover === 0);

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  dom.window.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('渲染测试异常:', err);
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(1);
});
