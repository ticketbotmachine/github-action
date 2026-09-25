/**
 * ticketkiller 留言區後端
 * 提供三個端點：
 *   GET  /wall/list   → { messages: [...] }
 *   POST /wall/post   → { ok: true, message: {...} }
 *   POST /wall/like   → { ok: true, likes: N }
 *
 * 資料存於記憶體 + 本地 JSON 檔案（backup），
 * 生產環境建議換成 SQLite / Postgres / Redis。
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'wall-db.json');

const PORT = process.env.PORT || 3000;
const ORIGIN_WHITELIST = (process.env.ORIGIN_WHITELIST || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ORIGIN_WHITELIST.includes('*') || ORIGIN_WHITELIST.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '16kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/wall', limiter);

/* ---------- 儲存層 ---------- */
let store = { messages: [], likes: {} };

function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.messages)) store.messages = obj.messages;
      if (obj && obj.likes && typeof obj.likes === 'object') store.likes = obj.likes;
    }
  } catch (e) {
    console.warn('[store] load failed:', e.message);
  }
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
      console.warn('[store] save failed:', e.message);
    }
  }, 300);
}

loadStore();

/* ---------- 工具 ---------- */
function esc(s) { return String(s == null ? '' : s); }
function trim(s, n) { return esc(s).slice(0, n); }

function genKey() {
  return 'u|' + Date.now().toString(36) + '|' + Math.random().toString(36).slice(2, 8);
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.warn('[telegram] send failed:', e.message);
  }
}

/* ---------- 路由 ---------- */
app.get('/wall/list', (req, res) => {
  const list = store.messages
    .slice()
    .sort((a, b) => {
      const da = a.saleDate || '9999-99-99';
      const db = b.saleDate || '9999-99-99';
      if (da !== db) return da.localeCompare(db);
      return String(b.key || '').localeCompare(String(a.key || ''));
    })
    .map(m => ({
      ...m,
      likes: (m.likes || 0) + (store.likes[m.key] || 0)
    }));

  res.json({ messages: list });
});

app.post('/wall/post', async (req, res) => {
  const body = req.body || {};
  const name = trim(body.name, 20) || '匿名用戶';
  const text = trim(body.text, 200);
  const showName = trim(body.showName, 80) || '我的搶票戰績';
  const stage = trim(body.stage, 40) || '我的留言';
  const saleDate = /^\d{4}-\d{2}-\d{2}$/.test(body.saleDate) ? body.saleDate : null;
  const time = trim(body.time, 10) || null;

  if (!text || text.length < 2) {
    return res.status(400).json({ ok: false, error: 'TEXT_TOO_SHORT' });
  }

  const message = {
    key: genKey(),
    name,
    text,
    showName,
    stage,
    saleDate,
    time,
    likes: 0,
    hue: body.hue != null ? Number(body.hue) % 360 : Math.floor(Math.random() * 360),
    mine: false,
    source: 'user',
    createdAt: new Date().toISOString()
  };

  store.messages.unshift(message);
  if (store.messages.length > 1000) store.messages = store.messages.slice(0, 1000);
  saveStore();

  // 非同步通知管理員（失敗不影響回應）
  sendTelegram(
    '🎟 <b>ticketkiller 新留言</b>\n\n' +
    '<b>姓名：</b>' + message.name + '\n' +
    '<b>場次：</b>' + message.showName + '\n' +
    '<b>內容：</b>\n' + message.text
  );

  res.json({ ok: true, message });
});

app.post('/wall/like', (req, res) => {
  const key = trim(req.body && req.body.key, 80);
  if (!key) return res.status(400).json({ ok: false, error: 'NO_KEY' });

  store.likes[key] = (store.likes[key] || 0) + 1;
  saveStore();

  const msg = store.messages.find(m => m.key === key);
  const base = msg ? (msg.likes || 0) : 0;
  res.json({ ok: true, likes: base + store.likes[key] });
});

/* ---------- 健康檢查 ---------- */
app.get('/', (req, res) => res.json({ ok: true, service: 'ticketkiller-backend' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[ticketkiller-backend] listening on :${PORT}`);
});
