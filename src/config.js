'use strict';
/**
 * src/config.js — конфигурация из .env (dotenv).
 * Числа — числами, ADMIN_IDS — массив чисел. SOURCE_URL может начинаться с 'file:'.
 */
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config();

function envStr(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  return String(raw).trim();
}

function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def) {
  return /^(1|true|yes|on)$/i.test(envStr(name, def ? '1' : '0')) ? 1 : 0;
}

/** Список подстрок из env (через запятую), lowercase; пусто → def. */
function envList(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const arr = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return arr.length ? arr : def;
}

// SPEC-QUALITY §1: заведомо ненадёжные хосты (free-хостинги, туннели). Если host сервера
// содержит любую из этих подстрок — сервер считаем «мусорным» (alive=0), не продаём/не выдаём.
const DEFAULT_HOST_BLACKLIST = [
  'up.railway.app', 'railway.app', 'onrender.com', 'render.com', 'herokuapp.com',
  'glitch.me', 'repl.co', 'replit.dev', 'trycloudflare.com', 'ngrok.io',
  'ngrok-free.app', 'serveo.net', 'localhost.run', 'loca.lt', 'cfargotunnel.com',
  'workers.dev', 'pagekite.me', 'telebit.io',
];

// SPEC-HARDEN ч.2 §1: подстроки UA (lowercase), по которым запрос на /famas/s/:token считаем
// РЕАЛЬНЫМ VPN-клиентом → отдаём base64-подписку. Проверяется ПЕРВЫМ (важнее блок-листа):
// если UA содержит любую из этих подстрок — не режем, даже если там есть 'safari' и т.п.
const DEFAULT_VPN_UA_ALLOW = [
  'happ', 'v2ray', 'v2rayng', 'v2raytun', 'v2box', 'nekobox', 'nekoray',
  'sing-box', 'sing_box', 'singbox', 'shadowrocket', 'streisand', 'clash',
  'stash', 'loon', 'surge', 'karing', 'hiddify', 'foxray', 'sagernet',
  'matsuri', 'ktor-client', 'ktor',
];

// SPEC-HARDEN ч.2 §1/§6: подстроки UA (lowercase) явных браузеров/утилит. Такой запрос на
// /famas/s/:token (и БЕЗ VPN-маркера выше, и без ?app=1) получает страницу-подсказку, а не сырые
// конфиги. Пустой/незнакомый UA НЕ режем (безопаснее белого списка — не ломаем реальные клиенты).
const DEFAULT_BROWSER_UA_BLOCK = [
  'mozilla', 'chrome', 'safari', 'edg', 'curl', 'wget',
  'python-requests', 'postmanruntime', 'go-http-client',
];

const config = {
  BOT_TOKEN: envStr('BOT_TOKEN', ''),
  ADMIN_IDS: envStr('ADMIN_IDS', '927937870')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  SUPPORT_USERNAME: envStr('SUPPORT_USERNAME', 'sigmatik323').replace(/^@/, ''),
  PORT: envNum('PORT', 4488),
  PUBLIC_BASE: envStr('PUBLIC_BASE', 'https://telepasta.ru/famas').replace(/\/+$/, ''),
  SOURCE_URL: envStr(
    'SOURCE_URL',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt'
  ),
  FETCH_INTERVAL_MIN: envNum('FETCH_INTERVAL_MIN', 10),
  DEFAULT_PRICE_STARS: envNum('DEFAULT_PRICE_STARS', 20),
  // Доп. сервер того же региона (SPEC-QTY §1): 1-й сервер страны = base (priceStars),
  // каждый следующий сервер той же страны = +extra. Дефолт 10⭐, меняется через /admin.
  EXTRA_STARS: envNum('EXTRA_STARS', 10),
  DEFAULT_SUB_DAYS: envNum('DEFAULT_SUB_DAYS', 30),
  // SPEC-REFERRAL §1: бонус-звёзды за каждого приглашённого НОВОГО пользователя.
  // Копятся у пригласившего (users.bonus_stars) и тратятся скидкой на покупки. Дефолт 10.
  REF_BONUS_STARS: envNum('REF_BONUS_STARS', 10),
  DB_PATH: envStr('DB_PATH', './data/famas.db'),
  SKIP_BOT: /^(1|true|yes)$/i.test(envStr('SKIP_BOT', '0')) ? 1 : 0,
  BOT_USERNAME: envStr('BOT_USERNAME', 'FamasSellerBot').replace(/^@/, ''),
  // SPEC-LOG §1: приватный канал логов продаж + живая статистика.
  // Дефолт — канал владельца. Пусто/'0' → логирование ВЫКЛЮЧЕНО (saleslog — no-op),
  // бот работает как раньше. Бот должен быть админом канала (post/edit/delete/pin).
  SALES_CHANNEL_ID: envStr('SALES_CHANNEL_ID', '-1004297326871'),
  // Через сколько минут самоудаляется сообщение о покупке в канале (SPEC-LOG §7b: дефолт 60).
  // Удаление персистентное (свипер по таблице sale_log_msgs) — переживает рестарт бота.
  SALE_LOG_TTL_MIN: envNum('SALE_LOG_TTL_MIN', 60),

  // ── SPEC-QUALITY §1: фильтр качества серверов (продаём/выдаём только живые) ──
  // Массив подстрок доменов заведомо ненадёжных хостов (lowercase), env-переопределяемый.
  HOST_BLACKLIST: envList('HOST_BLACKLIST', DEFAULT_HOST_BLACKLIST),
  // TCP-проверка живости серверов после каждого обновления источника (1=вкл, дефолт 1).
  HEALTHCHECK_ENABLED: envBool('HEALTHCHECK_ENABLED', 1),
  // Таймаут одного TCP-подключения при проверке, мс.
  HEALTHCHECK_TIMEOUT_MS: envNum('HEALTHCHECK_TIMEOUT_MS', 4000),
  // Сколько хостов проверять одновременно (размер пула).
  HEALTHCHECK_CONCURRENCY: envNum('HEALTHCHECK_CONCURRENCY', 24),

  // ── SPEC-HARDEN ч.1: стабильность выданного ключа ──
  // ОТДЕЛЬНЫЙ таймер healthcheck (помимо refresh источника): мёртвый сервер выпадает из
  // живых за ≤ этого интервала (мин, дефолт 3). Реагирует быстрее FETCH_INTERVAL_MIN.
  HEALTHCHECK_INTERVAL_MIN: envNum('HEALTHCHECK_INTERVAL_MIN', 3),
  // Заголовок подписки profile-update-interval (часы, дефолт 1). Клиенты Happ/v2ray сами
  // перечитывают подписку по этому интервалу. Клампится к целому ≥1 (клиенты <1 не принимают).
  SUB_UPDATE_HOURS: Math.max(1, Math.floor(envNum('SUB_UPDATE_HOURS', 1))),

  // ── SPEC-HARDEN ч.2: защита выдачи /famas/s/:token ──
  // Реальные VPN-клиенты (подстроки UA, lowercase) — им отдаём подписку. env-переопределяемый.
  VPN_UA_ALLOW: envList('VPN_UA_ALLOW', DEFAULT_VPN_UA_ALLOW),
  // Явные браузеры/утилиты (подстроки UA, lowercase) — им отдаём страницу-подсказку. env-переопределяемый.
  BROWSER_UA_BLOCK: envList('BROWSER_UA_BLOCK', DEFAULT_BROWSER_UA_BLOCK),
};

// Каталог для БД должен существовать до открытия better-sqlite3.
try {
  fs.mkdirSync(path.dirname(path.resolve(config.DB_PATH)), { recursive: true });
} catch (e) {
  // не фатально здесь: db.init() упадёт с внятной ошибкой, если каталога так и нет
}

module.exports = config;
