/**
 * 登录与鉴权测试：以子进程方式拉起一个带 APP_PASSWORD 的实例，验证
 * 「登录页可访问、未登录被挡、错密码被拒、登录后 Cookie 生效、退出后失效、
 * 静态资源放行、数据落在指定目录」。
 * 用法：node test/auth.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.AUTH_TEST_PORT) || 3211;
const PASSWORD = 'test-pass-1380';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出，code=${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('服务启动超时');
}

async function login(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const cookie = (cookies[0] || '').split(';')[0];
  return { status: res.status, body, cookie };
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-auth-'));
  console.log(`auth test: ${BASE}，临时数据目录 ${dataDir}`);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PLANNER_DATA_DIR: dataDir, APP_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitForServer(child);
    check('服务已启动', stdout.includes('已启动'), stdout.trim());

    const health = await fetch(`${BASE}/api/health`);
    const healthJson = await health.json();
    check('健康检查免鉴权 200', health.status === 200, health.status);
    check('健康检查报告已开启登录密码', healthJson.auth === true, healthJson.auth);
    check('健康检查报告数据目录生效', path.resolve(healthJson.dataDir) === path.resolve(dataDir), healthJson.dataDir);

    const rootVisit = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('未登录访问首页跳登录页', rootVisit.status === 302 && rootVisit.headers.get('location') === '/login',
      `${rootVisit.status} ${rootVisit.headers.get('location')}`);

    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    check('登录页可直接打开', loginPage.status === 200 && loginHtml.includes('访问密码'), loginPage.status);

    const cssPublic = await fetch(`${BASE}/styles.css`);
    check('登录页需要的样式文件放行', cssPublic.status === 200, cssPublic.status);

    const stateNoAuth = await fetch(`${BASE}/api/state`);
    const stateNoAuthJson = await stateNoAuth.json().catch(() => ({}));
    check('接口未登录 401', stateNoAuth.status === 401, stateNoAuth.status);
    check('接口 401 带登录入口提示', stateNoAuthJson.login === '/login', stateNoAuthJson.login);

    const wrong = await login('wrong-pass');
    check('错误密码 401', wrong.status === 401, wrong.status);
    check('错误密码给出提示文案', Boolean(wrong.body.error), wrong.body.error);

    const right = await login(PASSWORD);
    check('正确密码 200', right.status === 200, right.status);
    check('登录后下发会话 Cookie', right.cookie.startsWith('planner_session='), right.cookie);

    const authed = { Cookie: right.cookie };

    const state = await fetch(`${BASE}/api/state`, { headers: authed });
    const snapshot = await state.json();
    check('带 Cookie 可读数据', state.status === 200 && Boolean(snapshot.goal?.name), state.status);
    check('快照带多目标列表', Array.isArray(snapshot.goals) && snapshot.goals.length >= 1, snapshot.goals?.length);

    const pageAuthed = await fetch(`${BASE}/`, { headers: authed });
    const pageHtml = await pageAuthed.text();
    check('带 Cookie 可打开首页', pageAuthed.status === 200 && pageHtml.includes('任务奖励规划器'), pageAuthed.status);

    const created = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authed },
      body: JSON.stringify({
        title: '鉴权测试任务',
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 3600_000).toISOString(),
        difficulty: 'easy',
        reward: 10,
      }),
    });
    check('带 Cookie 可写数据', created.status === 201, created.status);

    if (healthJson.storage === 'supabase') {
      const s = await (await fetch(`${BASE}/api/state`, { headers: authed })).json();
      const tasks = s.tasks ?? [];
      check(
        '数据写入 Supabase 后可通过接口读回',
        tasks.some((t) => t.title === '鉴权测试任务'),
        `storage=supabase tasks=${tasks.length}`,
      );
    } else {
    const dbFile = path.join(dataDir, 'planner.db');
    const jsonFile = path.join(dataDir, 'planner.json');
    const dbExists = await fs.stat(dbFile).then(() => true).catch(() => false);
    const jsonExists = await fs.stat(jsonFile).then(() => true).catch(() => false);
    check('数据写入指定目录', dbExists || jsonExists, dbExists ? dbFile : jsonFile);

    if (dbExists) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbFile);
      const rows = db.prepare('select title from tasks').all();
      const users = db.prepare('select id from users').all();
      db.close();
      check(
        '数据按「成员→目标→任务」落盘（SQLite）',
        users.length >= 2 && rows.some((r) => r.title === '鉴权测试任务'),
        `users=${users.length} tasks=${rows.length}`,
      );
    } else if (jsonExists) {
      const persisted = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
      const board = persisted.boards?.[persisted.users?.[0]?.id];
      const tasks = board?.goals?.[0]?.tasks ?? [];
      check(
        '数据按「成员→目标→任务」落盘（JSON）',
        persisted.version === 3 && tasks.some((t) => t.title === '鉴权测试任务'),
        `version=${persisted.version} tasks=${tasks.length}`,
      );
    } else {
      check('数据按「成员→目标→任务」落盘', false, '两种存储文件都没找到');
    }
    }

    const out = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: authed });
    const clearCookie = (out.headers.getSetCookie ? out.headers.getSetCookie() : [out.headers.get('set-cookie') || ''])[0] || '';
    check('退出登录清空 Cookie', out.status === 200 && clearCookie.includes('Max-Age=0'), clearCookie);

    const afterLogout = await fetch(`${BASE}/api/state`, { headers: authed });
    check('退出后旧 Cookie 失效', afterLogout.status === 401, afterLogout.status);
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  check('日志无报错', stderr.trim() === '', stderr.trim().slice(0, 200));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('鉴权测试异常:', err);
  process.exit(1);
});
