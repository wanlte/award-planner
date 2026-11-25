import fs from 'node:fs/promises';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* node:sqlite 在 Node 22 属于实验特性，加载时会打一条 ExperimentalWarning。
 * 这条提示会把日志和测试的「无报错」判断弄脏，这里只精确过滤掉它自己。 */
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(message)) return;
  emitWarning(warning, ...rest);
};

/** 奖励金金额：不再卡死区间，只保留"正数 + 上限"的基本校验 */
export const REWARD_MIN = 1;
export const REWARD_MAX = 100000;

/** 三档难度：颜色、建议区间、建议值（金额最终由自己填，区间只是参考） */
export const DIFFICULTY_RULES = {
  easy: { key: 'easy', label: '容易', color: '#22c55e', min: 10, max: 30, suggested: 20 },
  medium: { key: 'medium', label: '中等', color: '#f59e0b', min: 30, max: 50, suggested: 40 },
  hard: { key: 'hard', label: '困难', color: '#ef4444', min: 50, max: REWARD_MAX, suggested: 60 },
};

const DATA_DIR = process.env.PLANNER_DATA_DIR
  ? path.resolve(process.env.PLANNER_DATA_DIR)
  : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'planner.json');

/** 首次启动时预置的两个成员，之后可以在界面上改名 */
export const DEFAULT_USERS = [
  { id: 'u_a', name: '成员 A' },
  { id: 'u_b', name: '成员 B' },
];

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function defaultGoal(id = newId('goal')) {
  return {
    id,
    name: '攒钱目标',
    target: 500,
    note: '',
    createdAt: new Date().toISOString(),
    tasks: [],
  };
}

function defaultBoard() {
  return { goals: [defaultGoal()] };
}

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 3,
    revision: 0,
    createdAt: now,
    users: DEFAULT_USERS.map((u) => ({ id: u.id, name: u.name, createdAt: now, linkedUserId: null })),
    boards: Object.fromEntries(DEFAULT_USERS.map((u) => [u.id, defaultBoard()])),
  };
}

function normalizeMetrics(metrics) {
  const m = metrics && typeof metrics === 'object' ? metrics : {};
  const checklist = Array.isArray(m.checklist)
    ? m.checklist.map((item) => ({
        id: typeof item?.id === 'string' && item.id ? item.id : newId('ck'),
        text: String(item?.text ?? '').trim(),
        done: Boolean(item?.done),
      })).filter((item) => item.text)
    : [];
  const n = m.numeric && typeof m.numeric === 'object' ? m.numeric : {};
  return {
    description: String(m.description ?? ''),
    checklist,
    numeric: {
      enabled: Boolean(n.enabled),
      target: Number(n.target) > 0 ? Number(n.target) : 0,
      current: Math.max(0, Number(n.current) || 0),
      unit: String(n.unit ?? ''),
    },
  };
}

function normalizeTask(raw) {
  const difficulty = DIFFICULTY_RULES[raw?.difficulty] ? raw.difficulty : 'medium';
  const reward = Number(raw?.reward);
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : newId('task'),
    title: String(raw?.title ?? '').trim(),
    content: String(raw?.content ?? ''),
    startAt: raw?.startAt ?? null,
    endAt: raw?.endAt ?? null,
    difficulty,
    suggestedReward: DIFFICULTY_RULES[difficulty].suggested,
    reward: Number.isFinite(reward) ? reward : DIFFICULTY_RULES[difficulty].suggested,
    actualReward: raw?.actualReward === null || raw?.actualReward === undefined
      ? null
      : (Number.isFinite(Number(raw.actualReward)) ? Number(raw.actualReward) : null),
    metrics: normalizeMetrics(raw?.metrics),
    status: ['todo', 'doing', 'done'].includes(raw?.status) ? raw.status : 'todo',
    createdAt: raw?.createdAt ?? new Date().toISOString(),
    updatedAt: raw?.updatedAt ?? new Date().toISOString(),
    completedAt: raw?.completedAt ?? null,
  };
}

/** 目标 = 名称 + 目标金额 + 备注 + 自己的任务清单 */
function normalizeGoal(raw, index = 0) {
  const base = defaultGoal(index === 0 ? 'g_default' : newId('goal'));
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : base.id,
    name: String(raw?.name || '攒钱目标').trim() || '攒钱目标',
    target: Number(raw?.target) > 0 ? Number(raw.target) : 500,
    note: String(raw?.note ?? ''),
    createdAt: raw?.createdAt ?? base.createdAt,
    tasks: Array.isArray(raw?.tasks) ? raw.tasks.map(normalizeTask) : [],
  };
}

/**
 * 兼容三种历史结构：
 * v3：{ goals: [...] }
 * v2：{ goal: {...}, tasks: [...] }（单目标）
 * v1：整个 state 就是 { goal, tasks }（单工作区，由上层迁移）
 */
function normalizeBoard(raw) {
  if (Array.isArray(raw?.goals)) {
    const goals = raw.goals.map((g, i) => normalizeGoal(g, i));
    return { goals: goals.length ? goals : [defaultGoal()] };
  }
  const goal = normalizeGoal({
    id: 'g_default',
    name: raw?.goal?.name,
    target: raw?.goal?.target,
    note: raw?.goal?.note,
    tasks: raw?.tasks,
  }, 0);
  return { goals: [goal] };
}

function normalizeUser(raw, index) {
  const fallback = DEFAULT_USERS[index] ?? { id: newId('user'), name: `成员 ${index + 1}` };
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : fallback.id,
    name: String(raw?.name ?? fallback.name).trim() || fallback.name,
    createdAt: raw?.createdAt ?? new Date().toISOString(),
    linkedUserId: typeof raw?.linkedUserId === 'string' && raw.linkedUserId ? raw.linkedUserId : null,
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  const base = defaultState();

  // 旧版单工作区（只有 goal + tasks）：迁移成两个人的看板，老数据归第一个成员
  if (!Array.isArray(raw.users) || !raw.boards || typeof raw.boards !== 'object') {
    const now = new Date().toISOString();
    const users = DEFAULT_USERS.map((u) => ({
      id: u.id,
      name: u.name,
      createdAt: raw.createdAt ?? now,
      linkedUserId: null,
    }));
    return {
      version: 3,
      revision: Number(raw.revision) || 0,
      createdAt: raw.createdAt ?? now,
      users,
      boards: {
        [users[0].id]: normalizeBoard(raw),
        [users[1].id]: defaultBoard(),
      },
    };
  }

  const seen = new Set();
  const users = [];
  (Array.isArray(raw.users) ? raw.users : []).forEach((item, index) => {
    const user = normalizeUser(item, index);
    if (seen.has(user.id)) return;
    seen.add(user.id);
    users.push(user);
  });
  if (!users.length) return defaultState();

  const boards = {};
  users.forEach((user) => {
    boards[user.id] = normalizeBoard(raw.boards?.[user.id]);
  });

  // 链接关系只保留指向真实成员的引用；对方没有反向链接时补上，保证互相可见
  users.forEach((user) => {
    if (user.linkedUserId && (!boards[user.linkedUserId] || user.linkedUserId === user.id)) {
      user.linkedUserId = null;
      return;
    }
    if (user.linkedUserId) {
      const peer = users.find((u) => u.id === user.linkedUserId);
      if (peer) peer.linkedUserId = user.id;
    }
  });

  return {
    version: 3,
    revision: Number(raw.revision) || 0,
    createdAt: raw.createdAt ?? base.createdAt,
    users,
    boards,
  };
}

/* ------------------------------------------------------------------
 * 存储层：SQLite 优先，JSON 兜底
 * - SQLite 用 Node 22 内置的 node:sqlite，零额外依赖、零外部服务
 * - 表结构 users / goals / tasks（清单与数值指标存在 tasks.metrics_json）
 * - 每次更新在一个事务里整表重写：数据量只有几十行，换来绝对一致性
 * - 旧版留下的 planner.json 在首次启动时自动导入，并改名成 .migrated 留档
 * ------------------------------------------------------------------ */

const DB_FILE = path.join(DATA_DIR, 'planner.db');
const JSON_FILE = DATA_FILE;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     TEXT,
  linked_user_id TEXT
);
CREATE TABLE IF NOT EXISTS goals (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  target     REAL NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  goal_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT,
  start_at      TEXT,
  end_at        TEXT,
  difficulty    TEXT,
  reward        REAL,
  actual_reward REAL,
  status        TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  completed_at  TEXT,
  metrics_json  TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(user_id, goal_id, position);
`;

let state = null;
let loading = null;
let storage = null;
let storageInfo = { type: 'pending', file: '' };

/** 表里的一行 → 内部任务对象（suggestedReward 等由 normalizeTask 补齐） */
function rowToTask(row) {
  // SQLite 存的是 JSON 字符串，Supabase 的 jsonb 直接是对象，两种都吃
  const rawMetrics = row.metrics_json ?? row.metrics;
  let metrics = {};
  if (typeof rawMetrics === 'string') {
    try {
      metrics = JSON.parse(rawMetrics || '{}');
    } catch {
      metrics = {};
    }
  } else if (rawMetrics && typeof rawMetrics === 'object') {
    metrics = rawMetrics;
  }
  return {
    id: row.id,
    title: row.title ?? '',
    content: row.content ?? '',
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    difficulty: row.difficulty ?? 'medium',
    reward: row.reward === null ? undefined : row.reward,
    actualReward: row.actual_reward ?? null,
    metrics,
    status: row.status ?? 'todo',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

/** 把三张表的行组装成 v3 的 state（users + boards[userId].goals[].tasks[]）
 *  SQLite 和 Supabase 共用这一段，行字段统一用数据库里的 snake_case 命名 */
function composeState(metaInfo, userRows, goalRows, taskRows) {
  const users = userRows ?? [];
  if (!users.length) return null;

  const meta = {};
  if (Array.isArray(metaInfo)) {
    metaInfo.forEach((row) => { meta[row.key] = row.value; });
  } else if (metaInfo && typeof metaInfo === 'object') {
    Object.assign(meta, metaInfo);
  }

  const boards = {};
  users.forEach((u) => {
    boards[u.id] = { goals: [] };
  });

  const tasksByGoal = new Map();
  const seenTasks = new Set();
  (taskRows ?? []).forEach((row) => {
    // 同一条任务在复合主键下只可能属于一个成员，但防一遍重复
    const dedupe = `${row.user_id}|${row.id}`;
    if (seenTasks.has(dedupe)) return;
    seenTasks.add(dedupe);
    const key = `${row.user_id}|${row.goal_id}`;
    if (!tasksByGoal.has(key)) tasksByGoal.set(key, []);
    tasksByGoal.get(key).push(rowToTask(row));
  });

  (goalRows ?? []).forEach((row) => {
    const board = boards[row.user_id];
    if (!board) return;
    board.goals.push({
      id: row.id,
      name: row.name,
      target: row.target,
      note: row.note ?? '',
      createdAt: row.created_at ?? null,
      tasks: tasksByGoal.get(`${row.user_id}|${row.id}`) ?? [],
    });
  });

  return {
    version: Number(meta.version) || 3,
    revision: Number(meta.revision) || 0,
    createdAt: meta.createdAt || meta.created_at || null,
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      createdAt: u.created_at ?? null,
      linkedUserId: u.linked_user_id ?? null,
    })),
    boards,
  };
}

/** 从 SQLite 读：先取行，再交给 composeState */
function readSqlite(db) {
  const metaRows = db.prepare('select key, value from meta').all();
  const userRows = db.prepare('select id, name, created_at, linked_user_id from users order by rowid').all();
  if (!userRows.length) return null;
  const goalRows = db.prepare('select * from goals order by user_id, position').all();
  const taskRows = db.prepare('select * from tasks order by user_id, position').all();
  return composeState(metaRows, userRows, goalRows, taskRows);
}

const toNum = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** 把 state 摊平成三张表的行，SQLite 插入和 Supabase 上传都用它 */
function flattenState(s) {
  const users = [];
  const goals = [];
  const tasks = [];
  let goalPos = 0;
  let taskPos = 0;

  (Array.isArray(s.users) ? s.users : []).forEach((user) => {
    users.push({
      id: user.id,
      name: user.name ?? '',
      created_at: user.createdAt ?? null,
      linked_user_id: user.linkedUserId ?? null,
    });
    (s.boards?.[user.id]?.goals ?? []).forEach((goal) => {
      goals.push({
        user_id: user.id,
        id: goal.id,
        name: goal.name ?? '',
        target: toNum(goal.target, 0),
        note: goal.note ?? '',
        created_at: goal.createdAt ?? null,
        position: goalPos++,
      });
      (goal.tasks ?? []).forEach((task) => {
        tasks.push({
          user_id: user.id,
          goal_id: goal.id,
          id: task.id,
          title: task.title ?? '',
          content: task.content ?? '',
          start_at: task.startAt ?? null,
          end_at: task.endAt ?? null,
          difficulty: task.difficulty ?? 'medium',
          reward: toNum(task.reward, 0),
          actual_reward: task.actualReward === null || task.actualReward === undefined
            ? null
            : toNum(task.actualReward, 0),
          status: task.status ?? 'todo',
          created_at: task.createdAt ?? null,
          updated_at: task.updatedAt ?? null,
          completed_at: task.completedAt ?? null,
          metrics_json: JSON.stringify(task.metrics ?? {}),
          position: taskPos++,
        });
      });
    });
  });

  return {
    meta: {
      version: String(s.version ?? 3),
      revision: String(s.revision ?? 0),
      createdAt: String(s.createdAt ?? ''),
    },
    users,
    goals,
    tasks,
  };
}

/** 整份状态写回 SQLite：一个事务里先清空再插入，失败整体回滚 */
function writeSqlite(db, s) {
  const flat = flattenState(s);

  const metaStmt = db.prepare('insert into meta (key, value) values (?, ?)');
  const userStmt = db.prepare('insert into users (id, name, created_at, linked_user_id) values (?, ?, ?, ?)');
  const goalStmt = db.prepare('insert into goals (id, user_id, name, target, note, created_at, position) values (?, ?, ?, ?, ?, ?, ?)');
  const taskStmt = db.prepare(`insert into tasks
    (id, user_id, goal_id, title, content, start_at, end_at, difficulty, reward, actual_reward, status, created_at, updated_at, completed_at, metrics_json, position)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM goals');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM meta');

    metaStmt.run('version', flat.meta.version);
    metaStmt.run('revision', flat.meta.revision);
    metaStmt.run('createdAt', flat.meta.createdAt);

    flat.users.forEach((u) => {
      userStmt.run(u.id, u.name, u.created_at, u.linked_user_id);
    });
    flat.goals.forEach((g) => {
      goalStmt.run(g.id, g.user_id, g.name, g.target, g.note, g.created_at, g.position);
    });
    flat.tasks.forEach((t) => {
      taskStmt.run(
        t.id, t.user_id, t.goal_id, t.title, t.content,
        t.start_at, t.end_at, t.difficulty, t.reward, t.actual_reward,
        t.status, t.created_at, t.updated_at, t.completed_at, t.metrics_json, t.position,
      );
    });

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已经回滚或事务没起来，忽略 */
    }
    throw err;
  }
}

/* ------------------------------------------------------------------
 * Supabase（云端 Postgres）存储
 * - 用 PostgREST 的 rpc 接口，纯 fetch，不装 supabase-js
 * - planner_load / planner_save 两个 Postgres 函数定义在 supabase/schema.sql
 * - 每次保存是一次 RPC 调用，整套写入在数据库端的单个事务里完成
 * - 需要 service_role key（放服务端环境变量，绝不能进前端）
 * ------------------------------------------------------------------ */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '').trim();

async function supabaseRpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${name} 返回 ${res.status}：${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Supabase ${name} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

function supabaseStorage() {
  return {
    type: 'supabase',
    // 只用来展示，不含密钥
    file: SUPABASE_URL,
    read: async () => {
      const data = await supabaseRpc('planner_load', {});
      const payload = Array.isArray(data) ? data[0] : data;
      if (!payload) return null;
      return composeState(payload.meta, payload.users ?? [], payload.goals ?? [], payload.tasks ?? []);
    },
    write: async (s) => {
      const flat = flattenState(s);
      await supabaseRpc('planner_save', {
        p: {
          version: Number(flat.meta.version) || 3,
          revision: Number(flat.meta.revision) || 0,
          createdAt: flat.meta.createdAt || new Date().toISOString(),
          users: flat.users,
          goals: flat.goals,
          tasks: flat.tasks,
        },
      });
    },
    close: async () => {},
  };
}

/** 打开存储：配了 Supabase 就用云端库；否则用 SQLite；再不行退回 JSON 文件 */
async function openStorage() {
  mkdirSync(DATA_DIR, { recursive: true });

  if (SUPABASE_URL && SUPABASE_KEY) {
    // 先探一次活，配置错就直接报清楚，避免带着坏配置静默运行
    try {
      await supabaseRpc('planner_load', {});
    } catch (err) {
      throw new Error(
        `Supabase 连接失败：${err.message}\n`
        + '检查：1) SUPABASE_URL 是否是 https://xxxx.supabase.co；'
        + '2) SUPABASE_SERVICE_KEY 是否是 service_role key（不是 anon）；'
        + '3) supabase/schema.sql 是否已经在 SQL Editor 里执行过。',
      );
    }
    console.log(`[store] 使用 Supabase 存储：${SUPABASE_URL}`);
    return supabaseStorage();
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
      type: 'sqlite',
      file: DB_FILE,
      read: async () => readSqlite(db),
      write: async (s) => writeSqlite(db, s),
      close: async () => db.close(),
    };
  } catch (err) {
    console.warn(`[store] node:sqlite 不可用，改用 JSON 文件存储：${err.message}`);
    return {
      type: 'json',
      file: JSON_FILE,
      read: async () => {
        // JSON_FILE 不存在时返回 null，让上层走初始化流程
        try {
          return JSON.parse(await fs.readFile(JSON_FILE, 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') return null;
          if (e instanceof SyntaxError) {
            throw new Error(`数据文件损坏（JSON 解析失败）：${JSON_FILE}。请修复或删除后重启。`);
          }
          throw e;
        }
      },
      write: async (s) => {
        const tmp = `${JSON_FILE}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
        await fs.rename(tmp, JSON_FILE);
      },
      close: async () => {},
    };
  }
}

/** 旧版 planner.json 只在 SQLite 模式下当作迁移来源 */
async function readLegacyJson() {
  if (storage?.type !== 'sqlite' || !existsSync(JSON_FILE)) return null;
  try {
    return JSON.parse(await fs.readFile(JSON_FILE, 'utf8'));
  } catch (err) {
    console.warn(`[store] 旧数据 ${JSON_FILE} 解析失败，已忽略：${err.message}`);
    return null;
  }
}

async function loadInitial() {
  storage = await openStorage();
  storageInfo = { type: storage.type, file: storage.file };

  let loaded = await storage.read();
  if (!loaded) {
    // Supabase 模式下不自动把本地 planner.json 推上去，避免把测试数据带上线
    if (storage.type === 'supabase' && existsSync(JSON_FILE)) {
      console.warn(`[store] 检测到本地 ${JSON_FILE}，Supabase 模式不会自动上传它；需要迁移请运行 scripts/migrate-json-to-supabase.mjs`);
    }
    const legacy = await readLegacyJson();
    if (legacy) {
      loaded = normalizeState(legacy);
      await storage.write(loaded);
      try {
        renameSync(JSON_FILE, `${JSON_FILE}.migrated`);
      } catch {
        /* 改名失败不影响使用 */
      }
      console.log(`[store] 已把旧 planner.json 迁移进 ${storage.file}`);
    } else {
      loaded = defaultState();
      await storage.write(loaded);
    }
  }
  return normalizeState(loaded);
}

export async function getState() {
  if (state) return state;
  if (!loading) loading = loadInitial();
  state = await loading;
  return state;
}

/** 给健康检查用：当前用的是哪种存储、文件在哪 */
export function storageDescribe() {
  return { ...storageInfo };
}

let queue = Promise.resolve();

/** 串行地修改内存状态并落盘，避免并发写坏数据 */
export function update(mutator) {
  const run = async () => {
    const s = await getState();
    const result = await mutator(s);
    s.revision += 1;
    await storage.write(s);
    return result;
  };
  const task = queue.then(run, run);
  queue = task.catch(() => {});
  return task;
}

/** 把任务派生成前端直接可用的形态：指标进度、是否达成、是否逾期 */
export function deriveTask(task, now = Date.now()) {
  const items = task.metrics?.checklist ?? [];
  const checklistDone = items.filter((i) => i.done).length;
  const checklistTotal = items.length;
  const num = task.metrics?.numeric ?? { enabled: false, target: 0, current: 0, unit: '' };
  const numericEnabled = Boolean(num.enabled && num.target > 0);
  const numericDone = numericEnabled ? num.current >= num.target : false;

  const checks = [];
  if (checklistTotal > 0) {
    checks.push({ type: 'checklist', done: checklistDone === checklistTotal, doneCount: checklistDone, total: checklistTotal });
  }
  if (numericEnabled) {
    checks.push({ type: 'numeric', done: numericDone, current: num.current, target: num.target, unit: num.unit });
  }

  const hasChecks = checks.length > 0;
  const achieved = hasChecks ? checks.every((c) => c.done) : false;

  let progress = null;
  if (hasChecks) {
    const totalUnits = checklistTotal + (numericEnabled ? 1 : 0);
    const doneUnits = checklistDone + (numericEnabled && numericDone ? 1 : 0);
    progress = totalUnits > 0 ? Math.round((doneUnits / totalUnits) * 100) : null;
  }

  const end = task.endAt ? new Date(task.endAt).getTime() : null;
  const start = task.startAt ? new Date(task.startAt).getTime() : null;
  const overdue = task.status !== 'done' && end !== null && end < now;
  const startsLater = task.status === 'todo' && start !== null && start > now;

  return {
    ...task,
    metrics: { ...task.metrics, checklistDone, checklistTotal, numericEnabled, numericDone },
    derived: {
      progress,
      achieved,
      hasChecks,
      overdue,
      startsLater,
      earned: task.status === 'done' ? Number(task.actualReward ?? task.reward) : 0,
    },
  };
}

const round1 = (n) => Number(n.toFixed(1));

/** 单个目标的完整快照：目标进度 + 它名下的任务 */
export function buildSnapshot(goal, now = Date.now()) {
  const tasks = (goal.tasks ?? []).map((t) => deriveTask(t, now));

  const done = tasks.filter((t) => t.status === 'done');
  const earned = done.reduce((sum, t) => sum + Number(t.actualReward ?? t.reward), 0);
  const plannedTotal = tasks.reduce((sum, t) => sum + t.reward, 0);
  const plannedDone = done.reduce((sum, t) => sum + t.reward, 0);
  const goalTarget = goal.target;

  const percent = goalTarget > 0 ? Math.min(100, (earned / goalTarget) * 100) : 0;
  const remaining = Math.max(0, goalTarget - earned);
  const reached = earned >= goalTarget && goalTarget > 0;

  const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
  tasks.forEach((t) => { difficultyCounts[t.difficulty] += 1; });

  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const last7Done = done.filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekAgo);
  const last7Earned = last7Done.reduce((sum, t) => sum + Number(t.actualReward ?? t.reward), 0);

  return {
    goal: {
      id: goal.id,
      name: goal.name,
      target: goal.target,
      note: goal.note,
      createdAt: goal.createdAt,
      earned,
      remaining,
      percent: round1(percent),
      reached,
      last7Earned,
      last7Count: last7Done.length,
    },
    tasks,
    stats: {
      total: tasks.length,
      done: done.length,
      active: tasks.filter((t) => t.status !== 'done').length,
      doing: tasks.filter((t) => t.status === 'doing').length,
      overdue: tasks.filter((t) => t.derived.overdue).length,
      plannedTotal,
      plannedDone,
      earned,
      completionByCount: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
      completionByAmount: plannedTotal ? Math.round((plannedDone / plannedTotal) * 100) : 0,
      difficultyCounts,
    },
    rules: DIFFICULTY_RULES,
    limits: { min: REWARD_MIN, max: REWARD_MAX },
  };
}

/** 目标切换器上的一格：只要汇总，不要任务明细 */
export function summarizeGoal(goal) {
  const snapshot = buildSnapshot(goal);
  return {
    id: snapshot.goal.id,
    name: snapshot.goal.name,
    target: snapshot.goal.target,
    earned: snapshot.goal.earned,
    percent: snapshot.goal.percent,
    reached: snapshot.goal.reached,
    doneCount: snapshot.stats.done,
    taskTotal: snapshot.stats.total,
    activeCount: snapshot.stats.active,
  };
}

/** 队友卡片用：整个人的所有目标合起来看 */
export function summarizeBoard(board) {
  const goals = (board.goals ?? []).map(summarizeGoal);
  const earned = goals.reduce((sum, g) => sum + g.earned, 0);
  const target = goals.reduce((sum, g) => sum + g.target, 0);
  const doneCount = goals.reduce((sum, g) => sum + g.doneCount, 0);
  const taskTotal = goals.reduce((sum, g) => sum + g.taskTotal, 0);
  const activeCount = goals.reduce((sum, g) => sum + g.activeCount, 0);
  return {
    goalCount: goals.length,
    earned,
    target,
    percent: target > 0 ? round1(Math.min(100, (earned / target) * 100)) : 0,
    doneCount,
    activeCount,
    taskTotal,
    goals,
  };
}

export function findUser(currentState, id) {
  if (!id) return null;
  return currentState.users.find((u) => u.id === id) ?? null;
}

export function boardOf(currentState, userId) {
  return currentState.boards[userId] ?? null;
}

/** 取目标：给了 id 就精确找，没给就用第一个 */
export function goalOf(board, goalId) {
  if (!board?.goals?.length) return null;
  if (!goalId) return board.goals[0];
  return board.goals.find((g) => g.id === goalId) ?? null;
}
