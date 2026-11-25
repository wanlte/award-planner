const LEVELS = {
  easy: { label: '容易', suggested: 20, min: 10, max: 30, range: '¥10-30' },
  medium: { label: '中等', suggested: 40, min: 30, max: 50, range: '¥30-50' },
  hard: { label: '困难', suggested: 60, min: 50, max: 100000, range: '¥50 起' },
};

/** 金额随意填，只挡非正数和明显误填 */
const REWARD_FLOOR = 1;
const REWARD_CEIL = 100000;
const SLIDER_MAX = 100;

/** localStorage 在无痕模式 / 受限环境会抛错，这里统一兜底 */
const storage = {
  get(key) {
    try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* 忽略 */ }
  },
};

const app = {
  snapshot: null,
  filter: 'all',
  editingId: null,
  settlingId: null,
  checklist: [],
  level: 'medium',
  meId: storage.get('planner.me'),
  viewId: storage.get('planner.view'),
  goalId: storage.get('planner.goal'),
  goalEditingId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const els = {
  todayLabel: $('#todayLabel'),
  logoutBtn: $('#logoutBtn'),
  newTaskBtn: $('#newTaskBtn'),
  emptyNewBtn: $('#emptyNewBtn'),
  emptyState: $('#emptyState'),
  emptyTitle: $('#emptyTitle'),
  emptyDesc: $('#emptyDesc'),
  taskGrid: $('#taskGrid'),
  filters: $('#filters'),

  goalName: $('#goalName'),
  goalPill: $('#goalPill'),
  goalTarget: $('#goalTarget'),
  goalNote: $('#goalNote'),
  earnedAmount: $('#earnedAmount'),
  fundFill: $('#fundFill'),
  fundPercent: $('#fundPercent'),
  fundRemaining: $('#fundRemaining'),
  ledgerList: $('#ledgerList'),
  ledger7d: $('#ledger7d'),
  editGoalBtn: $('#editGoalBtn'),

  statTotal: $('#statTotal'),
  statDone: $('#statDone'),
  statActive: $('#statActive'),
  statOverdue: $('#statOverdue'),
  countHard: $('#countHard'),
  countMedium: $('#countMedium'),
  countEasy: $('#countEasy'),
  barHard: $('#barHard'),
  barMedium: $('#barMedium'),
  barEasy: $('#barEasy'),
  plannedTotal: $('#plannedTotal'),
  completionByAmount: $('#completionByAmount'),

  taskModal: $('#taskModal'),
  taskModalTitle: $('#taskModalTitle'),
  taskModalEyebrow: $('#taskModalEyebrow'),
  fTitle: $('#fTitle'),
  fContent: $('#fContent'),
  fStart: $('#fStart'),
  fEnd: $('#fEnd'),
  levelPicker: $('#levelPicker'),
  levelHint: $('#levelHint'),
  fRewardRange: $('#fRewardRange'),
  fRewardNumber: $('#fRewardNumber'),
  rewardHint: $('#rewardHint'),
  fMetricDesc: $('#fMetricDesc'),
  checklistEditor: $('#checklistEditor'),
  addChecklistBtn: $('#addChecklistBtn'),
  checklistHint: $('#checklistHint'),
  fNumericEnabled: $('#fNumericEnabled'),
  numericEditor: $('#numericEditor'),
  fNumericCurrent: $('#fNumericCurrent'),
  fNumericTarget: $('#fNumericTarget'),
  fNumericUnit: $('#fNumericUnit'),
  saveTaskBtn: $('#saveTaskBtn'),
  deleteTaskBtn: $('#deleteTaskBtn'),

  settleModal: $('#settleModal'),
  settleTaskTitle: $('#settleTaskTitle'),
  settleAmount: $('#settleAmount'),
  settleFull: $('#settleFull'),
  settleGoalName: $('#settleGoalName'),
  confirmSettle: $('#confirmSettle'),

  goalModal: $('#goalModal'),
  goalModalEyebrow: $('#goalModalEyebrow'),
  goalModalTitle: $('#goalModalTitle'),
  gName: $('#gName'),
  gTarget: $('#gTarget'),
  gNote: $('#gNote'),
  goalHint: $('#goalHint'),
  saveGoalBtn: $('#saveGoalBtn'),
  deleteGoalBtn: $('#deleteGoalBtn'),
  goalTabs: $('#goalTabs'),
  taskGoalName: $('#taskGoalName'),
  fabNewTask: $('#fabNewTask'),

  toast: $('#toast'),

  meSelect: $('#meSelect'),
  renameMeBtn: $('#renameMeBtn'),
  viewSwitch: $('#viewSwitch'),
  peerCard: $('#peerCard'),
  readonlyBanner: $('#readonlyBanner'),
  readonlyName: $('#readonlyName'),
};

/* ---------------- 工具函数 ---------------- */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const numFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const money = (n) => numFmt.format(Number(n) || 0);
const pad = (n) => String(n).padStart(2, '0');

function fmtRange(startAt, endAt) {
  if (!startAt || !endAt) return '未设置时间段';
  const s = new Date(startAt);
  const e = new Date(endAt);
  const sameDay = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  const left = `${s.getMonth() + 1}月${s.getDate()}日 ${pad(s.getHours())}:${pad(s.getMinutes())}`;
  const right = sameDay
    ? `${pad(e.getHours())}:${pad(e.getMinutes())}`
    : `${e.getMonth() + 1}月${e.getDate()}日 ${pad(e.getHours())}:${pad(e.getMinutes())}`;
  return `${left} → ${right}`;
}

function toInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function weekdayLabel(date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
}

async function api(path, method = 'GET', body) {
  let url = `/api${path}`;
  if (app.meId && !path.includes('user=')) {
    url += (url.includes('?') ? '&' : '?') + `user=${encodeURIComponent(app.meId)}`;
  }
  if (app.goalId && !path.includes('goal=')) {
    url += (url.includes('?') ? '&' : '?') + `goal=${encodeURIComponent(app.goalId)}`;
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) {
    // 登录状态失效（过期或密码被换过），回登录页重新输入
    window.location.replace('/login');
    throw new Error('登录状态已失效，请重新登录');
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch { /* 网络断了也照常跳转 */ }
  window.location.replace('/login');
}

let toastTimer = null;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', Boolean(isError));
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-show');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 2600);
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  app.snapshot = snapshot;
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  const data = app.snapshot;
  if (!data) return;
  const canEdit = Boolean(data.meta?.canEdit);
  els.newTaskBtn.hidden = !canEdit;
  els.fabNewTask.hidden = !canEdit;
  els.editGoalBtn.hidden = !canEdit;
  renderIdentity(data.meta);
  renderGoals(data, canEdit);
  renderFund(data);
  renderStats(data.stats);
  renderFilterCounts(data);
  renderTasks(data, canEdit);
}

function renderGoals(data, canEdit = true) {
  const goals = data.goals ?? [];
  const activeId = data.goal?.id;
  els.goalTabs.innerHTML = goals.map((g) => `
      <button class="goal-tab ${g.id === activeId ? 'is-active' : ''}" data-goal="${esc(g.id)}" title="${esc(g.name)}">
        <span class="gt-name">${esc(g.name)}</span>
        <span class="gt-meta">¥${money(g.earned)}/${money(g.target)} · ${Math.round(g.percent)}%</span>
        <span class="gt-bar"><i style="width:${Math.max(0, Math.min(100, g.percent))}%"></i></span>
      </button>`).join('')
    + `<button class="goal-tab goal-tab-add" data-goal="__new__"${canEdit ? '' : ' disabled'}>
         <span class="gt-plus">+</span><span class="gt-name">新建目标</span>
       </button>`;

  els.taskGoalName.textContent = data.goal?.name ? `· ${data.goal.name}` : '';
}

function renderIdentity(meta) {
  if (!meta) return;
  const me = meta.me;
  const users = meta.users ?? [];

  els.meSelect.innerHTML = users
    .map((u) => `<option value="${esc(u.id)}"${u.id === me.id ? ' selected' : ''}>${esc(u.name)}</option>`)
    .join('');

  const isPeer = !meta.canEdit;
  els.readonlyBanner.hidden = !isPeer;
  if (isPeer) els.readonlyName.textContent = meta.viewer.name;

  $$('.seg', els.viewSwitch).forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === (isPeer ? 'peer' : 'mine'));
  });

  const peer = users.find((u) => !u.isMe);
  if (!peer) {
    els.peerCard.innerHTML = '';
    return;
  }

  if (peer.linked && peer.summary) {
    const s = peer.summary;
    els.peerCard.innerHTML = `
      <div class="peer-chip">
        <span class="peer-name">${esc(peer.name)}</span>
        <span class="peer-goal">${s.goalCount} 个目标</span>
        <span class="peer-money">¥${money(s.earned)} / ¥${money(s.target)}</span>
        <span class="peer-percent">${Math.round(s.percent)}%</span>
        <span class="peer-done">完成 ${s.doneCount} · 进行 ${s.activeCount}</span>
        <button class="text-btn peer-unlink" data-action="unlink" data-id="${esc(peer.id)}">解除链接</button>
      </div>`;
  } else {
    els.peerCard.innerHTML = `
      <span class="peer-hint">还没有链接「${esc(peer.name)}」</span>
      <button class="ghost-btn peer-link" data-action="link" data-id="${esc(peer.id)}">链接对方</button>`;
  }
}

function renderFund(data) {
  const goal = data.goal;
  els.goalName.textContent = goal.name;
  els.goalTarget.textContent = money(goal.target);
  els.earnedAmount.textContent = money(goal.earned);
  els.fundPercent.textContent = `${Math.round(goal.percent)}%`;
  els.fundFill.style.width = `${Math.max(0, Math.min(100, goal.percent))}%`;
  els.fundFill.classList.toggle('is-reached', goal.reached);
  els.goalPill.textContent = goal.reached ? '已达成' : '攒钱中';
  els.goalPill.classList.toggle('is-reached', goal.reached);
  els.fundRemaining.textContent = goal.reached
    ? `目标已达成，超出 ¥${money(Math.max(0, goal.earned - goal.target))}`
    : `还差 ¥${money(goal.remaining)}`;

  if (goal.note) {
    els.goalNote.hidden = false;
    els.goalNote.textContent = goal.note;
  } else {
    els.goalNote.hidden = true;
  }

  els.ledger7d.textContent = goal.last7Count
    ? `近 7 天 ${goal.last7Count} 笔 +¥${money(goal.last7Earned)}`
    : '近 7 天暂无';

  const done = data.tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 4);

  els.ledgerList.innerHTML = done.length
    ? done.map((t) => `
        <li>
          <span class="ledger-title">${esc(t.title)}</span>
          <span class="ledger-date">${(() => {
            const d = new Date(t.completedAt);
            return `${d.getMonth() + 1}-${pad(d.getDate())}`;
          })()}</span>
          <span class="ledger-amt">+¥${money(t.actualReward ?? t.reward)}</span>
        </li>`).join('')
    : '<li class="ledger-empty">还没有入账记录，完成第一个任务试试</li>';
}

function renderStats(stats) {
  els.statTotal.textContent = stats.total;
  els.statDone.textContent = stats.done;
  els.statActive.textContent = stats.active;
  els.statOverdue.textContent = stats.overdue;
  els.plannedTotal.textContent = `¥${money(stats.plannedTotal)}`;
  els.completionByAmount.textContent = `${stats.completionByAmount}%`;

  const counts = stats.difficultyCounts;
  const max = Math.max(1, counts.easy, counts.medium, counts.hard);
  els.countHard.textContent = counts.hard;
  els.countMedium.textContent = counts.medium;
  els.countEasy.textContent = counts.easy;
  els.barHard.style.width = `${(counts.hard / max) * 100}%`;
  els.barMedium.style.width = `${(counts.medium / max) * 100}%`;
  els.barEasy.style.width = `${(counts.easy / max) * 100}%`;
}

function renderFilterCounts(data) {
  const counts = {
    all: data.tasks.length,
    todo: data.tasks.filter((t) => t.status === 'todo').length,
    doing: data.tasks.filter((t) => t.status === 'doing').length,
    done: data.tasks.filter((t) => t.status === 'done').length,
    overdue: data.tasks.filter((t) => t.derived.overdue).length,
  };
  $$('.filter-count', els.filters).forEach((el) => {
    el.textContent = counts[el.dataset.count] ?? 0;
  });
  $$('.filter', els.filters).forEach((el) => {
    el.classList.toggle('is-active', el.dataset.filter === app.filter);
  });
}

function visibleTasks(data) {
  const list = data.tasks;
  let filtered = list;
  if (app.filter === 'overdue') filtered = list.filter((t) => t.derived.overdue);
  else if (app.filter !== 'all') filtered = list.filter((t) => t.status === app.filter);

  return filtered.slice().sort((a, b) => {
    if (a.status === 'done' && b.status === 'done') return new Date(b.completedAt) - new Date(a.completedAt);
    if (a.status === 'done') return 1;
    if (b.status === 'done') return -1;
    const at = a.endAt ? new Date(a.endAt).getTime() : Infinity;
    const bt = b.endAt ? new Date(b.endAt).getTime() : Infinity;
    return at - bt;
  });
}

function taskCard(t, canEdit = true) {
  const d = t.derived;
  const level = LEVELS[t.difficulty] ?? LEVELS.medium;
  const statusClass = t.status === 'done' ? 'is-done' : d.overdue ? 'is-overdue' : t.status === 'doing' ? 'is-doing' : '';
  const statusText = t.status === 'done' ? '已完成' : d.overdue ? '已逾期' : t.status === 'doing' ? '进行中' : '待开始';
  const checklist = t.metrics.checklist;
  const numeric = t.metrics;

  const checklistHtml = checklist.length
    ? `<ul class="checklist">
        ${checklist.map((item) => `
          <li>
            <button class="ck ${item.done ? 'is-done' : ''}" data-action="toggle" data-id="${esc(t.id)}" data-item="${esc(item.id)}" aria-label="${item.done ? '取消勾选' : '勾选'}"${canEdit ? '' : ' disabled'}>
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <span class="ck-text ${item.done ? 'is-done' : ''}">${esc(item.text)}</span>
          </li>`).join('')}
      </ul>`
    : '';

  const numericHtml = numeric.numericEnabled
    ? `<div class="metric-progress">
        <input class="num-inline" type="number" min="0" step="1" value="${numeric.numeric.current}" data-action="numeric" data-id="${esc(t.id)}" aria-label="当前进度"${canEdit ? '' : ' disabled'}>
        <span>/ ${numeric.numeric.target}${esc(numeric.numeric.unit || '')}</span>
        <div class="mini-bar"><i class="fill" style="width:${Math.min(100, (numeric.numeric.current / numeric.numeric.target) * 100)}%"></i></div>
      </div>`
    : '';

  const descHtml = t.metrics.description
    ? `<p class="metric-desc">${esc(t.metrics.description)}</p>`
    : '';

  const hasMetrics = Boolean(t.metrics.description || checklist.length || numeric.numericEnabled);
  const progressHtml = d.progress !== null
    ? `<div class="metric-progress">
        <span class="metric-progress-label">整体 ${d.progress}%</span>
        <div class="mini-bar"><i class="fill" style="width:${d.progress}%"></i></div>
      </div>`
    : '';

  const actions = !canEdit
    ? '<span class="readonly-tag">只读</span>'
    : t.status === 'done'
      ? `<button class="link-btn" data-action="reopen" data-id="${esc(t.id)}">撤销完成</button>
       <button class="link-btn" data-action="edit" data-id="${esc(t.id)}">编辑</button>`
      : `<button class="link-btn" data-action="edit" data-id="${esc(t.id)}">编辑</button>
       <button class="settle-btn" data-action="settle" data-id="${esc(t.id)}">结算 ¥${money(t.reward)}</button>`;

  return `
    <article class="task-card ${t.status === 'done' ? 'is-done' : ''}" data-level="${esc(t.difficulty)}">
      <div class="task-head">
        <span class="level-chip"><i></i>${level.label}</span>
        <span class="reward-chip">¥${money(t.reward)}</span>
      </div>
      <h3 class="task-title">${esc(t.title)}</h3>
      ${t.content ? `<p class="task-desc">${esc(t.content)}</p>` : ''}
      <div class="time-row">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>
        <span>${esc(fmtRange(t.startAt, t.endAt))}</span>
        ${d.overdue ? '<span class="overdue-tag">逾期</span>' : ''}
      </div>
      <div class="metrics">
        ${descHtml}
        ${checklistHtml}
        ${numericHtml}
        ${!hasMetrics ? '<p class="metric-none">未设量化指标，完成后手动结算</p>' : ''}
        ${progressHtml}
      </div>
      <div class="task-foot">
        <span class="status-pill ${statusClass}">${t.status === 'done' ? `已入账 ¥${money(t.actualReward ?? t.reward)}` : statusText}</span>
        <div class="task-actions">${actions}</div>
      </div>
    </article>`;
}

function renderTasks(data, canEdit = true) {
  const list = visibleTasks(data);
  const hasAny = data.tasks.length > 0;

  if (!hasAny) {
    els.taskGrid.innerHTML = '';
    els.emptyState.hidden = false;
    els.emptyTitle.textContent = '还没有任务';
    els.emptyDesc.textContent = '给今天要干的事定个价，完成后奖励金就进你的攒钱目标。';
    els.emptyNewBtn.hidden = !canEdit;
    els.emptyNewBtn.textContent = '创建第一个任务';
    return;
  }

  if (!list.length) {
    els.taskGrid.innerHTML = '';
    els.emptyState.hidden = false;
    els.emptyTitle.textContent = '这个分类下没有任务';
    els.emptyDesc.textContent = '换个筛选条件，或者新建一个任务。';
    els.emptyNewBtn.hidden = !canEdit;
    els.emptyNewBtn.textContent = '新建任务';
    return;
  }

  els.emptyState.hidden = true;
  els.taskGrid.innerHTML = list.map((t) => taskCard(t, canEdit)).join('');
}

/* ---------------- 任务弹窗 ---------------- */

function setLevel(level, { syncReward = true } = {}) {
  app.level = level;
  $$('.level-option', els.levelPicker).forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.level === level);
  });
  const rule = LEVELS[level];
  els.levelHint.textContent = rule.range;
  els.rewardHint.textContent = `${rule.label}建议 ¥${rule.suggested}（${rule.range}），也可以自己填`;
  if (syncReward) setReward(rule.suggested);
}

function setReward(value) {
  const v = Math.max(REWARD_FLOOR, Math.min(REWARD_CEIL, Math.round(Number(value) || REWARD_FLOOR)));
  els.fRewardNumber.value = String(v);
  // 滑杆只管 1-100 这一段，超过就停在最右端，金额仍按输入框的值保存
  els.fRewardRange.value = String(Math.min(SLIDER_MAX, v));
}

function renderChecklistEditor() {
  if (!app.checklist.length) {
    els.checklistEditor.innerHTML = '<p class="checklist-empty">还没有子项，点右上角「+ 添加子项」逐条拆开。</p>';
    return;
  }
  els.checklistEditor.innerHTML = app.checklist.map((item, index) => `
    <div class="ck-row">
      <input type="text" maxlength="80" data-idx="${index}" value="${esc(item.text)}" placeholder="例如：刷完第一遍错题">
      <button type="button" class="icon-btn" data-remove="${index}" aria-label="删除子项">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>`).join('');
}

function openTaskModal(task = null) {
  app.editingId = task?.id ?? null;
  app.checklist = task
    ? task.metrics.checklist.map((i) => ({ id: i.id, text: i.text, done: i.done }))
    : [];

  els.taskModalTitle.textContent = task ? '调整任务信息' : '给任务定个价';
  els.taskModalEyebrow.textContent = task ? '编辑任务' : '新建任务';
  els.deleteTaskBtn.hidden = !task;
  els.saveTaskBtn.textContent = task ? '保存修改' : '保存任务';

  els.fTitle.value = task?.title ?? '';
  els.fContent.value = task?.content ?? '';
  els.fMetricDesc.value = task?.metrics.description ?? '';

  const now = new Date();
  const defaultStart = new Date(now.getTime() + 30 * 60 * 1000);
  defaultStart.setMinutes(0, 0, 0);
  const defaultEnd = new Date(defaultStart.getTime() + 2 * 60 * 60 * 1000);

  els.fStart.value = task?.startAt ? toInputValue(task.startAt) : toInputValue(defaultStart.toISOString());
  els.fEnd.value = task?.endAt ? toInputValue(task.endAt) : toInputValue(defaultEnd.toISOString());

  const numeric = task?.metrics.numeric;
  els.fNumericEnabled.checked = Boolean(numeric?.enabled);
  els.numericEditor.hidden = !numeric?.enabled;
  els.fNumericCurrent.value = numeric?.enabled ? numeric.current : 0;
  els.fNumericTarget.value = numeric?.enabled ? numeric.target : 20;
  els.fNumericUnit.value = numeric?.unit ?? '';

  renderChecklistEditor();
  setLevel(task?.difficulty ?? 'medium', { syncReward: !task });
  if (task) setReward(task.reward);

  els.taskModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => els.fTitle.focus(), 60);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.hidden = true;
  if (!['taskModal', 'settleModal', 'goalModal'].some((key) => !document.getElementById(key).hidden)) {
    document.body.style.overflow = '';
  }
}

async function saveTask() {
  const title = els.fTitle.value.trim();
  if (!title) { toast('请先填写任务标题', true); els.fTitle.focus(); return; }

  const startVal = els.fStart.value;
  const endVal = els.fEnd.value;
  if (!startVal || !endVal) { toast('开始时间和结束时间都要选', true); return; }
  if (new Date(endVal).getTime() <= new Date(startVal).getTime()) {
    toast('结束时间必须晚于开始时间', true);
    return;
  }

  const reward = Number(els.fRewardNumber.value);
  if (!Number.isFinite(reward) || reward < REWARD_FLOOR || reward > REWARD_CEIL) {
    toast(`奖励金额要大于 0，最多 ${REWARD_CEIL} 元`, true);
    els.fRewardNumber.focus();
    return;
  }

  const checklist = app.checklist.filter((i) => i.text.trim());
  const numericOn = els.fNumericEnabled.checked;
  const numericTarget = Number(els.fNumericTarget.value);
  const numericCurrent = Number(els.fNumericCurrent.value);
  if (numericOn && (!Number.isFinite(numericTarget) || numericTarget <= 0)) {
    toast('数值目标要大于 0', true);
    els.fNumericTarget.focus();
    return;
  }

  const payload = {
    title,
    content: els.fContent.value.trim(),
    startAt: new Date(startVal).toISOString(),
    endAt: new Date(endVal).toISOString(),
    difficulty: app.level,
    reward,
    metrics: {
      description: els.fMetricDesc.value.trim(),
      checklist: checklist.map((i) => ({ id: i.id, text: i.text.trim(), done: i.done })),
      numeric: {
        enabled: numericOn,
        target: numericOn ? numericTarget : 0,
        current: numericOn ? Math.max(0, Number.isFinite(numericCurrent) ? numericCurrent : 0) : 0,
        unit: numericOn ? els.fNumericUnit.value.trim() : '',
      },
    },
  };

  try {
    els.saveTaskBtn.disabled = true;
    if (app.editingId) {
      const res = await api(`/tasks/${app.editingId}`, 'PUT', payload);
      applySnapshot(res.snapshot);
      toast('任务已更新');
    } else {
      const res = await api('/tasks', 'POST', payload);
      applySnapshot(res.snapshot);
      toast('任务已创建，去把它干掉吧');
    }
    closeModal('taskModal');
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.saveTaskBtn.disabled = false;
  }
}

async function deleteTask() {
  if (!app.editingId) return;
  const task = app.snapshot.tasks.find((t) => t.id === app.editingId);
  const ok = window.confirm(`删除任务「${task?.title ?? ''}」？已入账的奖励金会一起扣除。`);
  if (!ok) return;
  try {
    const res = await api(`/tasks/${app.editingId}`, 'DELETE');
    applySnapshot(res.snapshot);
    closeModal('taskModal');
    toast('任务已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 结算 ---------------- */

function openSettle(task) {
  app.settlingId = task.id;
  els.settleTaskTitle.innerHTML = `任务：<b>${esc(task.title)}</b>`;
  els.settleAmount.value = String(task.reward);
  els.settleFull.textContent = `按计划 ¥${money(task.reward)}`;
  els.settleGoalName.textContent = app.snapshot.goal.name;
  els.settleModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => { els.settleAmount.focus(); els.settleAmount.select(); }, 60);
}

async function confirmSettle() {
  if (!app.settlingId) return;
  const raw = els.settleAmount.value;
  const value = raw === '' ? null : Number(raw);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > REWARD_CEIL)) {
    toast(`实际金额不能小于 0，最多 ${REWARD_CEIL} 元`, true);
    return;
  }
  try {
    els.confirmSettle.disabled = true;
    const res = await api(`/tasks/${app.settlingId}/settle`, 'POST', { actualReward: value });
    applySnapshot(res.snapshot);
    closeModal('settleModal');
    toast(`已入账 ¥${money(res.task.actualReward)}，目标进度 ${Math.round(res.snapshot.goal.percent)}%`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.confirmSettle.disabled = false;
  }
}

/* ---------------- 目标 ---------------- */

function openGoalModal(mode = 'edit') {
  const isNew = mode === 'new';
  const goal = app.snapshot?.goal;
  app.goalEditingId = isNew ? null : (goal?.id ?? null);

  els.goalModalEyebrow.textContent = isNew ? '新建目标' : '奖励目标';
  els.goalModalTitle.textContent = isNew ? '再开一个攒钱目标' : '这笔钱要攒去做什么';
  els.gName.value = isNew ? '' : (goal?.name ?? '');
  els.gTarget.value = isNew ? 500 : (goal?.target ?? 500);
  els.gNote.value = isNew ? '' : (goal?.note ?? '');
  els.deleteGoalBtn.hidden = isNew || (app.snapshot?.goals?.length ?? 0) <= 1;
  els.goalHint.textContent = isNew
    ? '新目标下的任务清单从空的开始，之后的任务结算只会累加进这个目标。'
    : '每个目标下有自己的任务清单，任务结算的钱只累加进它所属的目标。';

  els.goalModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => (isNew ? els.gName.focus() : els.gTarget.select()), 60);
}

async function saveGoal() {
  const name = els.gName.value.trim();
  const target = Number(els.gTarget.value);
  if (!name) { toast('目标名称不能为空', true); return; }
  if (!Number.isFinite(target) || target <= 0) { toast('目标金额要大于 0', true); return; }

  try {
    els.saveGoalBtn.disabled = true;
    if (app.goalEditingId) {
      const res = await api(`/goals/${app.goalEditingId}`, 'PATCH', {
        name, target, note: els.gNote.value.trim(),
      });
      app.goalId = app.goalEditingId;
      persistGoals();
      applySnapshot(res.snapshot);
      toast('目标已更新');
    } else {
      const res = await api('/goals', 'POST', { name, target, note: els.gNote.value.trim() });
      app.goalId = res.snapshot.goal.id;
      persistGoals();
      applySnapshot(res.snapshot);
      toast('目标已创建，往里加任务吧');
    }
    closeModal('goalModal');
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.saveGoalBtn.disabled = false;
  }
}

async function deleteGoal() {
  const goal = app.snapshot?.goal;
  if (!goal) return;
  const count = app.snapshot.tasks.length;
  const ok = window.confirm(`删除目标「${goal.name}」？它名下的 ${count} 条任务会一起删掉，已入账的 ¥${money(goal.earned)} 也一起消失。`);
  if (!ok) return;
  try {
    const res = await api(`/goals/${goal.id}`, 'DELETE', {});
    app.goalId = res.snapshot.goal.id;
    persistGoals();
    applySnapshot(res.snapshot);
    closeModal('goalModal');
    toast('目标已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

async function switchGoal(goalId) {
  if (!goalId || goalId === app.goalId) return;
  app.goalId = goalId;
  persistGoals();
  app.filter = 'all';
  try {
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 事件 ---------------- */

async function toggleChecklist(taskId, itemId, done) {
  try {
    const res = await api(`/tasks/${taskId}/checklist/${itemId}`, 'PATCH', { done });
    applySnapshot(res.snapshot);
    const task = app.snapshot.tasks.find((t) => t.id === taskId);
    if (task?.derived.achieved && task.status !== 'done') {
      toast('指标全部达成，可以结算奖励金了');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateNumeric(taskId, current) {
  try {
    const res = await api(`/tasks/${taskId}/numeric`, 'PATCH', { current });
    applySnapshot(res.snapshot);
    const task = app.snapshot.tasks.find((t) => t.id === taskId);
    if (task?.derived.achieved && task.status !== 'done') {
      toast('数值目标已达成，可以结算奖励金了');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function reopenTask(taskId) {
  const task = app.snapshot.tasks.find((t) => t.id === taskId);
  const ok = window.confirm(`撤销「${task?.title ?? ''}」的完成状态？已入账的 ¥${money(task?.actualReward ?? 0)} 会从目标里扣除。`);
  if (!ok) return;
  try {
    const res = await api(`/tasks/${taskId}/reopen`, 'POST', {});
    applySnapshot(res.snapshot);
    toast('已撤销完成');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 身份 / 看板 / 链接 ---------------- */

function persistIdentity() {
  if (app.meId) storage.set('planner.me', app.meId);
  if (app.viewId) storage.set('planner.view', app.viewId);
}

function persistGoals() {
  storage.set('planner.goal', app.goalId || '');
}

async function refresh() {
  const params = [];
  if (app.meId) params.push(`user=${encodeURIComponent(app.meId)}`);
  if (app.viewId) params.push(`view=${encodeURIComponent(app.viewId)}`);
  if (app.goalId) params.push(`goal=${encodeURIComponent(app.goalId)}`);
  const data = await api(`/state${params.length ? `?${params.join('&')}` : ''}`);
  app.meId = data.meta.me.id;
  app.viewId = data.meta.viewer.id;
  app.goalId = data.goal.id;
  persistIdentity();
  persistGoals();
  applySnapshot(data);
  return data;
}

async function setView(viewId) {
  try {
    if (!viewId || viewId === app.meId) {
      app.viewId = app.meId;
      persistIdentity();
      await refresh();
      return;
    }
    const peer = app.snapshot?.meta?.users.find((u) => u.id === viewId);
    if (!peer?.linked) {
      toast('先把对方链接上，才能看他的看板', true);
      return;
    }
    // 看别人的看板时，对方没有我当前选中的目标，回到他的第一个目标
    app.viewId = viewId;
    app.goalId = '';
    persistIdentity();
    persistGoals();
    await refresh();
  } catch (err) {
    // 切换失败要回到原状态，而不是留下半截数据
    app.viewId = app.meId;
    persistIdentity();
    await refresh().catch(() => {});
    toast(err.message || '切换看板失败，请重试', true);
  }
}

async function switchIdentity(userId) {
  if (!userId || userId === app.meId) return;
  app.meId = userId;
  app.viewId = userId;
  app.goalId = '';
  persistIdentity();
  persistGoals();
  try {
    const data = await refresh();
    toast(`已切换成「${data.meta.me.name}」`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function renameMe() {
  const me = app.snapshot?.meta?.me;
  if (!me) return;
  const input = window.prompt('给自己起个名字（最多 12 个字）', me.name);
  if (input === null) return;
  const name = input.trim();
  if (!name) { toast('名字不能为空', true); return; }
  try {
    const res = await api(`/users/${me.id}`, 'PATCH', { name });
    applySnapshot(res.snapshot);
    toast('名字已更新');
  } catch (err) {
    toast(err.message, true);
  }
}

async function linkPeer(peerId) {
  const me = app.snapshot?.meta?.me;
  if (!me || !peerId) return;
  try {
    const res = await api(`/users/${me.id}`, 'PATCH', { linkedUserId: peerId });
    applySnapshot(res.snapshot);
    toast('已链接，现在双方可以互相看进度了');
  } catch (err) {
    toast(err.message, true);
  }
}

async function unlinkPeer() {
  const me = app.snapshot?.meta?.me;
  if (!me) return;
  if (!window.confirm('解除链接后，双方就看不了对方的看板了。确定吗？')) return;
  app.viewId = me.id;
  persistIdentity();
  try {
    const res = await api(`/users/${me.id}`, 'PATCH', { linkedUserId: null });
    applySnapshot(res.snapshot);
    toast('已解除链接');
  } catch (err) {
    toast(err.message, true);
  }
}

function bind() {
  els.meSelect.addEventListener('change', () => switchIdentity(els.meSelect.value));
  els.renameMeBtn.addEventListener('click', renameMe);

  els.viewSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    const peer = app.snapshot?.meta?.users.find((u) => !u.isMe);
    setView(btn.dataset.view === 'mine' ? app.meId : peer?.id);
  });

  els.peerCard.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'link') linkPeer(btn.dataset.id);
    else if (btn.dataset.action === 'unlink') unlinkPeer();
  });

  els.newTaskBtn.addEventListener('click', () => openTaskModal());
  els.emptyNewBtn.addEventListener('click', () => openTaskModal());
  els.fabNewTask.addEventListener('click', () => openTaskModal());
  els.logoutBtn.addEventListener('click', logout);
  els.editGoalBtn.addEventListener('click', () => openGoalModal('edit'));
  els.deleteGoalBtn.addEventListener('click', deleteGoal);
  els.goalTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.goal-tab');
    if (!btn || btn.disabled) return;
    if (btn.dataset.goal === '__new__') { openGoalModal('new'); return; }
    switchGoal(btn.dataset.goal);
  });
  els.addChecklistBtn.addEventListener('click', () => {
    if (app.checklist.length >= 20) { toast('最多 20 个子项', true); return; }
    app.checklist.push({ id: null, text: '', done: false });
    renderChecklistEditor();
    const inputs = $$('input[data-idx]', els.checklistEditor);
    inputs[inputs.length - 1]?.focus();
  });

  els.checklistEditor.addEventListener('input', (e) => {
    const target = e.target.closest('input[data-idx]');
    if (!target) return;
    const index = Number(target.dataset.idx);
    if (app.checklist[index]) app.checklist[index].text = target.value;
  });

  els.checklistEditor.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    app.checklist.splice(Number(btn.dataset.remove), 1);
    renderChecklistEditor();
  });

  els.levelPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.level-option');
    if (!btn) return;
    setLevel(btn.dataset.level);
  });

  els.fRewardRange.addEventListener('input', () => {
    els.fRewardNumber.value = els.fRewardRange.value;
  });

  els.fRewardNumber.addEventListener('input', () => {
    const v = Number(els.fRewardNumber.value);
    if (Number.isFinite(v) && v >= REWARD_FLOOR && v <= SLIDER_MAX) {
      els.fRewardRange.value = String(Math.round(v));
    } else if (Number.isFinite(v) && v > SLIDER_MAX) {
      els.fRewardRange.value = String(SLIDER_MAX);
    }
  });

  els.fRewardNumber.addEventListener('blur', () => {
    const v = Number(els.fRewardNumber.value);
    if (!Number.isFinite(v) || v < REWARD_FLOOR || v > REWARD_CEIL) {
      setReward(LEVELS[app.level].suggested);
      return;
    }
    setReward(v);
  });

  els.fNumericEnabled.addEventListener('change', () => {
    els.numericEditor.hidden = !els.fNumericEnabled.checked;
    if (els.fNumericEnabled.checked) els.fNumericTarget.focus();
  });

  els.saveTaskBtn.addEventListener('click', saveTask);
  els.deleteTaskBtn.addEventListener('click', deleteTask);
  els.confirmSettle.addEventListener('click', confirmSettle);
  els.settleFull.addEventListener('click', () => {
    const task = app.snapshot.tasks.find((t) => t.id === app.settlingId);
    if (task) els.settleAmount.value = String(task.reward);
  });
  els.saveGoalBtn.addEventListener('click', saveGoal);

  els.filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    app.filter = btn.dataset.filter;
    render();
  });

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { closeModal(closeBtn.dataset.close); return; }

    if (e.target.classList.contains('modal-backdrop')) {
      closeModal(e.target.id);
      return;
    }

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const { action, id, item } = actionEl.dataset;

    if (action === 'edit') {
      const task = app.snapshot.tasks.find((t) => t.id === id);
      if (task) openTaskModal(task);
    } else if (action === 'settle') {
      const task = app.snapshot.tasks.find((t) => t.id === id);
      if (task) openSettle(task);
    } else if (action === 'reopen') {
      reopenTask(id);
    } else if (action === 'toggle') {
      const task = app.snapshot.tasks.find((t) => t.id === id);
      const ck = task?.metrics.checklist.find((i) => i.id === item);
      if (ck) toggleChecklist(id, item, !ck.done);
    }
  });

  document.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-action="numeric"]');
    if (!input) return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) { toast('进度必须是非负数字', true); render(); return; }
    updateNumeric(input.dataset.id, value);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['taskModal', 'settleModal', 'goalModal'].forEach((id) => {
        const modal = document.getElementById(id);
        if (modal && !modal.hidden) closeModal(id);
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (!els.taskModal.hidden) { e.preventDefault(); saveTask(); }
    }
  });
}

function initTodayLabel() {
  const d = new Date();
  els.todayLabel.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayLabel(d)}`;
}

async function init() {
  initTodayLabel();
  bind();
  try {
    await refresh();
  } catch (err) {
    // 存下来的身份或看板失效了（比如数据被重置），退回自己的看板再试一次
    app.viewId = app.meId;
    persistIdentity();
    try {
      await refresh();
    } catch (err2) {
      toast(`加载失败：${err2.message}`, true);
    }
  }
}

init();
