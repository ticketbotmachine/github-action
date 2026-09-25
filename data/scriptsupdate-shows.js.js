#!/usr/bin/env node
/**
 * scripts/update-shows.js
 *
 * ticketkiller — 場次資料自動更新腳本
 *
 * 用途：
 *   由 GitHub Actions（或本機 cron）每日執行，
 *   抓取各售票平台最新場次 → 過濾已過公售日期 → 寫入 data/concerts.json
 *
 * 執行：
 *   node scripts/update-shows.js
 *   node scripts/update-shows.js --dry-run        # 只印出結果，不寫檔
 *   node scripts/update-shows.js --source=manual  # 只使用內置資料，不抓遠端
 *
 * 依賴：
 *   Node.js >= 18（內建 fetch / Intl）
 *   選用：cheerio（HTML 解析）、node-html-parser
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ============================================================
   路徑與常數
   ============================================================ */
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'concerts.json');

const TIMEZONE = 'Asia/Hong_Kong';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ticketkiller-bot/1.0; +https://ticketkiller.example)';

const ALLOWED_ICON_COLORS = new Set(['purple', 'magenta', 'green', 'rose', 'blush']);

/* ============================================================
   CLI 參數
   ============================================================ */
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SOURCE_ARG = (argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'auto';

/* ============================================================
   工具函數
   ============================================================ */

/** 取得 HKT 今日日期字串 YYYY-MM-DD */
function getHKTDateStr(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value || '';
    const m = parts.find((p) => p.type === 'month')?.value || '';
    const d = parts.find((p) => p.type === 'day')?.value || '';
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch (_) {
    /* fallthrough */
  }
  const now = date;
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 產生 ISO 時間字串（含 HKT 偏移 +08:00） */
function hktIsoString(date = new Date()) {
  const hkt = new Date(
    date.toLocaleString('en-US', { timeZone: TIMEZONE })
  );
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${hkt.getFullYear()}-${pad(hkt.getMonth() + 1)}-${pad(hkt.getDate())}` +
    `T${pad(hkt.getHours())}:${pad(hkt.getMinutes())}:${pad(hkt.getSeconds())}+08:00`
  );
}

/** 檢查 YYYY-MM-DD */
function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** 簡易 logger */
const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
  ok: (...a) => console.log('[ OK ]', ...a),
};

/** 帶超時的 fetch */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        ...(options.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   資料驗證
   ============================================================ */

/**
 * 驗證單一場次物件；回傳 { valid: boolean, errors: string[], show?: object }
 */
function validateShow(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['不是物件'] };
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) errors.push('缺少 id');

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push('缺少 name');

  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  if (!date) errors.push('缺少 date');

  const venue = typeof raw.venue === 'string' ? raw.venue.trim() : '';
  if (!venue) errors.push('缺少 venue');

  const price = typeof raw.price === 'string' ? raw.price.trim() : '';
  if (!price) errors.push('缺少 price');

  if (!isDateStr(raw.publicSaleDate)) {
    errors.push('publicSaleDate 需為 YYYY-MM-DD');
  }

  const platform = typeof raw.platform === 'string' ? raw.platform.trim() : '';
  if (!platform) errors.push('缺少 platform');

  let ticketUrl = typeof raw.ticketUrl === 'string' ? raw.ticketUrl.trim() : '';
  if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
    errors.push('ticketUrl 需為 http(s) 開頭');
  }

  // iconColor 白名單
  let iconColor = typeof raw.iconColor === 'string' ? raw.iconColor : 'purple';
  if (!ALLOWED_ICON_COLORS.has(iconColor)) {
    iconColor = 'purple';
  }

  // prioritySales
  const prioritySales = Array.isArray(raw.prioritySales)
    ? raw.prioritySales
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          stage: typeof p.stage === 'string' ? p.stage.trim() : '優先購票',
          date: isDateStr(p.date) ? p.date : '',
          time: typeof p.time === 'string' ? p.time.trim() : '',
        }))
        .filter((p) => p.date)
    : [];

  if (errors.length) {
    return { valid: false, errors, show: raw };
  }

  return {
    valid: true,
    errors: [],
    show: {
      id,
      name,
      date,
      venue,
      price,
      publicSaleDate: raw.publicSaleDate,
      publicSaleTime:
        typeof raw.publicSaleTime === 'string' ? raw.publicSaleTime.trim() : '',
      platform,
      ticketUrl,
      isMacau: !!raw.isMacau,
      isHot: !!raw.isHot,
      prioritySales,
      icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : 'fa-ticket',
      iconColor,
    },
  };
}

/** 過濾掉已過公售日期的場次 */
function filterActive(shows, todayStr) {
  return shows.filter((s) => {
    if (!s || !isDateStr(s.publicSaleDate)) return false;
    return s.publicSaleDate >= todayStr;
  });
}

/** 去重（以 id 為鍵，後者覆蓋前者） */
function dedupeById(shows) {
  const map = new Map();
  for (const s of shows) {
    if (!s || !s.id) continue;
    map.set(s.id, s);
  }
  return Array.from(map.values());
}

/** 排序：熱門優先，其次公售日期升序 */
function sortShows(shows) {
  return shows.slice().sort((a, b) => {
    if (a.isHot && !b.isHot) return -1;
    if (!a.isHot && b.isHot) return 1;
    return String(a.publicSaleDate).localeCompare(String(b.publicSaleDate));
  });
}

/* ============================================================
   內置基礎資料（永遠作為底稿）
   若遠端抓取失敗或某場次缺失，仍能保留這批資料
   ============================================================ */
const BASE_SHOWS = [
  {
    id: 'serrini-2026',
    name: 'Serrini《小心女星》香港演唱會',
    date: '2026年10月30日（星期五）',
    venue: '麥花臣場館',
    price: 'VVIP HK$1,080 / $880 / $720',
    publicSaleDate: '2026-09-24',
    publicSaleTime: '上午 11:00',
    platform: 'KKTIX',
    ticketUrl: 'https://kktix.com/',
    isMacau: false,
    isHot: false,
    prioritySales: [
      { stage: '私心女星私人預售', date: '2026-09-22', time: '中午 12:00 – 9月23日 18:00' },
    ],
    icon: 'fa-music',
    iconColor: 'magenta',
  },
  {
    id: 'babymonster-2026',
    name: 'BABYMONSTER 世界巡迴演唱會香港站',
    date: '2027年1月9日（星期六）',
    venue: '亞洲國際博覽館 Arena',
    price: 'HK$2,299（VIP）/ $1,699 / $1,399 / $999 / $799',
    publicSaleDate: '2026-09-25',
    publicSaleTime: '上午 11:00',
    platform: 'Cityline',
    ticketUrl: 'https://www.cityline.com/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: 'MONSTIEZ 會員優先', date: '2026-09-22', time: '中午 12:00' },
      { stage: '滙豐Mastercard優先', date: '2026-09-23', time: '上午 11:00' },
      { stage: 'Trip.com 優先', date: '2026-09-23', time: '上午 11:00' },
      { stage: 'Live Nation 會員優先', date: '2026-09-24', time: '上午 11:00' },
    ],
    icon: 'fa-fire',
    iconColor: 'magenta',
  },
  {
    id: 'perse-2026',
    name: 'PER SE《LIFE IN CAPS》演唱會',
    date: '2026年11月20日（星期五）',
    venue: 'TIDES',
    price: 'VIP HK$980 / GA $680（全企位）',
    publicSaleDate: '2026-09-30',
    publicSaleTime: '下午 3:00',
    platform: 'Cityline',
    ticketUrl: 'https://www.cityline.com/',
    isMacau: false,
    isHot: false,
    prioritySales: [
      { stage: '滙豐Mastercard優先預售', date: '2026-09-29', time: '下午 15:00 – 23:59' },
    ],
    icon: 'fa-ticket',
    iconColor: 'purple',
  },
  {
    id: 'wang-wan-chi-2026',
    name: '王菀之《話・說》藝術展音樂會 香港站',
    date: '2026年12月4日 – 12月13日',
    venue: '西九文化區 自由空間 留白 Livehouse',
    price: 'HK$780 起（全企位）',
    publicSaleDate: '2026-10-02',
    publicSaleTime: '上午 10:00',
    platform: 'Cityline',
    ticketUrl: 'https://www.cityline.com/',
    isMacau: false,
    isHot: false,
    prioritySales: [],
    icon: 'fa-star',
    iconColor: 'purple',
  },
  {
    id: 'twins-2026',
    name: 'TWINS SIDE BY SIDE 演唱會',
    date: '2026年12月18日 – 12月22日（共5場）',
    venue: '香港會議展覽中心 Hall 5BC',
    price: 'HK$1,280 / $980 / $680',
    publicSaleDate: '2026-09-25',
    publicSaleTime: '中午 12:00',
    platform: '快達票 HK Ticketing',
    ticketUrl: 'https://www.hkticketing.com/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: '中銀銀聯信用卡優先', date: '2026-09-18', time: '上午 10:00' },
      { stage: '港澳及內地銀聯卡優先', date: '2026-09-19', time: '待公佈' },
    ],
    icon: 'fa-music',
    iconColor: 'magenta',
  },
  {
    id: 'bigbang-2026',
    name: 'BIGBANG WORLD TOUR〈XX : COSMOS〉',
    date: '2026年11月13日 – 11月17日（共4場）',
    venue: '啟德體育園主場館',
    price: 'HK$3,099（VIP企位）/ 坐位 $699 起',
    publicSaleDate: '2026-09-29',
    publicSaleTime: '下午 4:00',
    platform: '快達票 HK Ticketing',
    ticketUrl: 'https://www.hkticketing.com/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: 'V.I.P Fan Club 優先預售', date: '2026-09-28', time: '上午 10:00 – 晚上 23:59' },
      { stage: 'TME 音樂平台優先預售', date: '2026-09-29', time: '上午 10:00 – 下午 13:59' },
      { stage: '旅遊平台優先預售', date: '2026-09-29', time: '下午 14:00 – 15:59' },
    ],
    icon: 'fa-star',
    iconColor: 'purple',
  },
  {
    id: 'aaron-2026',
    name: '郭富城 ICONIC MOMENT 啟德跨年演唱會',
    date: '2026年12月31日 – 2027年1月1日',
    venue: '啟德體育園主場館',
    price: 'HK$1,680 / $1,380 / $1,180 / $980 / $680 / $480',
    publicSaleDate: '2026-10-14',
    publicSaleTime: '上午 10:00',
    platform: '快達票 HK Ticketing',
    ticketUrl: 'https://www.hkticketing.com/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: '滙豐Mastercard優先（第一輪）', date: '2026-10-09', time: '上午 10:00 – 晚上 23:59' },
      { stage: '滙豐Mastercard優先（第二輪）', date: '2026-10-10', time: '上午 10:00 – 晚上 23:59' },
      { stage: 'Klook 獨家套票預售', date: '2026-10-12', time: '中午 12:00 – 10月13日 23:59' },
    ],
    icon: 'fa-trophy',
    iconColor: 'green',
  },
  {
    id: 'janice-2026',
    name: '衛蘭 Janice《OUT OF FRAME》世界巡迴演唱會',
    date: '2026年11月14日、15日、17日',
    venue: '紅磡香港體育館',
    price: 'HK$1,180 / $880 / $580',
    publicSaleDate: '2026-10-08',
    publicSaleTime: '待公佈',
    platform: 'URBTIX',
    ticketUrl: 'https://www.urbtix.hk/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: '建行(亞洲)信用卡優先（第一輪）', date: '2026-09-28', time: '中午 12:00 – 晚上 20:00' },
      { stage: '建行(亞洲)信用卡優先（第二輪）', date: '2026-09-29', time: '中午 12:00 – 9月30日 20:00' },
      { stage: 'Klook 優先購票', date: '2026-09-30', time: '待公佈' },
    ],
    icon: 'fa-globe',
    iconColor: 'green',
  },
  {
    id: 'gigi-2026',
    name: '梁詠琪 LOVE GiGi 愛自己世界巡迴演唱會 香港站',
    date: '2026年11月27日 – 11月29日（共3場）',
    venue: '紅磡香港體育館',
    price: 'HK$1,180 / $780 / $480',
    publicSaleDate: '2026-10-08',
    publicSaleTime: '上午 10:00',
    platform: 'URBTIX',
    ticketUrl: 'https://www.urbtix.hk/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: '優先訂票', date: '2026-10-01', time: '上午 10:00' },
    ],
    icon: 'fa-globe',
    iconColor: 'green',
  },
  {
    id: 'andy-2026',
    name: '劉德華《About Life》巡迴演唱會香港站',
    date: '2026年12月18日 – 2027年1月10日（共20場）',
    venue: '紅磡香港體育館',
    price: 'HK$1,380 / $980 / $680',
    publicSaleDate: '2026-10-15',
    publicSaleTime: '待公佈',
    platform: 'URBTIX',
    ticketUrl: 'https://www.urbtix.hk/',
    isMacau: false,
    isHot: true,
    prioritySales: [
      { stage: '恒生Mastercard優先購票', date: '2026-09-21', time: '中午 12:00 起' },
      { stage: 'Klook 獨家套票預售', date: '2026-09-23', time: '中午 12:00 起' },
      { stage: 'URBTIX 網上抽籤登記', date: '2026-09-28 – 2026-09-30', time: '10:00 – 20:00' },
    ],
    icon: 'fa-star',
    iconColor: 'purple',
  },
  {
    id: 'yesung-macau-2026',
    name: '藝聲 YESUNG 10TH ANNIVERSARY TOUR 澳門站',
    date: '2026年11月14日 – 11月15日（共2場）',
    venue: '澳門百老匯劇院',
    price: 'VIP（含Sound Check）MOP$1,699 / CAT 1 $1,199 / CAT 2 $899',
    publicSaleDate: '2026-09-29',
    publicSaleTime: '中午 12:00',
    platform: 'FANTOPIA',
    ticketUrl: 'https://www.fantopia.io/',
    isMacau: true,
    isHot: false,
    prioritySales: [
      { stage: 'E.L.F. 會員優先', date: '2026-09-28', time: '中午 12:00 – 晚上 19:00' },
    ],
    icon: 'fa-star',
    iconColor: 'green',
  },
  {
    id: 'mc-macau-2026',
    name: 'MC張天賦《E=MC² 演唱會 2026》澳門站',
    date: '2026年11月27日 – 11月28日（共2場）',
    venue: '銀河綜藝館',
    price: 'HKD/MOP $1,588 / $1,288 / $888 / $688',
    publicSaleDate: '2026-10-07',
    publicSaleTime: '下午 1:00',
    platform: 'Klook、Cityline',
    ticketUrl: 'https://www.klook.com/',
    isMacau: true,
    isHot: true,
    prioritySales: [
      { stage: 'Klook 優先套票預售', date: '2026-09-30', time: '上午 11:00' },
      { stage: 'Cityline 優先購票', date: '2026-10-05', time: '中午 12:00' },
    ],
    icon: 'fa-fire',
    iconColor: 'magenta',
  },
];

/* ============================================================
   遠端抓取：示範每個平台一個 fetcher
   若你的數據源不同，可修改或新增 fetcher
   回傳格式：{ shows: Show[] }，成功時合併回主資料
   ============================================================ */

/**
 * 範例：從自建 API 抓取
 * 你在 CFG 中可設定 API_ENDPOINT，例如 https://api.example.com/shows
 * 回傳格式需為 { shows: [...] } 或 [...]，本腳本會自動驗證
 */
async function fetchFromOwnApi() {
  const endpoint = process.env.SHOWS_API_ENDPOINT;
  if (!endpoint) {
    log.info('未設定 SHOWS_API_ENDPOINT，略過自建 API 抓取');
    return null;
  }
  try {
    log.info(`抓取自建 API：${endpoint}`);
    const res = await fetchWithTimeout(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shows = Array.isArray(data) ? data : data && data.shows;
    if (!Array.isArray(shows)) throw new Error('回傳格式非陣列');
    return { shows };
  } catch (err) {
    log.warn('自建 API 抓取失敗：', err.message);
    return null;
  }
}

/**
 * 範例：從 Cityline 抓取（示意，實際需解析 HTML 或用其 API）
 * 這裡只作佔位，回傳 null 表示略過
 */
async function fetchFromCityline() {
  // TODO: 若你有 Cityline 公開 API 或可解析的端點，在這裡實作
  return null;
}

/**
 * 範例：從 KKTIX 抓取（示意）
 */
async function fetchFromKKTIX() {
  // TODO: 若你有 KKTIX 公開 API 或可解析的端點，在這裡實作
  return null;
}

/**
 * 範例：從 URBTIX 抓取（示意）
 */
async function fetchFromURBTIX() {
  // TODO: 若你有 URBTIX 公開 API 或可解析的端點，在這裡實作
  return null;
}

/**
 * 範例：從 HKTICKETING 抓取（示意）
 */
async function fetchFromHKTicketing() {
  // TODO: 若你有 HKTICKETING 公開 API 或可解析的端點，在這裡實作
  return null;
}

/**
 * 範例：從 FANTOPIA 抓取（示意）
 */
async function fetchFromFantopia() {
  // TODO: 若你有 FANTOPIA 公開 API 或可解析的端點，在這裡實作
  return null;
}

/**
 * 範例：從 Klook 抓取（示意）
 */
async function fetchFromKlook() {
  // TODO: 若你有 Klook 公開 API 或可解析的端點，在這裡實作
  return null;
}

/* ============================================================
   主流程
   ============================================================ */

async function collectRemoteShows() {
  if (SOURCE_ARG === 'manual') {
    log.info('--source=manual，只使用內置基礎資料');
    return [];
  }

  const fetchers = [
    { name: 'OwnApi',    fn: fetchFromOwnApi },
    { name: 'Cityline',  fn: fetchFromCityline },
    { name: 'KKTIX',     fn: fetchFromKKTIX },
    { name: 'URBTIX',    fn: fetchFromURBTIX },
    { name: 'HKTicketing', fn: fetchFromHKTicketing },
    { name: 'Fantopia',  fn: fetchFromFantopia },
    { name: 'Klook',     fn: fetchFromKlook },
  ];

  const results = await Promise.allSettled(
    fetchers.map(async ({ name, fn }) => {
      try {
        const r = await fn();
        if (!r || !Array.isArray(r.shows)) return { name, shows: [] };
        return { name, shows: r.shows };
      } catch (err) {
        log.warn(`[${name}] 抓取例外：`, err.message);
        return { name, shows: [] };
      }
    })
  );

  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { name, shows } = r.value;
      if (shows.length) {
        log.ok(`[${name}] 取得 ${shows.length} 場`);
        all.push(...shows);
      }
    }
  }
  return all;
}

async function main() {
  log.info('==== ticketkiller 場次更新開始 ====');
  log.info(`今日（HKT）：${getHKTDateStr()}`);

  /* 1. 收集遠端資料 */
  const remoteRaw = await collectRemoteShows();

  /* 2. 合併內置 + 遠端（遠端優先） */
  const mergedRaw = [...BASE_SHOWS];
  const baseIds = new Set(BASE_SHOWS.map((s) => s.id));
  for (const r of remoteRaw) {
    if (!r || typeof r !== 'object') continue;
    if (r.id && baseIds.has(r.id)) {
      // 以遠端覆蓋內置同 id
      const idx = mergedRaw.findIndex((s) => s.id === r.id);
      if (idx >= 0) mergedRaw[idx] = r;
    } else {
      mergedRaw.push(r);
    }
  }

  /* 3. 驗證 */
  const validShows = [];
  const invalidShows = [];
  for (const raw of mergedRaw) {
    const { valid, errors, show } = validateShow(raw);
    if (valid) validShows.push(show);
    else invalidShows.push({ id: raw && raw.id, errors });
  }
  if (invalidShows.length) {
    log.warn(`有 ${invalidShows.length} 筆資料未通過驗證：`);
    for (const inv of invalidShows) {
      log.warn(`  - ${inv.id || '(無 id)'}：${inv.errors.join('、')}`);
    }
  }

  /* 4. 去重 */
  const deduped = dedupeById(validShows);

  /* 5. 過濾已過公售（HKT） */
  const today = getHKTDateStr();
  const active = filterActive(deduped, today);

  /* 6. 排序 */
  const sorted = sortShows(active);

  /* 7. 統計 */
  const hotCount = sorted.filter((s) => s.isHot).length;
  log.info(`總場次：${sorted.length}（熱門 ${hotCount}）`);
  if (sorted.length === 0) {
    log.warn('更新後場次為 0，為避免前端顯示空白，本次不覆寫 data/concerts.json');
    process.exit(0);
  }

  /* 8. 組裝輸出 */
  const output = {
    updatedAt: hktIsoString(),
    generatedBy: 'scripts/update-shows.js',
    timezone: TIMEZONE,
    total: sorted.length,
    hot: hotCount,
    shows: sorted,
  };

  /* 9. Dry-run */
  if (DRY_RUN) {
    log.info('--dry-run 模式，不寫入檔案。預覽：');
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  /* 10. 寫檔 */
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log.info(`已建立目錄：${DATA_DIR}`);
  }

  const json = JSON.stringify(output, null, 2) + '\n';
  fs.writeFileSync(OUTPUT_FILE, json, 'utf8');
  log.ok(`已寫入 ${path.relative(ROOT_DIR, OUTPUT_FILE)}（${json.length} bytes）`);

  log.info('==== 完成 ====');
}

/* ============================================================
   入口
   ============================================================ */
main().catch((err) => {
  log.error('執行失敗：', err);
  process.exit(1);
});