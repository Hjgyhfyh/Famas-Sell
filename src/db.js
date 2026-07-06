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
CREATE TABLE IF NOT EXISTS sale_log_msgs(
  message_id INTEGER PRIMARY KEY, chat_id TEXT, delete_at INTEGER);
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
  migrate();
  return db;
}

/** Есть ли колонка в таблице — для идемпотентных миграций (PRAGMA table_info). */
function columnExists(table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return Array.isArray(cols) && cols.some((c) => c && c.name === column);
}

/**
 * Идемпотентные миграции схемы (SPEC-FREE §2). ALTER выполняется только если
 * колонки ещё нет — на уже существующей БД ничего не ломает и не падает.
 */
function migrate() {
  if (!columnExists('users', 'free_regions')) {
    db.exec('ALTER TABLE users ADD COLUMN free_regions INTEGER DEFAULT 0');
  }
  if (!columnExists('orders', 'free_applied')) {
    db.exec('ALTER TABLE orders ADD COLUMN free_applied INTEGER DEFAULT 0');
  }
  // SPEC-QTY §2: количество серверов на регион (JSON-объект {iso:count}); NULL у старых
  // заказов → трактуется buildSub как «все серверы региона» (обратная совместимость).
  if (!columnExists('orders', 'qty')) {
    db.exec('ALTER TABLE orders ADD COLUMN qty TEXT');
  }
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

/* ───────────────── бесплатные регионы (скидка, SPEC-FREE §3) ───────────────── */

/** Текущий пул бесплатных регионов юзера; 0 если юзера нет. */
function getFree(userId) {
  const row = stmt('SELECT free_regions FROM users WHERE id=?').get(Number(userId));
  return row ? Number(row.free_regions) || 0 : 0;
}

/**
 * Установить пул (SET, не add). Апсертит user-строку при отсутствии
 * (first_seen/last_seen=now если создаём). Значение не ниже 0. Возвращает установленное.
 */
function setFree(userId, n) {
  const id = Number(userId);
  const val = Math.max(0, Math.floor(Number(n) || 0));
  const t = now();
  stmt(
    `INSERT INTO users(id, free_regions, first_seen, last_seen)
     VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET free_regions=excluded.free_regions`
  ).run(id, val, t, t);
  return val;
}

/** Прибавить к пулу (может быть отрицательным); итог не ниже 0. Возвращает новое значение. */
function addFree(userId, delta) {
  const next = getFree(userId) + Math.floor(Number(delta) || 0);
  return setFree(userId, next);
}

/** Списать min(текущее, max(0,n)); вернуть фактически списанное. Не создаёт юзера. */
function consumeFree(userId, n) {
  const id = Number(userId);
  const take = Math.min(getFree(id), Math.max(0, Math.floor(Number(n) || 0)));
  if (take > 0) {
    stmt('UPDATE users SET free_regions = free_regions - ? WHERE id=?').run(take, id);
  }
  return take;
}

/** Юзеры с непустым пулом бесплатных регионов, по убыванию. */
function usersWithFree() {
  return stmt(
    `SELECT id, username, first_name, free_regions FROM users
      WHERE free_regions > 0 ORDER BY free_regions DESC, id ASC`
  ).all();
}

/** Поиск юзера по @username (регистронезависимо, ведущий '@' игнорируется). */
function findUserByUsername(name) {
  let s = String(name == null ? '' : name).trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (!s) return null;
  return (
    stmt(
      `SELECT * FROM users WHERE username IS NOT NULL AND lower(username)=lower(?)
        ORDER BY last_seen DESC LIMIT 1`
    ).get(s) || null
  );
}

/* ─────────────── qtyMap: нормализация и расчёт (SPEC-QTY §1/§3) ─────────────── */

/**
 * Строгая нормализация ввода заказа в Map<iso,count> (SPEC-QTY §3).
 * Принимает {iso:count} | Map | массив ISO (тогда каждый count=1).
 * БРОСАЕТ Error на некорректный ISO / count<1 / пустой заказ (server → 400).
 */
function normalizeQtyStrict(input) {
  const map = new Map();
  const add = (isoRaw, countRaw) => {
    const iso = String(isoRaw == null ? '' : isoRaw).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso)) throw new Error('Некорректный код региона: ' + isoRaw);
    const count = Math.floor(Number(countRaw));
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('Некорректное количество серверов для ' + iso);
    }
    map.set(iso, (map.get(iso) || 0) + count);
  };
  if (Array.isArray(input)) {
    for (const iso of input) add(iso, 1);
  } else if (input instanceof Map) {
    for (const [iso, count] of input) add(iso, count);
  } else if (input && typeof input === 'object') {
    for (const [iso, count] of Object.entries(input)) add(iso, count);
  } else {
    throw new Error('Выбери хотя бы один регион');
  }
  if (map.size === 0) throw new Error('Выбери хотя бы один регион');
  return map;
}

/**
 * Мягкая нормализация в Map<iso,count> — для выдачи (configsForRegionsQty):
 * структурно битые записи молча пропускаются, ошибок не бросает.
 */
function normalizeQtyLenient(input) {
  const map = new Map();
  const add = (isoRaw, countRaw) => {
    const iso = String(isoRaw == null ? '' : isoRaw).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso)) return;
    const count = Math.floor(Number(countRaw));
    if (!Number.isFinite(count) || count < 1) return;
    map.set(iso, (map.get(iso) || 0) + count);
  };
  if (Array.isArray(input)) {
    for (const iso of input) add(iso, 1);
  } else if (input instanceof Map) {
    for (const [iso, count] of input) add(iso, count);
  } else if (input && typeof input === 'object') {
    for (const [iso, count] of Object.entries(input)) add(iso, count);
  }
  return map;
}

/** Map<iso, кол-во активных серверов> — «available» для валидации qty. */
function availabilityMap() {
  const map = new Map();
  const rows = stmt(
    `SELECT country_iso AS iso, COUNT(*) AS count FROM configs WHERE active=1 GROUP BY country_iso`
  ).all();
  for (const r of rows) map.set(r.iso, Number(r.count) || 0);
  return map;
}

/**
 * Чистый расчёт стоимости заказа по qtyMap (без учёта free) с ВАЛИДАЦИЕЙ.
 * Бросает Error при некорректном ISO/count или count>available.
 * -> {map, base, extra, totalCost, servers, regionsCount}
 *   totalCost = Σ по регионам (base + extra*(count-1)); servers = Σcount.
 */
function computeQtyCost(input) {
  const map = normalizeQtyStrict(input); // бросит на битом вводе/пустоте
  const base = priceStars();
  const extra = extraStars();
  const avail = availabilityMap();
  let totalCost = 0;
  let servers = 0;
  for (const [iso, count] of map) {
    const a = avail.get(iso) || 0;
    if (a <= 0) throw new Error('Регион недоступен: ' + iso);
    if (count > a) throw new Error('Для ' + iso + ': доступно ' + a + ', запрошено ' + count);
    totalCost += base + extra * (count - 1);
    servers += count;
  }
  return { map, base, extra, totalCost, servers, regionsCount: map.size };
}

/**
 * Единый ЧИСТЫЙ расчёт цены заказа со скидкой (SPEC-QTY §3, SPEC-FREE §7b) —
 * для отображения/превью (бот shopView, mini app). НИЧЕГО не списывает.
 * quoteOrder(userId, qtyMap) ->
 *   {base, extra, totalCost, regionsCount, freeAvail, freeUsed, discount, stars, fullyFree, servers}
 *   qtyMap = {iso:count} | массив ISO (каждый count=1).
 *   freeUsed = min(getFree, regionsCount); discount = freeUsed*base;
 *   stars = max(0, totalCost - discount); fullyFree = stars===0 && regionsCount>0.
 */
function quoteOrder(userId, qtyMap) {
  const c = computeQtyCost(qtyMap); // валидация (бросит Error при нарушении)
  const freeAvail = getFree(userId);
  const freeUsed = Math.min(freeAvail, c.regionsCount);
  const discount = freeUsed * c.base;
  const stars = Math.max(0, c.totalCost - discount);
  return {
    base: c.base,
    extra: c.extra,
    totalCost: c.totalCost,
    regionsCount: c.regionsCount,
    freeAvail,
    freeUsed,
    discount,
    stars,
    fullyFree: stars === 0 && c.regionsCount > 0,
    servers: c.servers,
  };
}

/**
 * АТОМАРНОЕ оформление заказа со скидкой (SPEC-QTY §3, SPEC-FREE §7b) — закрывает
 * абьюз частичной скидки. В отличие от quoteOrder (чистый), reserveOrder СПИСЫВАЕТ
 * free СРАЗУ, в ОДНОЙ транзакции, и возвращает по-настоящему применённое.
 * Валидация qtyMap — ДО транзакции: ошибка не списывает free. Звать только
 * В МОМЕНТ создания заказа.
 * reserveOrder(userId, qtyMap) ->
 *   {base, extra, totalCost, regionsCount, freeUsed, discount, stars, fullyFree, servers}
 */
function reserveOrder(userId, qtyMap) {
  const c = computeQtyCost(qtyMap); // валидация ДО транзакции (бросит → free не тронут)
  const tx = db.transaction(() => {
    const freeUsed = consumeFree(userId, Math.min(getFree(userId), c.regionsCount));
    const discount = freeUsed * c.base;
    const stars = Math.max(0, c.totalCost - discount);
    return {
      base: c.base,
      extra: c.extra,
      totalCost: c.totalCost,
      regionsCount: c.regionsCount,
      freeUsed,
      discount,
      stars,
      fullyFree: stars === 0 && c.regionsCount > 0,
      servers: c.servers,
    };
  });
  return tx();
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

/** Доплата за каждый доп. сервер того же региона (SPEC-QTY §1/§3). 0 допустимо. */
function extraStars() {
  const n = parseInt(getSetting('extra_stars', config.EXTRA_STARS), 10);
  return Number.isFinite(n) && n >= 0 ? n : config.EXTRA_STARS;
}

/** Установить доплату за доп. сервер (для /admin). Не ниже 0. */
function setExtra(n) {
  setSetting('extra_stars', String(Math.max(0, Math.floor(Number(n) || 0))));
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

/* ─────────────── популярность регионов (SPEC-QTY §4) ─────────────── */

// Вес одной продажи (заказ paid/gift/FREE, где регион присутствует).
const W_SALE = 10;

// Базовый статичный вес топ-локаций (VPN-аудитория РФ/Европа), 0..100 — чтобы при
// нуле продаж сортировка «Популярные» была осмысленной. Значения ориентировочные.
const REGION_WEIGHT = {
  NL: 95, DE: 92, FI: 88, SE: 82, US: 80, FR: 74, GB: 72, LV: 70,
  LT: 68, PL: 66, EE: 64, CH: 60, AT: 55, ES: 50, TR: 48, UA: 42, KZ: 40,
};

/**
 * regionPopularity() -> Map<iso, int> — вес = salesCount(iso)*W_SALE + REGION_WEIGHT[iso].
 * salesCount читается из orders (JSON regions) в JS: за каждый заказ status IN ('paid','gift')
 * (FREE-заказы создаются как paid, тоже учитываются), где регион присутствует, +W_SALE.
 */
function regionPopularity() {
  const map = new Map();
  for (const iso of Object.keys(REGION_WEIGHT)) map.set(iso, REGION_WEIGHT[iso]);
  let rows = [];
  try {
    rows = stmt(`SELECT regions FROM orders WHERE status IN ('paid','gift')`).all();
  } catch (e) {
    rows = [];
  }
  for (const row of rows) {
    let isos = [];
    try {
      const a = JSON.parse(row.regions || '[]');
      if (Array.isArray(a)) isos = a;
    } catch (e) {
      isos = [];
    }
    const seen = new Set();
    for (const raw of isos) {
      const iso = String(raw || '').trim().toUpperCase();
      if (!iso || seen.has(iso)) continue; // регион учитываем один раз на заказ
      seen.add(iso);
      map.set(iso, (map.get(iso) || 0) + W_SALE);
    }
  }
  return map;
}

/**
 * сводка активных регионов (SPEC-QTY §3): [{iso,name,nameRu,flag,count,popularity}],
 * порядок — по nameRu (канон SPEC §3; сортировки витрины делают бот/mini app поверх).
 */
function regionsSummary() {
  const pop = regionPopularity();
  const rows = stmt(
    `SELECT country_iso AS iso, MAX(country_name) AS name, MAX(flag) AS flag, COUNT(*) AS count
     FROM configs WHERE active=1 GROUP BY country_iso`
  ).all();
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({
      iso: r.iso,
      name: r.name || r.iso,
      nameRu: util.nameRuOf(r.iso, r.name),
      flag: r.flag || (r.iso && r.iso !== 'XX' ? util.isoToFlag(r.iso) : ''),
      count: r.count,
      popularity: pop.get(r.iso) || 0,
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

/**
 * configsForRegionsQty(qtyMap) -> [config...] (SPEC-QTY §5).
 * Для каждого региона РОВНО count серверов, ДЕТЕРМИНИРОВАННО (стабильно между вызовами):
 *   - активные конфиги региона сортируем по hash ASC, берём первые count;
 *   - если активных < count — добираем из fallback (неактивные, свежие по last_seen) до count;
 *   - если count > доступного (active+fallback) — вернуть сколько есть (подписка не пустеет).
 * qtyMap = {iso:count} | Map | массив ISO (count=1). Мягкая нормализация (не бросает).
 */
function configsForRegionsQty(qtyMap) {
  const map = normalizeQtyLenient(qtyMap);
  const out = [];
  const selActive = stmt(
    `SELECT * FROM configs WHERE active=1 AND country_iso=? ORDER BY hash ASC`
  );
  const selFallback = stmt(
    `SELECT * FROM configs WHERE active=0 AND country_iso=? ORDER BY last_seen DESC, hash ASC`
  );
  for (const [iso, count] of map) {
    if (count < 1) continue;
    const active = selActive.all(iso);
    let chosen = active.slice(0, count);
    if (chosen.length < count) {
      const need = count - chosen.length;
      const have = new Set(chosen.map((c) => c.hash));
      const fb = selFallback.all(iso).filter((c) => !have.has(c.hash)).slice(0, need);
      chosen = chosen.concat(fb);
    }
    for (const c of chosen) out.push(c);
  }
  return out;
}

/* ───────────────────── orders ───────────────────── */

/**
 * createOrder({userId, regions, stars, status='pending', days, freeApplied, chargeId, qty}) -> {id, token}
 * Для status 'paid'/'gift' сразу проставляются paid_at и expires_at (now + days*86400).
 * freeApplied (int, default 0) → orders.free_applied; chargeId (напр. 'FREE') → orders.charge_id.
 * qty ({iso:count} | Map | JSON-строка) → orders.qty (JSON); отсутствует → NULL (SPEC-QTY §3).
 */
function createOrder(opts) {
  const o = opts || {};
  const status = o.status || 'pending';
  const days = Number(o.days) > 0 ? Number(o.days) : subDays();
  const t = now();
  const token = util.genToken();
  const paidNow = status === 'paid' || status === 'gift';
  const regionsJson = typeof o.regions === 'string' ? o.regions : JSON.stringify(o.regions || []);
  const freeApplied = Math.max(0, Math.floor(Number(o.freeApplied) || 0));
  const chargeId = o.chargeId == null ? null : String(o.chargeId);

  // qty: {iso:count} → JSON; Map → объект → JSON; строка — как есть; пусто → NULL.
  let qtyJson = null;
  if (o.qty != null) {
    if (typeof o.qty === 'string') {
      qtyJson = o.qty;
    } else if (o.qty instanceof Map) {
      qtyJson = JSON.stringify(Object.fromEntries(o.qty));
    } else if (typeof o.qty === 'object') {
      qtyJson = JSON.stringify(o.qty);
    }
  }

  const info = stmt(
    `INSERT INTO orders(user_id, regions, stars, status, token, charge_id, created_at, paid_at, expires_at, free_applied, qty)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Number(o.userId) || 0,
    regionsJson,
    Number(o.stars) || 0,
    status,
    token,
    chargeId,
    t,
    paidNow ? t : null,
    paidNow ? t + days * 86400 : null,
    freeApplied,
    qtyJson
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

/* ─── персистентная очередь самоудаления сообщений о покупке (SPEC-LOG §7b) ─── */

/**
 * Поставить сообщение о покупке в очередь удаления (переживает рестарт бота).
 * message_id — PRIMARY KEY (upsert по нему); chat_id — TEXT; delete_at — unix-секунды.
 * Всё в try/catch: очередь никогда не роняет оплату/выдачу/логирование.
 */
function addSaleMsg(messageId, chatId, deleteAt) {
  try {
    stmt(
      `INSERT INTO sale_log_msgs(message_id, chat_id, delete_at) VALUES(?,?,?)
       ON CONFLICT(message_id) DO UPDATE SET chat_id=excluded.chat_id, delete_at=excluded.delete_at`
    ).run(Number(messageId), String(chatId), Math.floor(Number(deleteAt) || 0));
  } catch (e) {
    // не критично — сообщение просто не попадёт в очередь удаления
  }
}

/** Сообщения, у которых срок вышел (delete_at <= nowSec). Пустой массив при сбое. */
function dueSaleMsgs(nowSec) {
  try {
    return stmt(
      'SELECT message_id, chat_id, delete_at FROM sale_log_msgs WHERE delete_at <= ? ORDER BY delete_at ASC'
    ).all(Math.floor(Number(nowSec) || 0));
  } catch (e) {
    return [];
  }
}

/** Убрать сообщение из очереди удаления (после успешного delete или not-found). */
function removeSaleMsg(messageId) {
  try {
    stmt('DELETE FROM sale_log_msgs WHERE message_id=?').run(Number(messageId));
  } catch (e) {
    // не критично
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
  getFree,
  setFree,
  addFree,
  consumeFree,
  usersWithFree,
  findUserByUsername,
  quoteOrder,
  reserveOrder,
  getSetting,
  setSetting,
  priceStars,
  subDays,
  extraStars,
  setExtra,
  upsertConfigs,
  regionsSummary,
  regionPopularity,
  configsForRegions,
  fallbackForRegions,
  configsForRegionsQty,
  createOrder,
  getOrder,
  getOrderByToken,
  markOrderPaid,
  setOrderStatus,
  ordersOfUser,
  statsSummary,
  logEvent,
  addSaleMsg,
  dueSaleMsgs,
  removeSaleMsg,
};
