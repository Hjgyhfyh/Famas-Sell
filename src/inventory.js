'use strict';
/**
 * src/inventory.js — загрузка источника VLESS-конфигов и синхронизация с БД.
 * SPEC §5: start(), refreshNow(), lastRefresh. Ошибки сети процесс НЕ роняют.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const util = require('./util');

const FETCH_TIMEOUT_MS = 30000;

/** {at:unix, ok:bool, total:int, error:string|null} — мутируется на месте каждым refreshNow */
const lastRefresh = { at: 0, ok: false, total: 0, error: null };

let timer = null;
let inflight = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** путь из file:-URL ('file:fixtures/x.txt', 'file:///C:/x.txt') */
function filePathFromUrl(url) {
  let p = String(url).slice('file:'.length);
  if (p.startsWith('//')) p = p.slice(2);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

async function loadSourceText() {
  if (config.SOURCE_URL.startsWith('file:')) {
    return fs.readFileSync(filePathFromUrl(config.SOURCE_URL), 'utf8');
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(config.SOURCE_URL, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'famas-shop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} от источника`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

async function doRefresh() {
  try {
    const text = await loadSourceText();
    const bodyHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const prevHash = db.getSetting('source_hash', '');

    let added = 0;
    let revived = 0;
    let deactivated = 0;
    let total = 0;
    let skipped = false;

    if (bodyHash === prevHash) {
      const s = db.statsSummary();
      if (s.activeConfigs > 0) {
        // контент не изменился — upsert пропускаем, lastRefresh всё равно обновим
        total = s.activeConfigs;
        skipped = true;
      }
    }

    if (!skipped) {
      const { configs } = util.parseSource(text);
      if (!configs.length) throw new Error('источник пуст: 0 конфигов после парсинга');
      const r = db.upsertConfigs(configs);
      added = r.added;
      revived = r.revived;
      deactivated = r.deactivated;
      total = r.total;
      db.setSetting('source_hash', bodyHash);
    }

    const regions = db.regionsSummary().length;

    lastRefresh.at = nowSec();
    lastRefresh.ok = true;
    lastRefresh.total = total;
    lastRefresh.error = null;

    const out = { ok: true, total, added, revived, deactivated, regions };
    db.logEvent('refresh', { ...out, skipped });
    return out;
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? `таймаут загрузки источника (${FETCH_TIMEOUT_MS / 1000}с)`
        : String((e && e.message) || e);

    lastRefresh.at = nowSec();
    lastRefresh.ok = false;
    lastRefresh.error = msg;
    // total не трогаем — оставляем последнее удачное значение

    try {
      db.logEvent('refresh', { ok: false, error: msg });
    } catch (e2) {
      // журнал не критичен
    }
    console.error(`[${new Date().toISOString()}] inventory: ошибка обновления: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** обновить прямо сейчас; параллельные вызовы склеиваются в один */
function refreshNow() {
  if (inflight) return inflight;
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** сразу refreshNow(), затем каждые FETCH_INTERVAL_MIN минут (unref) */
function start() {
  refreshNow().catch(() => {});
  const ms = Math.max(1, Number(config.FETCH_INTERVAL_MIN) || 10) * 60 * 1000;
  timer = setInterval(() => {
    refreshNow().catch(() => {});
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

module.exports = { start, refreshNow, lastRefresh };
