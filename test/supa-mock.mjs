/**
 * 本地假 Supabase（只实现 planner_load / planner_save 两个 RPC）
 * 用途：在没有真实 Supabase 项目时，验证 store.js 的 Supabase 通道能跑通，
 *       顺便检查 apikey / Authorization 头是不是按 PostgREST 的要求带上了。
 * 用法：node test/supa-mock.mjs [端口]（默认 3216）
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.SUPA_MOCK_PORT || 3216);

/** 内存里的"数据库"，字段命名跟 schema.sql 的表保持一致 */
const db = {
  meta: null,
  users: [],
  goals: [],
  tasks: [],
};

let savedCount = 0;
let badAuthCount = 0;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload === null ? 'null' : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/health') {
    return json(res, 200, { ok: true, savedCount, badAuthCount, users: db.users.length, tasks: db.tasks.length });
  }

  if (req.method !== 'POST' || !url.startsWith('/rest/v1/rpc/')) {
    return json(res, 404, { message: 'not found' });
  }

  const name = url.split('/').pop();

  if (!req.headers.apikey || !req.headers.authorization) {
    badAuthCount += 1;
    return json(res, 401, { message: 'Missing apikey / Authorization' });
  }

  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json(res, 400, { message: 'invalid json' });
  }

  if (name === 'planner_load') {
    return json(res, 200, db);
  }

  if (name === 'planner_save') {
    const p = body.p ?? {};
    if (p.version === undefined || !Array.isArray(p.users)) {
      return json(res, 400, { message: 'payload 缺字段：version / users' });
    }
    db.meta = {
      version: Number(p.version) || 3,
      revision: Number(p.revision) || 0,
      createdAt: p.createdAt || new Date().toISOString(),
    };
    db.users = p.users ?? [];
    db.goals = p.goals ?? [];
    // 客户端上传的是 metrics_json 字符串，这里模拟 jsonb 落库后读回是对象
    db.tasks = (p.tasks ?? []).map((t) => {
      const next = { ...t };
      if (typeof next.metrics_json === 'string') {
        try {
          next.metrics = JSON.parse(next.metrics_json);
        } catch {
          next.metrics = {};
        }
      }
      delete next.metrics_json;
      return next;
    });
    savedCount += 1;
    return json(res, 200, null);
  }

  return json(res, 404, { message: `unknown rpc ${name}` });
});

server.listen(PORT, () => {
  console.log(`supa-mock 已启动: http://localhost:${PORT}/rest/v1/rpc/*`);
});
