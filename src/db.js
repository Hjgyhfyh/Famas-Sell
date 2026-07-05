'use strict';
/**
 * src/db.js — better-sqlite3, WAL. Все функции синхронные.
 * Схема и экспорты — строго по SPEC §3.
 */
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const config = require('./config');
const util = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
  first_seen INTEGER, last_seen INTEGER, is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS configs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE, uri TEXT, host TEXT, port INTEGER,
  flag TEXT, country_iso TEXT, country_name TEXT, city TEXT, label TEXT,
  active INTEGER DEFAULT 1, first_seen INTEGER, last_seen INTEGER);
CREATE INDEX IF NOT EXISTS idx_configs_region ON configs(country_iso, active);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, regions TEXT,
  stars INTEGER, status TEXT DEFAULT 'pending',
  token TEXT UNIQUE, charge_id TEXT,
  created_at INTEGER, paid_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, data TEXT);
`;

let db = null;
const stmtCache = new Map();

const now = () => Math.floor(Date.now() / 1000);

function stmt(sql) {
  if (!db) throw new Error('db.init() ещё не вызван');
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** открыть БД (config.DB_PATH), WAL, создать таблицы */
function init() {
  if (db) return db;
  fs.mkdirSync(path.dirname(path.resolve(config.DB_PATH)), { recursive: true });
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/* ───────────────────── users ───────────────────── */

function upsertUser(u) {
  if (!u || !u.id) return;
  const t = now();
  const id = Number(u.id);
  const isAdmin = config.ADMIN_IDS.includes(id) ? 1 : 0;
  stmt(
    `INSERT INTO users(id, username, first_name, first_seen, last_seen, is_admin)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       username=excluded.username,
       first_name=excluded.first_name,
       last_seen=excluded.last_seen,
       is_admin=excluded.is_admin`
  ).run(id, u.username || null, u.first_name || null, t, t, isAdmin);
}

function getUser(id) {
  return stmt('SELECT * FROM users WHERE id=?').get(Number(id));
}

function allUserIds() {
  return stmt('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
}

/* ───────────────────── settings ───────────────────── */

function getSetting(key, def) {
  const row = stmt('SELECT value FROM settings WHERE key=?').get(String(key));
  if (row) return row.value;
  return def === undefined || def === null ? def : String(def);
}

function setSetting(key, value) {
  stmt(
    `INSERT INTO settings(key, value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(String(key), String(value));
}

function priceStars() {
  const n = parseInt(getSetting('price_stars', config.DEFAULT_PRICE_STARS), 10);
  return Number.isFinite(n) && n > 0 ? n : config.DEFAULT_PRICE_STARS;
}

function subDays() {
  const n = parseInt(getSetting('sub_days', config.DEFAULT_SUB_DAYS), 10);
  return Number.isFinite(n) && n > 0 ? n : config.DEFAULT_SUB_DAYS;
}

/* ───────────────────── configs ───────────────────── */

/**
 * upsertConfigs(parsed) -> {added, revived, deactivated, total}
 * parsed = массив из util.parseSource().configs. Одна транзакция:
 * новые hash → insert(active=1); существующие → active=1, last_seen=now, uri/label обновить;
 * hash, которых нет в parsed → active=0. total = активных после.
 */
function upsertConfigs(parsed) {
  const list = Array.isArray(parsed) ? parsed : [];
  const res = { added: 0, revived: 0, deactivated: 0, total: 0 };
  const t = now();

  const getByHash = stmt('SELECT id, active FROM configs WHERE hash=?');
  const insert = stmt(
    `INSERT INTO configs(hash, uri, host, port, flag, country_iso, country_name, city, label, active, first_seen, last_seen)
     VALUES(@hash,@uri,@host,@port,@flag,@countryIso,@countryName,@city,@label,1,@t,@t)`
  );
  const update = stmt(
    `UPDATE configs SET uri=@uri, host=@host, port=@port, flag=@flag, country_iso=@countryIso,
       country_name=@countryName, city=@city, label=@label, active=1, last_seen=@t
     WHERE hash=@hash`
  );
  const selActiveHashes = stmt('SELECT hash FROM configs WHERE active=1');
  const deactivate = stmt('UPDATE configs SET active=0 WHERE hash=?');
  const countActive = stmt('SELECT COUNT(*) AS c FROM configs WHERE active=1');

  const tx = db.transaction((items) => {
    const seen = new Set();
    for (const c of items) {
      if (!c || !c.hash || seen.has(c.hash)) continue;
      seen.add(c.hash);
      const params = {
        hash: c.hash,
        uri: c.uri || '',
        host: c.host || '',
        port: Number(c.port) || 0,
        flag: c.flag || '',
        countryIso: c.countryIso || 'XX',
        countryName: c.countryName || '',
        city: c.city || '',
        label: c.label || '',
        t,
      };
      const row = getByHash.get(c.hash);
      if (!row) {
        insert.run(params);
        res.added++;
      } else {
        if (row.active === 0) res.revived++;
        update.run(params);
      }
    }
    for (const r of selActiveHashes.all()) {
      if (!seen.has(r.hash)) {
        deactivate.run(r.hash);
        res.deactivated++;
      }
    }
    res.total = countActive.get().c;
  });

  tx(list);
  return res;
}

/** сводка активных регионов: [{iso,name,nameRu,flag,count}], сортировка по nameRu */
function regionsSummary() {
  const rows = stmt(
    `SELECT country_iso AS iso, MAX(country_name) AS name, MAX(flag) AS flag, COUNT(*) AS count
     FROM configs WHERE active=1 GROUP BY country_iso`
  ).all();
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({
      iso: r.iso,
      name: r.name || r.iso,
      nameRu: util.COUNTRY_RU[r.name] || r.name || r.iso,
      flag: r.flag || (r.iso && r.iso !== 'XX' ? util.isoToFlag(r.iso) : ''),
      count: r.count,
    }))
    .sort((a, b) => String(a.nameRu).localeCompare(String(b.nameRu), 'ru'));
}

/** активные конфиги указанных регионов, сорт. country_name, city */
function configsForRegions(isos) {
  const list = (Array.isArray(isos) ? isos : []).map((s) => String(s)).filter(Boolean);
  if (!list.length) return [];
  const ph = list.map(() => '?').join(',');
  return stmt(
    `SELECT * FROM configs WHERE active=1 AND country_iso IN (${ph}) ORDER BY country_name, city`
  ).all(...list);
}

/** для ISO без активных конфигов — по 1 самому свежему (max last_seen) неактивному */
function fallbackForRegions(isos) {
  const list = (Array.isArray(isos) ? isos : []).map((s) => String(s)).filter(Boolean);
  const out = [];
  for (const iso of list) {
    const hasActive = stmt('SELECT 1 AS x FROM configs WHERE active=1 AND country_iso=? LIMIT 1').get(iso);
    if (hasActive) continue;
    const row = stmt(
      'SELECT * FROM configs WHERE active=0 AND country_iso=? ORDER BY last_seen DESC LIMIT 1'
    ).get(iso);
    if (row) out.push(row);
  }
  return out;
}

/* ───────────────────── orders ───────────────────── */

/**
 * createOrder({userId, regions, stars, status='pending', days}) -> {id, token}
 * Для status 'paid'/'gift' сразу проставляются paid_at и expires_at (now + days*86400).
 */
function createOrder(opts) {
  const o = opts || {};
  const status = o.status || 'pending';
  const days = Number(o.days) > 0 ? Number(o.days) : subDays();
  const t = now();
  const token = util.genToken();
  const paidNow = status === 'paid' || status === 'gift';
  const regionsJson = typeof o.regions === 'string' ? o.regions : JSON.stringify(o.regions || []);

  const info = stmt(
    `INSERT INTO orders(user_id, regions, stars, status, token, charge_id, created_at, paid_at, expires_at)
     VALUES(?,?,?,?,?,NULL,?,?,?)`
  ).run(
    Number(o.userId) || 0,
    regionsJson,
    Number(o.stars) || 0,
    status,
    token,
    t,
    paidNow ? t : null,
    paidNow ? t + days * 86400 : null
  );
  return { id: Number(info.lastInsertRowid), token };
}

function getOrder(id) {
  return stmt('SELECT * FROM orders WHERE id=?').get(Number(id));
}

function getOrderByToken(token) {
  return stmt('SELECT * FROM orders WHERE token=?').get(String(token));
}

/** оплата: status='paid', paid_at=now, expires_at=now+subDays()*86400; возвращает заказ */
function markOrderPaid(id, chargeId) {
  const t = now();
  stmt(`UPDATE orders SET status='paid', charge_id=?, paid_at=?, expires_at=? WHERE id=?`).run(
    chargeId == null ? null : String(chargeId),
    t,
    t + subDays() * 86400,
    Number(id)
  );
  return getOrder(id);
}

function setOrderStatus(id, status) {
  stmt('UPDATE orders SET status=? WHERE id=?').run(String(status), Number(id));
}

/** заказы пользователя (paid|gift), новые сверху */
function ordersOfUser(userId) {
  return stmt(
    `SELECT * FROM orders WHERE user_id=? AND status IN ('paid','gift') ORDER BY id DESC`
  ).all(Number(userId));
}

/* ───────────────────── статистика и журнал ───────────────────── */

function statsSummary() {
  const users = stmt('SELECT COUNT(*) AS c FROM users').get().c;
  const ordersPaid = stmt(`SELECT COUNT(*) AS c FROM orders WHERE status='paid'`).get().c;
  const revenueStars = stmt(
    `SELECT COALESCE(SUM(stars),0) AS s FROM orders WHERE status='paid'`
  ).get().s;
  const activeConfigs = stmt('SELECT COUNT(*) AS c FROM configs WHERE active=1').get().c;
  const regionsCount = stmt(
    'SELECT COUNT(DISTINCT country_iso) AS c FROM configs WHERE active=1'
  ).get().c;

  // начало текущих суток по Москве (UTC+3, без переходов)
  const nowSec = now();
  const mskShift = 3 * 3600;
  const mskMidnight = Math.floor((nowSec + mskShift) / 86400) * 86400 - mskShift;
  const salesToday = stmt(
    `SELECT COUNT(*) AS c FROM orders WHERE status='paid' AND paid_at >= ?`
  ).get(mskMidnight).c;

  return { users, ordersPaid, revenueStars, activeConfigs, regionsCount, salesToday };
}

function logEvent(type, dataObj) {
  try {
    let data = '{}';
    try {
      data = JSON.stringify(dataObj == null ? {} : dataObj);
    } catch (e) {
      data = '{"error":"unserializable"}';
    }
    stmt('INSERT INTO events(ts, type, data) VALUES(?,?,?)').run(now(), String(type), data);
  } catch (e) {
    // журнал никогда не роняет работу
  }
}

module.exports = {
  init,
  get db() {
    return db;
  },
  upsertUser,
  getUser,
  allUserIds,
  getSetting,
  setSetting,
  priceStars,
  subDays,
  upsertConfigs,
  regionsSummary,
  configsForRegions,
  fallbackForRegions,
  createOrder,
  getOrder,
  getOrderByToken,
  markOrderPaid,
  setOrderStatus,
  ordersOfUser,
  statsSummary,
  logEvent,
};
