import express from 'express';
import {
  DIFFICULTY_RULES,
  REWARD_MAX,
  REWARD_MIN,
  boardOf,
  buildSnapshot,
  findUser,
  getState,
  goalOf,
  newId,
  summarizeBoard,
  summarizeGoal,
  update,
} from './store.js';

export const api = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  throw new HttpError(400, message);
}

function findTask(goal, id) {
  const task = goal.tasks.find((t) => t.id === id);
  if (!task) throw new HttpError(404, '任务不存在');
  return task;
}

function toNumber(value, fallback = NaN) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDateValue(value, field) {
  if (typeof value !== 'string' || !value) bad(`${field}不能为空`);
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) bad(`${field}不是合法时间`);
  return new Date(time).toISOString();
}

function parseReward(value, field = '奖励金额') {
  const n = toNumber(value);
  if (!Number.isFinite(n)) bad(`${field}必须是数字`);
  if (n < REWARD_MIN || n > REWARD_MAX) bad(`${field}要大于 0，最多 ${REWARD_MAX} 元`);
  return Math.round(n * 100) / 100;
}

function parseChecklist(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) bad('子项清单格式不正确');
  if (raw.length > 20) bad('子项清单最多 20 条');
  return raw.map((item) => {
    const text = String(item?.text ?? '').trim();
    if (!text) bad('子项清单里存在空条目');
    if (text.length > 80) bad('子项清单单条不能超过 80 字');
    return {
      id: typeof item?.id === 'string' && item.id ? item.id : newId('ck'),
      text,
      done: Boolean(item?.done),
    };
  });
}

function parseMetrics(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      description: '',
      checklist: [],
      numeric: { enabled: false, target: 0, current: 0, unit: '' },
    };
  }
  const description = String(raw.description ?? '').trim();
  if (description.length > 500) bad('完成指标描述不能超过 500 字');

  const checklist = parseChecklist(raw.checklist);

  const n = raw.numeric && typeof raw.numeric === 'object' ? raw.numeric : {};
  const enabled = Boolean(n.enabled);
  let target = 0;
  let current = 0;
  const unit = String(n.unit ?? '').trim().slice(0, 10);
  if (enabled) {
    target = toNumber(n.target);
    if (!Number.isFinite(target) || target <= 0) bad('数值目标必须大于 0');
    if (target > 1_000_000) bad('数值目标过大');
    current = toNumber(n.current, 0);
    if (!Number.isFinite(current) || current < 0) bad('当前进度不能为负数');
    if (current > 10_000_000) bad('当前进度数值过大');
  }

  return { description, checklist, numeric: { enabled, target, current, unit } };
}

function parseTaskPayload(body) {
  const title = String(body?.title ?? '').trim();
  if (!title) bad('任务标题不能为空');
  if (title.length > 60) bad('任务标题不能超过 60 字');

  const content = String(body?.content ?? '').trim();
  if (content.length > 2000) bad('任务内容不能超过 2000 字');

  const startAt = parseDateValue(body?.startAt, '开始时间');
  const endAt = parseDateValue(body?.endAt, '结束时间');
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) bad('结束时间必须晚于开始时间');

  const difficulty = String(body?.difficulty ?? '');
  if (!DIFFICULTY_RULES[difficulty]) bad('难度只能是 easy / medium / hard');

  const reward = parseReward(body?.reward);
  const metrics = parseMetrics(body?.metrics);

  return { title, content, startAt, endAt, difficulty, reward, metrics };
}

function parseGoalFields(body, { requireName = false } = {}) {
  const out = {};
  if (requireName || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim();
    if (!name) bad('目标名称不能为空');
    if (name.length > 30) bad('目标名称不能超过 30 字');
    out.name = name;
  }
  if (requireName || body?.target !== undefined) {
    const target = toNumber(body?.target);
    if (!Number.isFinite(target) || target <= 0) bad('目标金额必须大于 0');
    if (target > 1_000_000) bad('目标金额过大');
    out.target = Math.round(target * 100) / 100;
  }
  if (body?.note !== undefined) {
    const note = String(body.note).trim();
    if (note.length > 100) bad('目标备注不能超过 100 字');
    out.note = note;
  }
  return out;
}

/* ---------------- 成员 / 链接 ---------------- */

/** 从 ?user= 解析当前身份；不带参数时默认第一个成员 */
function userFromQuery(currentState, query) {
  const raw = String(query?.user ?? '').trim();
  if (!raw) return currentState.users[0];
  const user = findUser(currentState, raw);
  if (!user) throw new HttpError(404, '成员不存在');
  return user;
}

async function currentUserId(req) {
  const currentState = await getState();
  return userFromQuery(currentState, req.query).id;
}

function requireBoard(currentState, userId) {
  const board = boardOf(currentState, userId);
  if (!board) throw new HttpError(404, '成员的看板不存在');
  return board;
}

/** 从 ?goal= 解析目标；不带参数时默认该成员第一个目标 */
function goalFromBoard(board, query) {
  const raw = String(query?.goal ?? '').trim();
  if (!raw) return board.goals[0];
  const goal = goalOf(board, raw);
  if (!goal) throw new HttpError(404, '目标不存在');
  return goal;
}

function buildMeta(currentState, me, view) {
  const peer = me.linkedUserId ? findUser(currentState, me.linkedUserId) : null;
  return {
    me: { id: me.id, name: me.name },
    viewer: { id: view.id, name: view.name },
    canEdit: me.id === view.id,
    peer: peer ? { id: peer.id, name: peer.name, linked: true } : null,
    users: currentState.users.map((user) => {
      const isMe = user.id === me.id;
      const linked = Boolean(me.linkedUserId && me.linkedUserId === user.id);
      return {
        id: user.id,
        name: user.name,
        isMe,
        linked: linked || isMe,
        summary: (isMe || linked) ? summarizeBoard(currentState.boards[user.id]) : null,
      };
    }),
  };
}

/** 前端一次拿全量渲染数据：某个目标的快照 + 目标列表 + 身份/链接信息
 *  strict=false 时，目标 id 对不上就退回该看板的第一个目标（切换看板时前端可能带着
 *  自己那边的目标 id，不该因此报错）
 */
function payload(state, meId, viewId = meId, goalId = '', { strict = true } = {}) {
  const me = findUser(state, meId) ?? state.users[0];
  const view = findUser(state, viewId) ?? me;
  const board = requireBoard(state, view.id);
  const goal = strict
    ? goalFromBoard(board, { goal: goalId })
    : (goalOf(board, goalId) || board.goals[0]);
  const snapshot = buildSnapshot(goal);
  return {
    ...snapshot,
    goals: board.goals.map(summarizeGoal),
    meta: buildMeta(state, me, view),
  };
}

// 读取快照：?user=当前身份  ?view=看谁的看板  ?goal=看哪个目标
api.get('/state', wrap(async (req, res) => {
  const state = await getState();
  const me = userFromQuery(state, req.query);
  const viewId = String(req.query.view ?? '').trim();

  let view = me;
  if (viewId && viewId !== me.id) {
    const target = findUser(state, viewId);
    if (!target) throw new HttpError(404, '成员不存在');
    if (me.linkedUserId !== target.id) {
      throw new HttpError(403, `还没有链接「${target.name}」，先在顶部点「链接」再把对方加上`);
    }
    view = target;
  }

  res.json(payload(state, me.id, view.id, String(req.query.goal ?? '').trim(), { strict: false }));
}));

// 改名 / 链接 / 解除链接
api.patch('/users/:id', wrap(async (req, res) => {
  const meId = await currentUserId(req);
  await update((state) => {
    const user = findUser(state, req.params.id);
    if (!user) throw new HttpError(404, '成员不存在');

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) bad('成员名字不能为空');
      if (name.length > 12) bad('成员名字不能超过 12 个字');
      user.name = name;
    }

    if (req.body?.linkedUserId !== undefined) {
      const raw = req.body.linkedUserId;
      if (raw === null || raw === '') {
        const previousId = user.linkedUserId;
        user.linkedUserId = null;
        const previous = previousId ? findUser(state, previousId) : null;
        if (previous && previous.linkedUserId === user.id) previous.linkedUserId = null;
      } else {
        const target = findUser(state, String(raw));
        if (!target) bad('要链接的成员不存在');
        if (target.id === user.id) bad('不能链接自己');
        // 链接是互相的：A 链接 B 之后，B 也能看 A
        user.linkedUserId = target.id;
        target.linkedUserId = user.id;
      }
    }
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId) });
}));

/* ---------------- 目标 ---------------- */

// 新建目标（新目标下的任务清单是空的）
api.post('/goals', wrap(async (req, res) => {
  const fields = parseGoalFields(req.body, { requireName: true });
  const meId = await currentUserId(req);
  const created = await update((state) => {
    const board = requireBoard(state, meId);
    if (board.goals.length >= 20) bad('最多 20 个目标');
    const goal = {
      id: newId('goal'),
      name: fields.name,
      target: fields.target,
      note: fields.note ?? '',
      createdAt: new Date().toISOString(),
      tasks: [],
    };
    board.goals.push(goal);
    return goal;
  });
  const state = await getState();
  res.status(201).json({ goal: { id: created.id, name: created.name }, snapshot: payload(state, meId, meId, created.id) });
}));

// 修改目标名称 / 金额 / 备注
api.patch('/goals/:id', wrap(async (req, res) => {
  const fields = parseGoalFields(req.body);
  const meId = await currentUserId(req);
  await update((state) => {
    const board = requireBoard(state, meId);
    const goal = goalOf(board, req.params.id);
    if (!goal) throw new HttpError(404, '目标不存在');
    if (fields.name !== undefined) goal.name = fields.name;
    if (fields.target !== undefined) goal.target = fields.target;
    if (fields.note !== undefined) goal.note = fields.note;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, req.params.id) });
}));

// 删除目标（连同它名下的任务一起删，至少保留一个目标）
api.delete('/goals/:id', wrap(async (req, res) => {
  const meId = await currentUserId(req);
  let remainingGoalId = '';
  await update((state) => {
    const board = requireBoard(state, meId);
    if (board.goals.length <= 1) bad('至少要保留一个目标');
    const index = board.goals.findIndex((g) => g.id === req.params.id);
    if (index === -1) throw new HttpError(404, '目标不存在');
    board.goals.splice(index, 1);
    remainingGoalId = board.goals[0].id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, remainingGoalId) });
}));

/* ---------------- 任务（都挂在某个目标下） ---------------- */

api.post('/tasks', wrap(async (req, res) => {
  const body = parseTaskPayload(req.body);
  const meId = await currentUserId(req);
  const goalId = String(req.query.goal ?? '').trim();
  const created = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: goalId });
    const task = {
      id: newId('task'),
      ...body,
      suggestedReward: DIFFICULTY_RULES[body.difficulty].suggested,
      actualReward: null,
      status: 'todo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };
    goal.tasks.push(task);
    return { task, goalId: goal.id };
  });
  const state = await getState();
  res.status(201).json({ task: created.task, snapshot: payload(state, meId, meId, created.goalId) });
}));

api.put('/tasks/:id', wrap(async (req, res) => {
  const body = parseTaskPayload(req.body);
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const task = findTask(goal, req.params.id);
    Object.assign(task, body, {
      suggestedReward: DIFFICULTY_RULES[body.difficulty].suggested,
      updatedAt: new Date().toISOString(),
    });
    if (task.status === 'done' && task.actualReward === null) task.actualReward = null;
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));

// 勾选 / 取消子项
api.patch('/tasks/:id/checklist/:itemId', wrap(async (req, res) => {
  const done = Boolean(req.body?.done);
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const task = findTask(goal, req.params.id);
    const item = task.metrics.checklist.find((i) => i.id === req.params.itemId);
    if (!item) throw new HttpError(404, '子项不存在');
    item.done = done;
    task.updatedAt = new Date().toISOString();
    if (task.status === 'todo') task.status = 'doing';
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));

// 更新数值目标的当前进度
api.patch('/tasks/:id/numeric', wrap(async (req, res) => {
  const current = toNumber(req.body?.current);
  if (!Number.isFinite(current) || current < 0) bad('当前进度必须是非负数字');
  if (current > 10_000_000) bad('当前进度数值过大');
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const task = findTask(goal, req.params.id);
    if (!task.metrics.numeric.enabled) bad('该任务没有启用数值目标');
    task.metrics.numeric.current = current;
    task.updatedAt = new Date().toISOString();
    if (task.status === 'todo') task.status = 'doing';
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));

// 手动切换 待开始 / 进行中
api.patch('/tasks/:id/status', wrap(async (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['todo', 'doing'].includes(status)) bad('状态只能是 todo 或 doing（完成请走结算）');
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const task = findTask(goal, req.params.id);
    if (task.status === 'done') bad('已完成的任务请先撤销完成');
    task.status = status;
    task.updatedAt = new Date().toISOString();
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));

// 结算：标记完成并把这笔钱记入这个目标的进度
api.post('/tasks/:id/settle', wrap(async (req, res) => {
  const raw = req.body?.actualReward;
  const actual = raw === undefined || raw === '' ? null : toNumber(raw);
  if (actual !== null) {
    if (!Number.isFinite(actual)) bad('实际金额必须是数字');
    if (actual < 0 || actual > REWARD_MAX) bad(`实际金额不能小于 0，最多 ${REWARD_MAX} 元`);
  }
  const meId = await currentUserId(req);
  const result = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const t = findTask(goal, req.params.id);
    if (t.status === 'done') bad('任务已经结算过了');
    t.status = 'done';
    t.actualReward = Math.round((actual === null ? t.reward : actual) * 100) / 100;
    t.completedAt = new Date().toISOString();
    t.updatedAt = t.completedAt;
    return { task: t, goalId: goal.id };
  });
  const state = await getState();
  res.json({ task: result.task, snapshot: payload(state, meId, meId, result.goalId) });
}));

// 撤销完成：金额从目标里扣除
api.post('/tasks/:id/reopen', wrap(async (req, res) => {
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const t = findTask(goal, req.params.id);
    if (t.status !== 'done') bad('任务尚未完成');
    t.status = 'doing';
    t.actualReward = null;
    t.completedAt = null;
    t.updatedAt = new Date().toISOString();
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));

api.delete('/tasks/:id', wrap(async (req, res) => {
  const meId = await currentUserId(req);
  const goalId = await update((state) => {
    const goal = goalFromBoard(requireBoard(state, meId), { goal: req.query.goal });
    const index = goal.tasks.findIndex((t) => t.id === req.params.id);
    if (index === -1) throw new HttpError(404, '任务不存在');
    goal.tasks.splice(index, 1);
    return goal.id;
  });
  const state = await getState();
  res.json({ snapshot: payload(state, meId, meId, goalId) });
}));
