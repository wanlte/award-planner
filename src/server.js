import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './api.js';
import { getState, storageDescribe } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* 本地开发可以直接写一个 .env（线上仍然用平台环境变量），不引入额外依赖：
 * 只认 KEY=VALUE 和 # 注释，已存在的环境变量优先，不覆盖。 */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3210;

/** 访问密码：留空则不校验，适合本地开发；线上建议设置 */
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
/** 数据目录：容器里挂载存储卷时指向 /data */
const DATA_DIR = process.env.PLANNER_DATA_DIR
  ? path.resolve(process.env.PLANNER_DATA_DIR)
  : path.join(ROOT, 'data');

const COOKIE_NAME = 'planner_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 登录状态保留 30 天
const SESSION_SECRET = APP_PASSWORD; // 换密码 = 所有设备的下次访问需要重新登录

/* ---------------- 登录状态：签名 Cookie + 内存会话表 ----------------
 * Cookie 里带一个随机会话 id，签名防篡改；服务端保留 id 才能通过校验，
 * 这样「退出登录」能把旧 Cookie 真正作废。
 * 代价：服务重启后内存会话清空，所有人需要重新输一次密码。
 */

const sessions = new Map(); // id -> expiresAt

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function sweepSessions() {
  const now = Date.now();
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

function issueSession() {
  if (sessions.size > 200) sweepSessions();
  const id = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, expiresAt);
  const payload = `${id}.${expiresAt}`;
  return `${payload}.${signSession(payload)}`;
}

function readSession(value) {
  if (!SESSION_SECRET || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [id, rawExp, signature] = parts;
  const expiresAt = Number(rawExp);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  const expected = signSession(`${id}.${rawExp}`);
  const given = Buffer.from(signature);
  const target = Buffer.from(expected);
  if (given.length !== target.length) return null;
  if (!crypto.timingSafeEqual(given, target)) return null;

  if (!sessions.has(id) || sessions.get(id) !== expiresAt) return null;
  return { id, expiresAt };
}

function isValidSession(value) {
  return Boolean(readSession(value));
}

function revokeSession(value) {
  const parsed = readSession(value);
  if (parsed) sessions.delete(parsed.id);
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  header.split(';').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function sessionCookie(req, value, maxAgeMs) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (Number.isFinite(maxAgeMs)) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function samePassword(input) {
  const given = Buffer.from(String(input ?? ''));
  const target = Buffer.from(APP_PASSWORD);
  if (given.length !== target.length) {
    // 长度不同也走一次比较，尽量不靠长度泄露信息
    crypto.timingSafeEqual(target, target);
    return false;
  }
  return crypto.timingSafeEqual(given, target);
}

/* ---------------- 失败限速：同一 IP 连续试错就冷却一会儿 ---------------- */

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_MAX = 8;
const BLOCK_MS = 5 * 60 * 1000;
const attempts = new Map();

function attemptState(ip) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record) return { blockedUntil: 0, count: 0, firstAt: now };
  if (record.blockedUntil && record.blockedUntil > now) return record;
  if (now - record.firstAt > ATTEMPT_WINDOW_MS) return { blockedUntil: 0, count: 0, firstAt: now };
  return record;
}

function registerFailure(ip) {
  const state = attemptState(ip);
  const count = state.count + 1;
  const blockedUntil = count >= ATTEMPT_MAX ? Date.now() + BLOCK_MS : 0;
  attempts.set(ip, { count: blockedUntil ? 0 : count, firstAt: state.firstAt, blockedUntil });
}

function clearFailures(ip) {
  attempts.delete(ip);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// 健康检查放在鉴权前面，方便平台探活
app.get('/api/health', async (req, res) => {
  // 第一次访问时把存储初始化掉，顺便验证库能读
  let readable = false;
  try {
    await getState();
    const info = storageDescribe();
    // Supabase 模式下能读到数据就说明连上了；本地模式下看文件是否存在
    readable = info.type === 'supabase' ? true : (info.file ? fs.existsSync(info.file) : false);
  } catch {
    readable = false;
  }
  const storage = storageDescribe();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    dataDir: DATA_DIR,
    storage: storage.type,
    dataFile: storage.file,
    dataFileReadable: readable,
    auth: Boolean(APP_PASSWORD),
  });
});

// 解析 Cookie，给后面的鉴权判断用
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  req.authed = Boolean(APP_PASSWORD) ? isValidSession(req.cookies[COOKIE_NAME]) : true;
  next();
});

// 登录页：未开启密码时直接进应用
app.get('/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  if (req.authed) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// 提交密码，换取登录 Cookie
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, auth: false });

  const ip = req.ip || 'unknown';
  const state = attemptState(ip);
  if (state.blockedUntil && state.blockedUntil > Date.now()) {
    const wait = Math.ceil((state.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `密码错误次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` });
  }

  const password = String(req.body?.password ?? '');
  if (!samePassword(password)) {
    registerFailure(ip);
    return res.status(401).json({ error: '密码不对，再试一次' });
  }

  clearFailures(ip);
  res.setHeader('Set-Cookie', sessionCookie(req, issueSession(), SESSION_TTL_MS));
  res.json({ ok: true });
});

// 退出登录：作废这个会话，并清掉浏览器里的 Cookie
app.post('/api/logout', (req, res) => {
  revokeSession(req.cookies?.[COOKIE_NAME]);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

// 鉴权闸门：页面跳登录页，接口返回 401；静态资源（样式/脚本）放行，登录页要用
app.use((req, res, next) => {
  if (req.authed) return next();

  const pathname = req.path;
  if (/\.(css|js|png|jpg|jpeg|svg|ico|webp|woff|woff2|txt|json)$/i.test(pathname)) return next();

  if (pathname === '/' || pathname === '/index.html') {
    return res.redirect(302, '/login');
  }
  if (pathname.startsWith('/api/')) {
    return res.status(401).json({ error: '请先登录', login: '/login' });
  }
  return res.redirect(302, '/login');
});

app.use('/api', api);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// 前端路由兜底
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[api error]', err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`任务奖励规划器已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}${APP_PASSWORD ? '（已开启登录密码）' : '（未设密码，谁都能进）'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可以用 PORT=3300 npm start 换一个端口。`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
