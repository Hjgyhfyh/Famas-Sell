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
  // SPEC-QUALITY §2: «живость» сервера. alive=1 — прошёл фильтр (не в блэклисте и доступен);
  // alive=0 — мусор/недоступен. DEFAULT 1: новые/существующие конфиги живы до первой проверки
  // (чтобы не пропадали мгновенно) — healthcheck сам расставит 0/1.
  if (!columnExists('configs', 'alive')) {
    db.exec('ALTER TABLE configs ADD COLUMN alive INTEGER DEFAULT 1');
  }
  // SPEC-REFERRAL §2: реферальная программа. bonus_stars — пул бонус-звёзд-скидки;
  // referred_by — кто пригласил (ставится один раз, NULL если сам); ref_count — сколько привёл;
  // orders.bonus_applied — сколько бонус-звёзд списано в заказе. columnExists-guard идемпотентен,
  // на уже существующей БД ничего не ломает.
  if (!columnExists('users', 'bonus_stars')) {
    db.exec('ALTER TABLE users ADD COLUMN bonus_stars INTEGER DEFAULT 0');
  }
  if (!columnExists('users', 'referred_by')) {
    db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER');
  }
  if (!columnExists('users', 'ref_count')) {
    db.exec('ALTER TABLE users ADD COLUMN ref_count INTEGER DEFAULT 0');
  }
  if (!columnExists('orders', 'bonus_applied')) {
    db.exec('ALTER TABLE orders ADD COLUMN bonus_applied INTEGER DEFAULT 0');
  }

  // SPEC-MERGE §2: объединённый ключ юзера. merged — включён ли режим объединения (0/1);
  // merged_token — стабильный токен объединённой подписки (генерится один раз при первом
  // включении, util.genToken; сохраняется при off — ссылка стабильна). columnExists-guard
  // идемпотентен: на существующей БД не падает и ничего не ломает (старые ключи работают).
  if (!columnExists('users', 'merged')) {
    db.exec('ALTER TABLE users ADD COLUMN merged INTEGER DEFAULT 0');
  }
  if (!columnExists('users', 'merged_token')) {
    db.exec('ALTER TABLE users ADD COLUMN merged_token TEXT');
  }

  // ── SPEC-SOURCES §4/§5/§6: категория списка, ротация healthcheck, гео ──
  // list_type конфига: 'black' (файлы 1..25) | 'white' (файл 26 — РФ-whitelist). DEFAULT 'black'
  // → все существующие строки становятся black, продажа/выдача по-старому (обратная совместимость).
  if (!columnExists('configs', 'list_type')) {
    db.exec("ALTER TABLE configs ADD COLUMN list_type TEXT DEFAULT 'black'");
  }
  // Заказ помнит, из какого пула собирать подписку (buildSub читает order.list_type).
  if (!columnExists('orders', 'list_type')) {
    db.exec("ALTER TABLE orders ADD COLUMN list_type TEXT DEFAULT 'black'");
  }
  // Время последней TCP-проверки (для ротации: самые давно проверенные — первыми). NULL = никогда.
  if (!columnExists('configs', 'alive_checked_at')) {
    db.exec('ALTER TABLE configs ADD COLUMN alive_checked_at INTEGER');
  }
  // Время последнего гео-обогащения (чтобы не резолвить один хост повторно). NULL = не пробовали.
  if (!columnExists('configs', 'geo_checked_at')) {
    db.exec('ALTER TABLE configs ADD COLUMN geo_checked_at INTEGER');
  }
  // Индекс под выборку каталога с учётом list_type (SPEC-SOURCES §4.3).
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_configs_region2 ON configs(list_type, country_iso, active, alive)'
  );

  // Разовая collapse+rehash-миграция старых строк на новый hash=sha256(host:port) (SPEC-SOURCES §3.4).
  migrateRehashConfigs();
}

/**
 * SPEC-SOURCES §3.4: разовая идемпотентная миграция существующих строк configs на новый
 * hash = sha256(canonicalKey) (раньше hash = sha256(uri)). Без неё первый мультиисточниковый
 * refresh массово деактивировал бы старые строки и вставлял новые (шумно). Миграция:
 *   1) гейт по settings-маркеру + пустой таблице (идемпотентность);
 *   2) копия БД перед деструктивной операцией (быстрый откат, SPEC-SOURCES §7);
 *   3) группировка всех строк по НОВОМУ hash; в каждой группе оставляем одну (max last_seen →
 *      active → alive → id), лишние удаляем (разрешение коллизии UNIQUE); хэши проставляем в два
 *      прохода (сначала временные, потом финальные) — чтобы не ловить транзиентный UNIQUE-конфликт.
 * Любой сбой не роняет старт: маркер не ставится, схема продолжает работать на старых хэшах.
 */
function migrateRehashConfigs() {
  try {
    if (getSetting('configs_rehash_v2', '') === '1') return; // уже мигрировано
  } catch (e) {
    return; // settings недоступны — отложим (в след. раз)
  }

  let count = 0;
  try {
    count = Number(stmt('SELECT COUNT(*) AS c FROM configs').get().c) || 0;
  } catch (e) {
    return;
  }
  if (count === 0) {
    // пустая БД (тесты/чистый старт): новые вставки уже используют новый hash — просто помечаем.
    try { setSetting('configs_rehash_v2', '1'); } catch (e) { /* не критично */ }
    return;
  }

  const includeUuid = !!config.DEDUP_INCLUDE_UUID;

  // Нужна ли работа? Если у всех строк hash уже == configHash(uri) — просто пометить.
  let rows;
  try {
    rows = stmt('SELECT id, hash, uri, host, port, active, alive, last_seen FROM configs').all();
  } catch (e) {
    return;
  }
  let needWork = false;
  const groups = new Map(); // newHash -> [row,...]
  for (const r of rows) {
    let nh;
    try {
      nh = util.configHash(r.uri, includeUuid);
    } catch (e) {
      nh = null;
    }
    if (!nh) nh = r.hash; // не смогли пересчитать — оставляем как есть
    if (nh !== r.hash) needWork = true;
    let arr = groups.get(nh);
    if (!arr) {
      arr = [];
      groups.set(nh, arr);
    } else {
      needWork = true; // коллизия по новому ключу → есть что схлопывать
    }
    arr.push(r);
  }
  if (!needWork) {
    try { setSetting('configs_rehash_v2', '1'); } catch (e) { /* не критично */ }
    return;
  }

  // Копия БД перед деструктивной миграцией (best-effort). Чекпойнт WAL для консистентной копии.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbFile = path.resolve(config.DB_PATH);
    if (fs.existsSync(dbFile)) {
      fs.copyFileSync(dbFile, dbFile + '.bak-rehash-' + Date.now());
    }
  } catch (e) {
    console.error('[db] rehash: не удалось сделать копию БД (продолжаю): ' + ((e && e.message) || e));
  }

  const setHash = stmt('UPDATE configs SET hash=? WHERE id=?');
  const del = stmt('DELETE FROM configs WHERE id=?');
  const tx = db.transaction(() => {
    const keepers = [];
    for (const [nh, list] of groups) {
      list.sort(
        (a, b) =>
          (Number(b.last_seen) || 0) - (Number(a.last_seen) || 0) ||
          (Number(b.active) || 0) - (Number(a.active) || 0) ||
          (Number(b.alive) || 0) - (Number(a.alive) || 0) ||
          (Number(b.id) || 0) - (Number(a.id) || 0)
      );
      const keeper = list[0];
      for (let i = 1; i < list.length; i++) del.run(list[i].id); // лишние дубли host:port — удаляем
      keepers.push({ id: keeper.id, nh, old: keeper.hash });
    }
    // проход 1: временные уникальные хэши (не 64-hex → не пересекутся с финальными sha256)
    for (const k of keepers) {
      if (k.old !== k.nh) setHash.run('tmp_' + k.id, k.id);
    }
    // проход 2: финальные канонические хэши (все различны — коллизий нет)
    for (const k of keepers) {
      if (k.old !== k.nh) setHash.run(k.nh, k.id);
    }
  });

  try {
    tx();
    setSetting('configs_rehash_v2', '1');
    console.log('[db] rehash-миграция configs → sha256(host:port) выполнена');
  } catch (e) {
    console.error('[db] rehash-миграция не удалась (оставляю старые хэши): ' + ((e && e.message) || e));
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

/* ────────── реферальная программа: бонус-звёзды (SPEC-REFERRAL §3) ────────── */

/** Текущий пул бонус-звёзд юзера; 0 если юзера нет. */
function getBonus(userId) {
  const row = stmt('SELECT bonus_stars FROM users WHERE id=?').get(Number(userId));
  return row ? Number(row.bonus_stars) || 0 : 0;
}

/**
 * Установить пул бонус-звёзд (SET). Апсертит user-строку при отсутствии
 * (first_seen/last_seen=now если создаём). Не ниже 0. Возвращает установленное. Внутренний.
 */
function setBonus(userId, n) {
  const id = Number(userId);
  const val = Math.max(0, Math.floor(Number(n) || 0));
  const t = now();
  stmt(
    `INSERT INTO users(id, bonus_stars, first_seen, last_seen)
     VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET bonus_stars=excluded.bonus_stars`
  ).run(id, val, t, t);
  return val;
}

/** Прибавить к пулу бонус-звёзд (может быть отрицательным); итог не ниже 0. Возвращает новое значение. */
function addBonus(userId, delta) {
  const next = getBonus(userId) + Math.floor(Number(delta) || 0);
  return setBonus(userId, next);
}

/** Списать min(текущее, max(0,n)) бонус-звёзд; вернуть фактически списанное. Не создаёт юзера. */
function consumeBonus(userId, n) {
  const id = Number(userId);
  const take = Math.min(getBonus(id), Math.max(0, Math.floor(Number(n) || 0)));
  if (take > 0) {
    stmt('UPDATE users SET bonus_stars = bonus_stars - ? WHERE id=?').run(take, id);
  }
  return take;
}

/** Реф-сводка юзера: {count:ref_count, bonus:bonus_stars, referredBy}. */
function refInfo(userId) {
  const row = stmt('SELECT ref_count, bonus_stars, referred_by FROM users WHERE id=?').get(
    Number(userId)
  );
  return {
    count: row ? Number(row.ref_count) || 0 : 0,
    bonus: row ? Number(row.bonus_stars) || 0 : 0,
    referredBy: row && row.referred_by != null ? Number(row.referred_by) : null,
  };
}

/**
 * Атрибутировать приглашение (SPEC-REFERRAL §3). Всё в ОДНОЙ транзакции.
 * credited=true (пригласившему +REF_BONUS_STARS бонуса, ref_count++, newUser.referred_by=inviter)
 * ТОЛЬКО если: inviterId!=newUserId; оба id валидны; у newUser ещё нет referred_by; newUser «новый»
 * (нет оплаченных/gift заказов). Иначе {credited:false, reason:'self'|'already'|'not_new'|'no_inviter'}.
 */
function attributeReferral(newUserId, inviterId) {
  const newId = Number(newUserId);
  const invId = Number(inviterId);
  if (!Number.isInteger(newId) || newId <= 0 || !Number.isInteger(invId) || invId <= 0) {
    return { credited: false, reason: 'no_inviter' };
  }
  if (invId === newId) {
    return { credited: false, reason: 'self' };
  }
  const bonus = Math.max(0, Math.floor(Number(config.REF_BONUS_STARS) || 0));
  const tx = db.transaction(() => {
    // уже реферился? (referred_by проставлен один раз) → повтор не проходит
    const nu = stmt('SELECT referred_by FROM users WHERE id=?').get(newId);
    if (nu && nu.referred_by != null) {
      return { credited: false, reason: 'already' };
    }
    // «новый» = нет оплаченных/gift заказов (существующего покупателя не приглашаем)
    const hasOrders = stmt(
      `SELECT 1 AS x FROM orders WHERE user_id=? AND status IN ('paid','gift') LIMIT 1`
    ).get(newId);
    if (hasOrders) {
      return { credited: false, reason: 'not_new' };
    }
    const t = now();
    // строка пригласившего — создать при отсутствии (не трогаем существующие поля)
    stmt(
      `INSERT INTO users(id, first_seen, last_seen) VALUES(?,?,?)
       ON CONFLICT(id) DO NOTHING`
    ).run(invId, t, t);
    // newUser.referred_by = inviter (строку создаём/обновляем, first_seen не перетираем)
    stmt(
      `INSERT INTO users(id, referred_by, first_seen, last_seen) VALUES(?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET referred_by=excluded.referred_by`
    ).run(newId, invId, t, t);
    // начислить пригласившему бонус и счётчик приглашённых
    stmt(
      'UPDATE users SET bonus_stars = COALESCE(bonus_stars,0) + ?, ref_count = COALESCE(ref_count,0) + 1 WHERE id=?'
    ).run(bonus, invId);
    return { credited: true, reason: 'ok' };
  });
  return tx();
}

/** Топ рефереров (SPEC-REFERRAL §3) — для /admin. [{id,username,ref_count,bonus_stars}]. */
function refLeaders(limit) {
  let lim = Math.floor(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) lim = 10;
  if (lim > 100) lim = 100;
  return stmt(
    `SELECT id, username, ref_count, bonus_stars FROM users
      WHERE ref_count > 0 ORDER BY ref_count DESC, bonus_stars DESC, id ASC LIMIT ?`
  ).all(lim);
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

/**
 * Map<iso, кол-во ЖИВЫХ серверов> — «available» для валидации qty (SPEC-QUALITY §3).
 * «Продаваемый» сервер = active=1 AND alive=1, поэтому потолок покупки — число живых
 * (совпадает с count из regionsSummary, чтобы клиент не мог заказать больше, чем выдадим).
 */
function availabilityMap(listType) {
  const lt = listType === 'white' ? 'white' : 'black';
  const map = new Map();
  const rows = stmt(
    `SELECT country_iso AS iso, COUNT(*) AS count FROM configs
      WHERE active=1 AND alive=1 AND list_type=? AND country_iso!='XX' GROUP BY country_iso`
  ).all(lt);
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
 * Единый ЧИСТЫЙ расчёт цены заказа со скидкой (SPEC-QTY §3, SPEC-FREE §7b, SPEC-REFERRAL §4) —
 * для отображения/превью (бот shopView, mini app). НИЧЕГО не списывает.
 * Порядок скидок: сначала free-регионы гасят base, затем бонус-звёзды гасят остаток.
 * quoteOrder(userId, qtyMap) -> {base, extra, totalCost, regionsCount, servers,
 *   freeAvail, freeUsed, discount(=discountFree), discountFree, bonusAvail, bonusUsed, stars, fullyFree}
 *   qtyMap = {iso:count} | массив ISO (каждый count=1).
 *   freeUsed = min(getFree, regionsCount); discountFree = freeUsed*base;
 *   afterFree = max(0, totalCost - discountFree); bonusUsed = min(getBonus, afterFree);
 *   stars = afterFree - bonusUsed; fullyFree = stars===0 && regionsCount>0.
 */
function quoteOrder(userId, qtyMap) {
  const c = computeQtyCost(qtyMap); // валидация (бросит Error при нарушении)
  const freeAvail = getFree(userId);
  const freeUsed = Math.min(freeAvail, c.regionsCount);
  const discountFree = freeUsed * c.base;
  const afterFree = Math.max(0, c.totalCost - discountFree);
  const bonusAvail = getBonus(userId);
  const bonusUsed = Math.min(bonusAvail, afterFree);
  const stars = afterFree - bonusUsed;
  return {
    base: c.base,
    extra: c.extra,
    totalCost: c.totalCost,
    regionsCount: c.regionsCount,
    servers: c.servers,
    freeAvail,
    freeUsed,
    discount: discountFree, // совместимость (SPEC-QTY §3): discount == free-часть скидки
    discountFree,
    bonusAvail,
    bonusUsed,
    stars,
    fullyFree: stars === 0 && c.regionsCount > 0,
  };
}

/**
 * АТОМАРНОЕ оформление заказа со скидкой (SPEC-QTY §3, SPEC-FREE §7b) — закрывает
 * абьюз частичной скидки. В отличие от quoteOrder (чистый), reserveOrder СПИСЫВАЕТ
 * free СРАЗУ, в ОДНОЙ транзакции, и возвращает по-настоящему применённое.
 * Валидация qtyMap — ДО транзакции: ошибка не списывает free. Звать только
 * В МОМЕНТ создания заказа.
 * Списывает И free (consumeFree) И бонус-звёзды (consumeBonus) по фактически доступному,
 * пересчитывает stars по реально применённому. Порядок скидок: free гасит base, затем бонус —
 * остаток (SPEC-REFERRAL §4). Возвращает то же, что quoteOrder, но без *Avail-полей.
 * reserveOrder(userId, qtyMap) -> {base, extra, totalCost, regionsCount, servers,
 *   freeUsed, discount(=discountFree), discountFree, bonusUsed, stars, fullyFree}
 */
function reserveOrder(userId, qtyMap) {
  const c = computeQtyCost(qtyMap); // валидация ДО транзакции (бросит → free/бонус не тронуты)
  const tx = db.transaction(() => {
    const freeUsed = consumeFree(userId, Math.min(getFree(userId), c.regionsCount));
    const discountFree = freeUsed * c.base;
    const afterFree = Math.max(0, c.totalCost - discountFree);
    // бонус гасит остаток; consumeBonus сам клампит до доступного и возвращает списанное
    const bonusUsed = consumeBonus(userId, afterFree);
    const stars = Math.max(0, afterFree - bonusUsed);
    return {
      base: c.base,
      extra: c.extra,
      totalCost: c.totalCost,
      regionsCount: c.regionsCount,
      servers: c.servers,
      freeUsed,
      discount: discountFree,
      discountFree,
      bonusUsed,
      stars,
      fullyFree: stars === 0 && c.regionsCount > 0,
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
 * upsertConfigs(parsed, opts) -> {added, revived, deactivated, total}
 * parsed = массив из util.parseSource().configs (или map.values() из util.mergeInto). Одна транзакция:
 * новые hash → insert(active=1); существующие → active=1, last_seen=now, uri/label/list_type обновить;
 * hash, которых нет в parsed → active=0 (реконсиляция). total = активных после.
 *
 * SPEC-SOURCES §4.2: list_type пишется из c.category ('white'|'black'); §3.5: логика не меняется.
 * SPEC-SOURCES §7 риск#1: opts.reconcile=false ОТКЛЮЧАЕТ деактивацию отсутствующих — вызывать при
 * частичном сбое источников, чтобы каталог не обнулялся (по умолчанию reconcile=true — как раньше).
 */
function upsertConfigs(parsed, opts) {
  const list = Array.isArray(parsed) ? parsed : [];
  const reconcile = !opts || opts.reconcile !== false;
  const res = { added: 0, revived: 0, deactivated: 0, total: 0 };
  const t = now();

  const getByHash = stmt('SELECT id, active FROM configs WHERE hash=?');
  const insert = stmt(
    `INSERT INTO configs(hash, uri, host, port, flag, country_iso, country_name, city, label, list_type, active, first_seen, last_seen)
     VALUES(@hash,@uri,@host,@port,@flag,@countryIso,@countryName,@city,@label,@listType,1,@t,@t)`
  );
  const update = stmt(
    `UPDATE configs SET uri=@uri, host=@host, port=@port, flag=@flag, country_iso=@countryIso,
       country_name=@countryName, city=@city, label=@label, list_type=@listType, active=1, last_seen=@t
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
        listType: c.category === 'white' ? 'white' : 'black',
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
    if (reconcile) {
      for (const r of selActiveHashes.all()) {
        if (!seen.has(r.hash)) {
          deactivate.run(r.hash);
          res.deactivated++;
        }
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
function regionsSummary(listType) {
  const lt = listType === 'white' ? 'white' : 'black';
  const pop = regionPopularity();
  // SPEC-QUALITY §3: регион считаем по живым серверам (active=1 AND alive=1);
  // регион с 0 живых не показывается и не продаётся. SPEC-SOURCES §4.3: с учётом list_type.
  const rows = stmt(
    `SELECT country_iso AS iso, MAX(country_name) AS name, MAX(flag) AS flag, COUNT(*) AS count
     FROM configs WHERE active=1 AND alive=1 AND list_type=? AND country_iso!='XX' GROUP BY country_iso`
  ).all(lt);
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

/** живые конфиги указанных регионов (active=1 AND alive=1, list_type), сорт. country_name, city */
function configsForRegions(isos, listType) {
  const lt = listType === 'white' ? 'white' : 'black';
  const list = (Array.isArray(isos) ? isos : []).map((s) => String(s)).filter(Boolean);
  if (!list.length) return [];
  const ph = list.map(() => '?').join(',');
  return stmt(
    `SELECT * FROM configs WHERE active=1 AND alive=1 AND list_type=? AND country_iso IN (${ph})
      ORDER BY country_name, city`
  ).all(lt, ...list);
}

/**
 * Крайний случай (SPEC-QUALITY §3): для ISO без ЖИВЫХ конфигов — по 1 самому свежему
 * (max last_seen) неактивному, чтобы подписка старого заказа не пустела. Приоритет —
 * всегда живым (configsForRegions), это только deep fallback.
 */
function fallbackForRegions(isos) {
  const list = (Array.isArray(isos) ? isos : []).map((s) => String(s)).filter(Boolean);
  const out = [];
  for (const iso of list) {
    const hasAlive = stmt(
      'SELECT 1 AS x FROM configs WHERE active=1 AND alive=1 AND country_iso=? LIMIT 1'
    ).get(iso);
    if (hasAlive) continue;
    const row = stmt(
      'SELECT * FROM configs WHERE active=0 AND country_iso=? ORDER BY last_seen DESC LIMIT 1'
    ).get(iso);
    if (row) out.push(row);
  }
  return out;
}

/**
 * configsForRegionsQty(qtyMap) -> [config...] (SPEC-QTY §5 + SPEC-HARDEN ч.1 §3).
 * Для каждого региона берём РОВНО min(count, aliveCount) СВЕЖИХ ЖИВЫХ серверов
 * (active=1 AND alive=1), сорт last_seen DESC затем hash ASC (свежие первыми, стабильный
 * тай-брейк). Мёртвые (alive=0) в подписку НЕ попадают НИКОГДА, кроме края «0 живых в
 * регионе» → deep-fallback (1 самый свежий неактивный), чтобы ссылка старого заказа не
 * пустела. Если живых < count — отдаём сколько есть живых (НЕ добираем мёртвыми): купленный
 * ключ всегда состоит только из доступных серверов, а «недостающие» подтянутся сами, когда
 * серверы региона оживут (клиент перечитает подписку).
 * qtyMap = {iso:count} | Map | массив ISO (count=1). Мягкая нормализация (не бросает).
 */
function configsForRegionsQty(qtyMap, listType) {
  const lt = listType === 'white' ? 'white' : 'black';
  const map = normalizeQtyLenient(qtyMap);
  const out = [];
  const selAlive = stmt(
    `SELECT * FROM configs WHERE active=1 AND alive=1 AND list_type=? AND country_iso=?
      ORDER BY last_seen DESC, hash ASC`
  );
  const selFallback = stmt(
    `SELECT * FROM configs WHERE active=0 AND list_type=? AND country_iso=?
      ORDER BY last_seen DESC, hash ASC LIMIT 1`
  );
  for (const [iso, count] of map) {
    if (count < 1) continue;
    const alive = selAlive.all(lt, iso);
    if (alive.length > 0) {
      const take = Math.min(count, alive.length); // ровно min(qty, aliveCount)
      for (let i = 0; i < take; i++) out.push(alive[i]);
    } else {
      // край: живых в регионе нет — 1 самый свежий неактивный (deep-fallback, как раньше)
      const fb = selFallback.get(lt, iso);
      if (fb) out.push(fb);
    }
  }
  return out;
}

/**
 * aliveCountForRegions(isos) -> Map<iso, число живых серверов> (SPEC-HARDEN ч.1 §3/§5).
 * Живой = active=1 AND alive=1. Для показа «сейчас в ключе N доступных серверов» в выдаче
 * бота, /api/key и /api/me. Регионы без живых в Map отсутствуют (считать как 0).
 */
function aliveCountForRegions(isos, listType) {
  const lt = listType === 'white' ? 'white' : 'black';
  const list = (Array.isArray(isos) ? isos : [])
    .map((s) => String(s == null ? '' : s).trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  const map = new Map();
  if (!list.length) return map;
  const uniq = [...new Set(list)];
  const ph = uniq.map(() => '?').join(',');
  const rows = stmt(
    `SELECT country_iso AS iso, COUNT(*) AS count FROM configs
      WHERE active=1 AND alive=1 AND list_type=? AND country_iso IN (${ph}) GROUP BY country_iso`
  ).all(lt, ...uniq);
  for (const r of rows) map.set(r.iso, Number(r.count) || 0);
  return map;
}

/* ─────────────── здоровье серверов: alive (SPEC-QUALITY §3/§4) ─────────────── */

/** Совпадает ли host с любой подстрокой блэклиста (lowercase-сравнение). */
function isBlacklistedHost(host) {
  const h = String(host == null ? '' : host).toLowerCase();
  if (!h) return false;
  const bl = config.HOST_BLACKLIST || [];
  for (const p of bl) {
    if (p && h.includes(p)) return true;
  }
  return false;
}

/**
 * hostsToCheck(limit) -> [{host, port}] — уникальные пары среди active=1 конфигов, исключая
 * заблэклисченные хосты и пустые host/port (для TCP-проверки живости, SPEC-QUALITY §4).
 * alive НЕ фильтруем: ранее «мёртвый» (недоступный) хост надо перепроверить — он мог ожить.
 *
 * SPEC-SOURCES §5.2: РОТАЦИЯ — самые давно проверенные первыми (ORDER BY alive_checked_at ASC,
 * NULLS FIRST: никогда не проверенные — в приоритете). limit>0 ограничивает батч; limit пуст/0 →
 * все (обратная совместимость: hostsToCheck() без аргумента возвращает всё, как раньше).
 */
function hostsToCheck(limit) {
  let lim = Math.floor(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) lim = 0;
  const base =
    `SELECT host, port, MIN(alive_checked_at) AS ck FROM configs
      WHERE active=1 AND host IS NOT NULL AND host<>'' AND port>0
      GROUP BY host, port ORDER BY (ck IS NULL) DESC, ck ASC`;
  const rows = lim > 0 ? stmt(base + ' LIMIT ?').all(lim) : stmt(base).all();
  const out = [];
  for (const r of rows) {
    if (isBlacklistedHost(r.host)) continue;
    out.push({ host: String(r.host), port: Number(r.port) || 0 });
  }
  return out;
}

/**
 * Проставить alive всем конфигам с данным host:port + отметить время проверки (alive_checked_at)
 * для ротации (SPEC-SOURCES §5.2). Возвращает число затронутых строк.
 */
function setAliveByHostPort(host, port, alive) {
  const a = alive ? 1 : 0;
  const info = stmt('UPDATE configs SET alive=?, alive_checked_at=? WHERE host=? AND port=?').run(
    a,
    now(),
    String(host == null ? '' : host),
    Number(port) || 0
  );
  return info.changes;
}

/**
 * hostsForGeo(limit) -> [host,...] — уникальные хосты active=1 конфигов, у которых страна ещё XX
 * и гео не пробовали (geo_checked_at IS NULL) (SPEC-SOURCES §6.2). Батч limit (дефолт 2000).
 */
function hostsForGeo(limit) {
  let lim = Math.floor(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) lim = 2000;
  const rows = stmt(
    `SELECT DISTINCT host FROM configs
      WHERE active=1 AND host IS NOT NULL AND host<>''
        AND (country_iso IS NULL OR country_iso='' OR country_iso='XX')
        AND geo_checked_at IS NULL
      LIMIT ?`
  ).all(lim);
  return rows.map((r) => String(r.host));
}

/**
 * setGeo(host, iso) (SPEC-SOURCES §6.2) — гео-обогащение по IP заполняет страну ТОЛЬКО у XX-строк
 * данного хоста (валидный флаг/имя из фрагмента не трогаем — уважаем явную метку). Флаг ставим,
 * если пуст. В любом случае отмечаем geo_checked_at=now (чтобы не резолвить один хост повторно,
 * даже если lookup ничего не дал). iso пустой/XX → только отметка времени. Возвращает число строк.
 */
function setGeo(host, iso) {
  const h = String(host == null ? '' : host);
  if (!h) return 0;
  const code = String(iso == null ? '' : iso).trim().toUpperCase();
  const t = now();
  if (/^[A-Z]{2}$/.test(code) && code !== 'XX') {
    const flag = util.isoToFlag(code) || '';
    const info = stmt(
      `UPDATE configs SET country_iso=?,
         flag=CASE WHEN flag IS NULL OR flag='' THEN ? ELSE flag END,
         geo_checked_at=?
       WHERE host=? AND (country_iso IS NULL OR country_iso='' OR country_iso='XX')`
    ).run(code, flag, t, h);
    return info.changes;
  }
  // lookup не дал страны — просто отметим, что пробовали (не долбим DNS повторно)
  const info = stmt(
    `UPDATE configs SET geo_checked_at=?
      WHERE host=? AND (country_iso IS NULL OR country_iso='' OR country_iso='XX')`
  ).run(t, h);
  return info.changes;
}

/**
 * setAliveByHostPattern(pattern, alive) — проставить alive всем, где host LIKE %pattern%
 * (для блэклиста). LIKE в SQLite регистронезависим для ASCII. Возвращает число строк.
 */
function setAliveByHostPattern(pattern, alive) {
  const p = String(pattern == null ? '' : pattern).trim();
  if (!p) return 0;
  const a = alive ? 1 : 0;
  const like = '%' + p.replace(/[\\%_]/g, '\\$&') + '%';
  const info = stmt(`UPDATE configs SET alive=? WHERE host LIKE ? ESCAPE '\\'`).run(a, like);
  return info.changes;
}

/**
 * aliveStats() -> {active, alive, deadBlacklist, deadUnreachable} (SPEC-QUALITY §3).
 * active — всего активных; alive — из них живых; мёртвые (active=1,alive=0) классифицируем
 * по host: в блэклисте → deadBlacklist, иначе → deadUnreachable (не прошли TCP).
 */
function aliveStats() {
  const active = Number(stmt('SELECT COUNT(*) AS c FROM configs WHERE active=1').get().c) || 0;
  const alive =
    Number(stmt('SELECT COUNT(*) AS c FROM configs WHERE active=1 AND alive=1').get().c) || 0;
  const dead = stmt('SELECT host FROM configs WHERE active=1 AND alive=0').all();
  let deadBlacklist = 0;
  for (const r of dead) {
    if (isBlacklistedHost(r.host)) deadBlacklist++;
  }
  const deadUnreachable = dead.length - deadBlacklist;
  return { active, alive, deadBlacklist, deadUnreachable };
}

/* ───────────────────── orders ───────────────────── */

/**
 * createOrder({userId, regions, stars, status='pending', days, freeApplied, bonusApplied, chargeId, qty}) -> {id, token}
 * Для status 'paid'/'gift' сразу проставляются paid_at и expires_at (now + days*86400).
 * freeApplied (int, default 0) → orders.free_applied; bonusApplied (int, default 0, SPEC-REFERRAL §3)
 * → orders.bonus_applied; chargeId (напр. 'FREE') → orders.charge_id.
 * qty ({iso:count} | Map | JSON-строка) → orders.qty (JSON); отсутствует → NULL (SPEC-QTY §3).
 * listType ('black'|'white', SPEC-SOURCES §4.4) → orders.list_type; дефолт 'black' (совместимость):
 * buildSub собирает подписку из этого пула.
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
  const bonusApplied = Math.max(0, Math.floor(Number(o.bonusApplied) || 0));
  const chargeId = o.chargeId == null ? null : String(o.chargeId);
  const listType = o.listType === 'white' ? 'white' : 'black';

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
    `INSERT INTO orders(user_id, regions, stars, status, token, charge_id, created_at, paid_at, expires_at, free_applied, qty, bonus_applied, list_type)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    qtyJson,
    bonusApplied,
    listType
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

/* ─────────────── объединённый ключ (SPEC-MERGE §3/§4) ─────────────── */

/** orders.regions (JSON-массив ISO) → массив строк (пустой при сбое). Внутренний. */
function parseRegionsColumn(val) {
  if (Array.isArray(val)) return val.filter((x) => typeof x === 'string');
  try {
    const a = JSON.parse(val || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

/** orders.qty ({iso:count} JSON) → объект или null (старый заказ без qty). Внутренний. */
function parseQtyColumn(val) {
  if (val == null) return null;
  let o = val;
  if (typeof val === 'string') {
    try { o = JSON.parse(val); } catch (e) { return null; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return Object.keys(o).length ? o : null;
}

/**
 * liveRowsForOrder(order) -> [config...] — РОВНО то, что попадёт в индивидуальную подписку заказа
 * (SPEC §6 + SPEC-QTY §5): заказ с qty → configsForRegionsQty; старый (qty NULL) → configsForRegions
 * + fallback. Пул — order.list_type (дефолт 'black'). Единый источник истины для buildSub и
 * объединённого ключа (объединённый = дедуп(объединение индивидуальных подписок)).
 */
function liveRowsForOrder(order) {
  if (!order) return [];
  const listType = order.list_type === 'white' ? 'white' : 'black';
  const qty = parseQtyColumn(order.qty);
  if (qty) return configsForRegionsQty(qty, listType);
  const regions = parseRegionsColumn(order.regions);
  return configsForRegions(regions, listType).concat(fallbackForRegions(regions));
}

/** Канонический ключ сервера для дедупа объединённого ключа: host:port:uuid (SPEC-MERGE §4). */
function serverKeyOf(row) {
  const a = util.parseAuthority(row && row.uri);
  const host = (row && row.host) || a.host;
  const port = (row && row.port) || a.port;
  return util.canonicalKey(host, port, a.uuid, true);
}

/**
 * activeOrdersOf(userId) -> [order...] (SPEC-MERGE §3). Выданные заказы (paid|gift; FREE — как paid,
 * т.к. создаётся со status='paid') с НЕ вышедшим сроком (now<=expires_at). Свежие сверху (id DESC).
 */
function activeOrdersOf(userId) {
  const t = now();
  return stmt(
    `SELECT * FROM orders WHERE user_id=? AND status IN ('paid','gift')
       AND expires_at IS NOT NULL AND expires_at >= ? ORDER BY id DESC`
  ).all(Number(userId), t);
}

/**
 * Ядро объединённого ключа (SPEC-MERGE §1/§4). Все АКТИВНЫЕ заказы юзера → их живые серверы, дедуп
 * по host:port:uuid; владелец дубля — заказ с МАКС сроком (метка «до DD.MM» и жизнь сервера считаются
 * по самому долгому активному заказу). Возвращает данные и для подписки, и для профиля/страницы:
 *   { orders:N, servers:N(дедуп-живых), expiresMax, rows:[{row, expiresAt}],
 *     regions:[{iso,nameRu,flag,qty,liveServers,expiresAt}] }
 * rows — по убыванию срока-владельца (стабильно); regions — по nameRu. Пусто, если активных нет.
 */
function mergedBundle(userId) {
  const active = activeOrdersOf(userId);
  const expiresMax = active.reduce((m, o) => Math.max(m, Number(o.expires_at) || 0), 0);
  // от самого «долгого» заказа к короткому → первый встреченный дубль = макс срок
  const ordered = active
    .slice()
    .sort(
      (a, b) =>
        (Number(b.expires_at) || 0) - (Number(a.expires_at) || 0) ||
        (Number(b.id) || 0) - (Number(a.id) || 0)
    );

  const seen = new Set();
  const rows = [];
  const regAgg = new Map(); // iso -> {iso,nameRu,flag,qty,liveServers,expiresAt}
  const ensureReg = (iso, sample) => {
    let ra = regAgg.get(iso);
    if (!ra) {
      ra = {
        iso,
        nameRu: util.nameRuOf(iso, sample && sample.country_name),
        flag: (sample && sample.flag) || (iso && iso !== 'XX' ? util.isoToFlag(iso) : ''),
        qty: 0,
        liveServers: 0,
        expiresAt: 0,
      };
      regAgg.set(iso, ra);
    }
    return ra;
  };

  for (const o of ordered) {
    const exp = Number(o.expires_at) || 0;
    const live = liveRowsForOrder(o);
    const qtyMap = parseQtyColumn(o.qty);

    // купленное ×N по региону (для разбивки) — суммируем по всем активным заказам юзера
    if (qtyMap) {
      for (const [isoRaw, c] of Object.entries(qtyMap)) {
        const iso = String(isoRaw || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(iso)) continue;
        const ra = ensureReg(iso, live.find((r) => r.country_iso === iso));
        ra.qty += Math.max(0, Math.floor(Number(c) || 0));
        ra.expiresAt = Math.max(ra.expiresAt, exp);
      }
    } else {
      const byIso = new Map();
      for (const row of live) byIso.set(row.country_iso, (byIso.get(row.country_iso) || 0) + 1);
      for (const [iso, c] of byIso) {
        const ra = ensureReg(iso, live.find((r) => r.country_iso === iso));
        ra.qty += c;
        ra.expiresAt = Math.max(ra.expiresAt, exp);
      }
    }

    // живые серверы — дедуп по host:port:uuid ЧЕРЕЗ ВСЕ заказы
    for (const row of live) {
      const key = serverKeyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ row, expiresAt: exp });
      const iso = row.country_iso || 'XX';
      const ra = ensureReg(iso, row);
      ra.liveServers += 1;
      ra.expiresAt = Math.max(ra.expiresAt, exp);
    }
  }

  const regions = [...regAgg.values()].sort((a, b) =>
    String(a.nameRu).localeCompare(String(b.nameRu), 'ru')
  );
  return { orders: active.length, servers: rows.length, expiresMax, rows, regions };
}

/**
 * mergedSummary(userId) -> {regions, servers, expiresMax, orders} (SPEC-MERGE §3) — для профиля/
 * страницы. servers — дедуп-живых; expiresMax — макс срок активных заказов; regions с купленным qty,
 * числом живых серверов и своим сроком.
 */
function mergedSummary(userId) {
  const b = mergedBundle(userId);
  return { regions: b.regions, servers: b.servers, expiresMax: b.expiresMax, orders: b.orders };
}

/** Занят ли токен (среди order-токенов или чужих merged_token) — защита от коллизии при генерации. */
function mergedTokenTaken(token) {
  if (stmt('SELECT 1 AS x FROM orders WHERE token=? LIMIT 1').get(token)) return true;
  if (stmt('SELECT 1 AS x FROM users WHERE merged_token=? LIMIT 1').get(token)) return true;
  return false;
}

/**
 * setMerged(userId, on) -> {merged, token} (SPEC-MERGE §3). on=true → merged=1 и, если merged_token
 * ещё нет, сгенерить СТАБИЛЬНЫЙ токен (util.genToken; не меняется при повторных on/off). on=false →
 * merged=0, токен ОСТАВИТЬ (ссылка стабильна). Апсертит user-строку при отсутствии.
 */
function setMerged(userId, on) {
  const id = Number(userId);
  const t = now();
  stmt(
    `INSERT INTO users(id, first_seen, last_seen) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`
  ).run(id, t, t);
  const row = stmt('SELECT merged_token FROM users WHERE id=?').get(id);
  let token = row && row.merged_token ? String(row.merged_token) : '';
  if (on) {
    if (!token) {
      do {
        token = util.genToken();
      } while (mergedTokenTaken(token));
    }
    stmt('UPDATE users SET merged=1, merged_token=? WHERE id=?').run(token, id);
    return { merged: 1, token };
  }
  stmt('UPDATE users SET merged=0 WHERE id=?').run(id);
  return { merged: 0, token: token || null };
}

/** getUserByMergedToken(token) -> user|null (SPEC-MERGE §3) — резолвинг объединённой ссылки /s/:token. */
function getUserByMergedToken(token) {
  const t = String(token == null ? '' : token);
  if (!t) return null;
  return stmt('SELECT * FROM users WHERE merged_token=? LIMIT 1').get(t) || null;
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

/* ─────────────── админка «кто что купил» (SPEC-ADMIN §3) ─────────────── */

/**
 * Дополнительная сводка для админ-панели (SPEC-ADMIN §2). Аддитивно, ничего не меняет.
 *   uniqueBuyers — DISTINCT user_id по выданным заказам (paid|gift);
 *   ordersTotal  — всего выданных заказов (paid|gift);
 *   freeActive   — сумма непотраченных бесплатных регионов по всем юзерам.
 */
function adminSummary() {
  const uniqueBuyers = stmt(
    `SELECT COUNT(DISTINCT user_id) AS c FROM orders WHERE status IN ('paid','gift')`
  ).get().c;
  const ordersTotal = stmt(
    `SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','gift')`
  ).get().c;
  const freeActive = stmt('SELECT COALESCE(SUM(free_regions),0) AS s FROM users').get().s;
  return {
    uniqueBuyers: Number(uniqueBuyers) || 0,
    ordersTotal: Number(ordersTotal) || 0,
    freeActive: Number(freeActive) || 0,
  };
}

/** Встречается ли userId среди пользователей ИЛИ заказов (гейт для аватар-прокси, SPEC-ADMIN §2). */
function adminUserExists(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (stmt('SELECT 1 AS x FROM users WHERE id=? LIMIT 1').get(id)) return true;
  return !!stmt('SELECT 1 AS x FROM orders WHERE user_id=? LIMIT 1').get(id);
}

/**
 * ordersForAdmin({sort,limit,offset,q}) -> {total, rows} (SPEC-ADMIN §3).
 * Выборка выданных заказов (status IN ('paid','gift')) с JOIN users; маппинг в
 * API-форму (kind/regions[]/servers/active) — в server.js. Ничего существующего не меняет.
 *   sort:  'new' (дефолт) = COALESCE(paid_at,created_at) DESC; 'price' = stars DESC, id DESC.
 *   q:     фильтр по username LIKE (без учёта регистра) или user_id (точное совпадение для числа).
 *   limit: дефолт 50, максимум 200; offset: дефолт 0.
 *   total: отдельный COUNT с тем же WHERE (без limit/offset).
 * rows содержат сырые поля: id,user_id,username,first_name,regions,qty,stars,charge_id,status,
 *   created_at,paid_at,expires_at,token.
 */
function ordersForAdmin(opts) {
  const o = opts || {};
  const sort = o.sort === 'price' ? 'price' : 'new';

  let limit = Math.floor(Number(o.limit));
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  let offset = Math.floor(Number(o.offset));
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const q = String(o.q == null ? '' : o.q).trim();

  const where = [`o.status IN ('paid','gift')`];
  const params = [];
  if (q) {
    // экранируем спецсимволы LIKE (\ % _), фильтруем по вхождению в username
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    if (/^\d+$/.test(q)) {
      where.push(`(u.username LIKE ? ESCAPE '\\' OR o.user_id = ?)`);
      params.push(like, Number(q));
    } else {
      where.push(`u.username LIKE ? ESCAPE '\\'`);
      params.push(like);
    }
  }
  const whereSql = where.join(' AND ');
  const orderSql =
    sort === 'price'
      ? 'o.stars DESC, o.id DESC'
      : 'COALESCE(o.paid_at, o.created_at) DESC, o.id DESC';

  const total = stmt(
    `SELECT COUNT(*) AS c FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE ${whereSql}`
  ).get(...params).c;

  const rows = stmt(
    `SELECT o.id, o.user_id, o.regions, o.qty, o.stars, o.charge_id, o.status,
            o.token, o.created_at, o.paid_at, o.expires_at,
            u.username AS username, u.first_name AS first_name
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { total: Number(total) || 0, rows };
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
  getBonus,
  setBonus,
  addBonus,
  consumeBonus,
  refInfo,
  attributeReferral,
  refLeaders,
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
  aliveCountForRegions,
  availabilityMap,
  hostsToCheck,
  hostsForGeo,
  setGeo,
  setAliveByHostPort,
  setAliveByHostPattern,
  aliveStats,
  createOrder,
  getOrder,
  getOrderByToken,
  markOrderPaid,
  setOrderStatus,
  ordersOfUser,
  activeOrdersOf,
  liveRowsForOrder,
  mergedBundle,
  mergedSummary,
  setMerged,
  getUserByMergedToken,
  statsSummary,
  adminSummary,
  adminUserExists,
  ordersForAdmin,
  logEvent,
  addSaleMsg,
  dueSaleMsgs,
  removeSaleMsg,
};
