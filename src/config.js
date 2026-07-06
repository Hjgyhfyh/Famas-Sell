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

/**
 * SPEC-STABILITY2 §1: список ISO-стран из env (через запятую), UPPERCASE, строго [A-Z]{2}.
 * Некорректные элементы отбрасываются; пусто → def. Используется для COUNTRY_BLACKLIST —
 * значения затем безопасно инлайнятся в SQL (валидированы как ровно 2 латинские буквы).
 */
function envIsoList(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const arr = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
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

// SPEC-SOURCES §2.1: какие протоколы продаём/парсим. По умолчанию только vless (≈96% каталога);
// не-vless (trojan/ss/vmess/hysteria2/…) сознательно отбрасываются на парсинге. env-переопределяемый.
const DEFAULT_ALLOWED_PROTOCOLS = ['vless'];

// SPEC-STABILITY2 §1: ISO-страны, которые НИКОГДА не показываем/не продаём/не выдаём — заведомо
// ложная геолокация (напр. KP=КНДР появляется из-за CDN-геолокации Fastly/anycast, реального узла
// там нет). Список через запятую в env COUNTRY_BLACKLIST переопределяет. UPPERCASE, строго [A-Z]{2}.
const DEFAULT_COUNTRY_BLACKLIST = ['KP'];

/**
 * SPEC-SOURCES §1.2: реестр источников каталога. Приоритет:
 *   1) env SOURCES_JSON (валидный JSON-массив) — оверрайд без правки кода;
 *   2) committed-реестр src/sources.js.
 * Если результат пуст → единственный fallback от SOURCE_URL (обратная совместимость): каталог
 * из одного чёрного vless-источника. Тянуть реестр require должно быть безопасно (sources.js —
 * чистый модуль-данные без require). Любая ошибка разбора → тихий фолбэк на sources.js.
 */
function loadSources(sourceUrl) {
  let list = null;
  const raw = envStr('SOURCES_JSON', '');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) list = arr;
    } catch (e) {
      list = null; // битый JSON — падаем на committed-реестр
    }
  }
  if (!Array.isArray(list)) {
    try {
      list = require('./sources');
    } catch (e) {
      list = null;
    }
  }
  if (!Array.isArray(list) || list.length === 0) {
    // обратная совместимость: пустой реестр → один чёрный источник от SOURCE_URL
    return [{ id: 'source_url', url: sourceUrl, category: 'black', type: 'vless', enabled: true, heavy: false }];
  }
  // нормализация полей каждого источника (мягко, без выбрасывания)
  return list
    .filter((s) => s && typeof s === 'object' && s.url)
    .map((s, i) => ({
      id: s.id != null ? String(s.id) : 'src_' + i,
      url: String(s.url),
      category: s.category === 'white' ? 'white' : 'black',
      type: s.type ? String(s.type) : 'mixed',
      enabled: s.enabled === undefined ? true : !!s.enabled,
      heavy: !!s.heavy,
    }));
}

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
  // SPEC-GROWTH2 §A: анти-фрод рефералки. REF_REQUIRE_PURCHASE=1 (дефолт) — бонус пригласившему
  // НЕ начисляется на /start, а только когда приглашённый РЕАЛЬНО оплатил покупку (боты-накрутка
  // бессмысленна). =0 → старое поведение (бонус сразу на /start). REF_DAILY_CAP — максимум зачтённых
  // рефералов на пригласившего за МСК-сутки (защита от массовой накрутки). Дефолт 20.
  REF_REQUIRE_PURCHASE: envBool('REF_REQUIRE_PURCHASE', 1),
  REF_DAILY_CAP: envNum('REF_DAILY_CAP', 20),
  // SPEC-GROWTH2 §B: цена сервера в разделе «Белые списки» (премиум, РФ-whitelist). Дефолт 50⭐
  // (чёрный каталог — DEFAULT_PRICE_STARS=20). Переопределяется настройкой settings.price_stars_white.
  WHITE_PRICE_STARS: envNum('WHITE_PRICE_STARS', 50),
  // SPEC-V3 §B: раздел «нестабильные серверы». Хрупкие регионы (мало живых серверов) не скрываются,
  // а продаются отдельно, дёшево и честно — с предупреждением «сервер может в любой момент перестать
  // работать». UNSTABLE_PRICE_STARS — цена 1-го сервера в этом разделе (дефолт 7⭐; основной 20, белый 50).
  // UNSTABLE_MAX_ALIVE — верхняя граница живых серверов региона для попадания в раздел: регион с alive
  // в диапазоне 1..UNSTABLE_MAX_ALIVE → «нестабильный» (7⭐), с alive > UNSTABLE_MAX_ALIVE → основной (20⭐).
  UNSTABLE_PRICE_STARS: envNum('UNSTABLE_PRICE_STARS', 7),
  UNSTABLE_MAX_ALIVE: Math.max(1, Math.floor(envNum('UNSTABLE_MAX_ALIVE', 3))),
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
  // SPEC-IDEAS §2: авто-напоминания об истечении подписки (за ≤3 дн, ≤1 дн и после истечения)
  // с кнопкой «🔄 Продлить». 1=вкл (дефолт), 0=notifier не запускается (src/notify.js — no-op).
  NOTIFY_ENABLED: envBool('NOTIFY_ENABLED', 1),

  // ── SPEC-QUALITY §1: фильтр качества серверов (продаём/выдаём только живые) ──
  // Массив подстрок доменов заведомо ненадёжных хостов (lowercase), env-переопределяемый.
  HOST_BLACKLIST: envList('HOST_BLACKLIST', DEFAULT_HOST_BLACKLIST),
  // Лимит активных серверов на регион (обрезка каталога до проверяемого размера на слабом VDS).
  MAX_SERVERS_PER_REGION: envNum('MAX_SERVERS_PER_REGION', 25),
  // TCP-проверка живости серверов после каждого обновления источника (1=вкл, дефолт 1).
  HEALTHCHECK_ENABLED: envBool('HEALTHCHECK_ENABLED', 1),
  // Таймаут одного TCP-подключения при проверке, мс.
  HEALTHCHECK_TIMEOUT_MS: envNum('HEALTHCHECK_TIMEOUT_MS', 4000),
  // Сколько хостов проверять одновременно (размер пула). SPEC-SOURCES §5.3: при масштабе ~56k
  // хостов поднято до 256 (Node тянет; на VDS следить за лимитом FD/эфемерных портов). На малом
  // одиночном источнике (MULTI_SOURCE=0, ~500 хостов) это лишь ускоряет свип — поведение то же.
  HEALTHCHECK_CONCURRENCY: envNum('HEALTHCHECK_CONCURRENCY', 256),
  // SPEC-SOURCES §5.2: размер батча ротационного healthcheck. Проверяем не всё каждый цикл, а
  // самые давно проверенные (ORDER BY alive_checked_at ASC NULLS FIRST) порциями по BATCH; полный
  // свип набирается за несколько циклов. На одиночном источнике (<BATCH хостов) берётся всё разом.
  HEALTHCHECK_BATCH: envNum('HEALTHCHECK_BATCH', 8000),

  // ── SPEC-SOURCES: мультиисточник, дедуп, гео, белые списки (всё под флагами) ──
  // Разрешённые протоколы каталога (парсим/продаём). Дефолт только vless (SPEC-SOURCES §2.1).
  ALLOWED_PROTOCOLS: envList('ALLOWED_PROTOCOLS', DEFAULT_ALLOWED_PROTOCOLS),
  // MULTI_SOURCE=0 (дефолт) → работаем ровно как раньше от одного SOURCE_URL (обратная
  // совместимость прод). =1 → тянем реестр SOURCES пулом с дедупом/гео/белыми списками.
  MULTI_SOURCE: envBool('MULTI_SOURCE', 0),
  // Реестр источников (SPEC-SOURCES §1.2). Заполняется из SOURCES_JSON или src/sources.js;
  // пуст → один fallback от SOURCE_URL. Используется только при MULTI_SOURCE=1.
  SOURCES: loadSources(envStr(
    'SOURCE_URL',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt'
  )),
  // Гео-обогащение по IP (dns.resolve→geoip.lookup) заполняет country_iso только у XX-конфигов
  // (SPEC-SOURCES §6). Дефолт 0. Если geoip-lite не грузится — флаг игнорируется (фолбэк на флаги).
  GEO_ENABLED: envBool('GEO_ENABLED', 0),
  // Сколько XX-хостов гео-обогащать за один пасс (батч), и размер пула DNS-резолва.
  GEO_BATCH: envNum('GEO_BATCH', 2000),
  GEO_CONCURRENCY: envNum('GEO_CONCURRENCY', 32),
  // Категория «белые списки» (SPEC-SOURCES §4) — бэкенд-флаг (UI-вкладку добавим позже). Дефолт 0.
  WHITELIST_ENABLED: envBool('WHITELIST_ENABLED', 0),
  // Строже дедуп: ключ host:port:uuid вместо host:port (SPEC-SOURCES §3.1). Дефолт 0 (host:port).
  DEDUP_INCLUDE_UUID: envBool('DEDUP_INCLUDE_UUID', 0),

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
  // UA-gate подписки: 0 (по умолчанию) = ссылки НЕ скрываем, отдаём всем; 1 = браузеру заглушка.
  SUB_UA_GATE: envBool('SUB_UA_GATE', 0),

  // ── SPEC-STABILITY2 §1: отказоустойчивость ключа (ключ НИКОГДА не должен пропадать) ──
  // Сколько ДОПОЛНИТЕЛЬНЫХ живых серверов региона класть в подписку сверх купленного qty —
  // для мгновенного failover в VPN-приложении (моргнул один — приложение берёт следующий, ключ
  // не «перестаёт работать»). Не влияет на цену/qty. 0 = выключить резерв. Дефолт 2. Клампится ≥0.
  SUB_RESERVE_PER_REGION: Math.max(0, Math.floor(envNum('SUB_RESERVE_PER_REGION', 2))),
  // Регион с меньшим числом ЖИВЫХ серверов не показывается и не продаётся (слишком хрупкий: 1
  // сервер = единая точка отказа). Существующие заказы на такой регион продолжают отдавать что есть.
  // Дефолт 2. Клампится ≥1 (регион с 0 живых не появляется в каталоге в любом случае).
  MIN_ALIVE_TO_SELL: Math.max(1, Math.floor(envNum('MIN_ALIVE_TO_SELL', 2))),
  // Сервер помечается мёртвым только после стольких ПОДРЯД неудачных healthcheck-проверок —
  // одиночный сетевой блип не выкидывает сервер из выдачи (grace). Первый успех — мгновенно жив.
  // Дефолт 2. Клампится ≥1 (1 = без grace: первый же провал убивает).
  HEALTH_GRACE_FAILS: Math.max(1, Math.floor(envNum('HEALTH_GRACE_FAILS', 2))),
  // Для tls/reality-конфигов проверять полноценный TLS-хендшейк (точнее TCP: ловит «порт открыт,
  // но сервер битый» — прямой кейс «работает-перестаёт»). 1=вкл (дефолт), 0=только TCP как раньше.
  HEALTH_TLS: envBool('HEALTH_TLS', 1),
  // ISO-страны, которые никогда не показываем/не продаём/не выдаём (ложная геолокация, напр. KP).
  // env COUNTRY_BLACKLIST (через запятую) переопределяет. UPPERCASE, строго [A-Z]{2}.
  COUNTRY_BLACKLIST: envIsoList('COUNTRY_BLACKLIST', DEFAULT_COUNTRY_BLACKLIST),
};

// Каталог для БД должен существовать до открытия better-sqlite3.
try {
  fs.mkdirSync(path.dirname(path.resolve(config.DB_PATH)), { recursive: true });
} catch (e) {
  // не фатально здесь: db.init() упадёт с внятной ошибкой, если каталога так и нет
}

module.exports = config;
