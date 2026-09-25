#!/usr/bin/env node
/**
 * 每日更新 data/concerts.json
 * 預設策略：
 *   1) 讀取現有 JSON
 *   2) 移除所有公售日期與優先購票日期都已過去的場次
 *   3) 更新 updatedAt
 *   4) 寫回檔案
 *
 * 若你要接入外部資料源（如官方 API 或自建爬蟲），
 * 可在此檔案替換 fetchShowsFromSource()。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', 'data', 'concerts.json');

function todayHKT() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function isStillActive(show, today) {
  if (show.publicSaleDate && show.publicSaleDate >= today) return true;
  if (Array.isArray(show.prioritySales)) {
    return show.prioritySales.some(p => p && p.date && p.date >= today);
  }
  return false;
}

async function fetchShowsFromSource() {
  // 若有外部資料源，請在此回傳陣列
  // 例如：const res = await fetch('https://your-api/shows'); return res.json();
  return null;
}

async function main() {
  const raw = await fs.readFile(FILE, 'utf8');
  const data = JSON.parse(raw);

  let shows = await fetchShowsFromSource();
  if (!shows) shows = Array.isArray(data.shows) ? data.shows : [];

  const today = todayHKT();
  const before = shows.length;
  shows = shows.filter(s => isStillActive(s, today));
  const after = shows.length;

  const output = {
    updatedAt: new Date().toISOString(),
    shows
  };

  await fs.writeFile(FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`[update-concerts] ${today} | ${before} → ${after} shows`);
}

main().catch(err => {
  console.error('[update-concerts] Failed:', err);
  process.exit(1);
});
