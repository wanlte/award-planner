/**
 * 把本地 data/planner.json 导入 Supabase（一次性迁移用）
 * 用法（Windows PowerShell）：
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_KEY="service_role key"
 *   node scripts/migrate-json-to-supabase.mjs
 * 可选：node scripts/migrate-json-to-supabase.mjs "F:\path\to\planner.json"
 *
 * 注意：会覆盖 Supabase 里的现有数据（planner_save 是整份替换）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = process.argv[2] || path.join(ROOT, 'data', 'planner.json');
const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '').trim();

if (!base || !key) {
  console.error('缺少环境变量：SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`找不到数据文件：${file}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = new Date().toISOString();

/** 兼容 v3（boards[userId].goals[]）与更早的单目标结构 */
function normalize(rawState) {
  if (Array.isArray(rawState.users) && rawState.boards && typeof rawState.boards === 'object') {
    return rawState;
  }
  const users = [
    { id: 'u_a', name: '成员 A', createdAt: rawState.createdAt || now, linkedUserId: null },
    { id: 'u_b', name: '成员 B', createdAt: rawState.createdAt || now, linkedUserId: null },
  ];
  const tasks = Array.isArray(rawState.tasks) ? rawState.tasks : [];
  return {
    version: 3,
    revision: Number(rawState.revision) || 0,
    createdAt: rawState.createdAt || now,
    users,
    boards: {
      u_a: { goals: [{ id: rawState.goal?.id || 'g_default', name: rawState.goal?.name || '攒钱目标', target: Number(rawState.goal?.target) || 500, note: rawState.goal?.note || '', createdAt: rawState.goal?.createdAt || now, tasks }] },
      u_b: { goals: [{ id: 'g_default', name: '攒钱目标', target: 500, note: '', createdAt: now, tasks: [] }] },
    },
  };
}

const state = normalize(raw);
const users = [];
const goals = [];
const tasks = [];
let gp = 0;
let tp = 0;

(state.users ?? []).forEach((u) => {
  users.push({
    id: u.id,
    name: u.name ?? '',
    created_at: u.createdAt ?? null,
    linked_user_id: u.linkedUserId ?? null,
  });
  (state.boards?.[u.id]?.goals ?? []).forEach((g) => {
    goals.push({
      user_id: u.id,
      id: g.id,
      name: g.name ?? '',
      target: Number(g.target) || 0,
      note: g.note ?? '',
      created_at: g.createdAt ?? null,
      position: gp++,
    });
    (g.tasks ?? []).forEach((t) => {
      tasks.push({
        user_id: u.id,
        goal_id: g.id,
        id: t.id,
        title: t.title ?? '',
        content: t.content ?? '',
        start_at: t.startAt ?? null,
        end_at: t.endAt ?? null,
        difficulty: t.difficulty ?? 'medium',
        reward: Number(t.reward) || 0,
        actual_reward: t.actualReward === null || t.actualReward === undefined ? null : Number(t.actualReward),
        status: t.status ?? 'todo',
        created_at: t.createdAt ?? null,
        updated_at: t.updatedAt ?? null,
        completed_at: t.completedAt ?? null,
        metrics_json: JSON.stringify(t.metrics ?? {}),
        position: tp++,
      });
    });
  });
});

const payload = {
  version: 3,
  revision: Number(state.revision) || 0,
  createdAt: state.createdAt || now,
  users,
  goals,
  tasks,
};

const res = await fetch(`${base}/rest/v1/rpc/planner_save`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ p: payload }),
});

if (!res.ok) {
  console.error(`导入失败（${res.status}）：${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

console.log(`已导入：${users.length} 个成员、${goals.length} 个目标、${tasks.length} 个任务 → ${base}`);
