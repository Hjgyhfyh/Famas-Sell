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
};

// Каталог для БД должен существовать до открытия better-sqlite3.
try {
  fs.mkdirSync(path.dirname(path.resolve(config.DB_PATH)), { recursive: true });
} catch (e) {
  // не фатально здесь: db.init() упадёт с внятной ошибкой, если каталога так и нет
}

module.exports = config;
