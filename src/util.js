'use strict';
/**
 * src/util.js — ЧИСТЫЙ модуль.
 * Только стандартный node:crypto. Никаких npm-пакетов и никаких require других src-модулей.
 */
const crypto = require('node:crypto');

/* ─────────────────────────── Страны ─────────────────────────── */

// [EN, ISO, RU]
const COUNTRIES = [
  ['Albania', 'AL', 'Албания'],
  ['Argentina', 'AR', 'Аргентина'],
  ['Armenia', 'AM', 'Армения'],
  ['Australia', 'AU', 'Австралия'],
  ['Austria', 'AT', 'Австрия'],
  ['Azerbaijan', 'AZ', 'Азербайджан'],
  ['Belarus', 'BY', 'Беларусь'],
  ['Belgium', 'BE', 'Бельгия'],
  ['Bosnia', 'BA', 'Босния и Герцеговина'],
  ['Bosnia and Herzegovina', 'BA', 'Босния и Герцеговина'],
  ['Brazil', 'BR', 'Бразилия'],
  ['Bulgaria', 'BG', 'Болгария'],
  ['Canada', 'CA', 'Канада'],
  ['Chile', 'CL', 'Чили'],
  ['China', 'CN', 'Китай'],
  ['Colombia', 'CO', 'Колумбия'],
  ['Costa Rica', 'CR', 'Коста-Рика'],
  ['Croatia', 'HR', 'Хорватия'],
  ['Cyprus', 'CY', 'Кипр'],
  ['Czech Republic', 'CZ', 'Чехия'],
  ['Czechia', 'CZ', 'Чехия'],
  ['Denmark', 'DK', 'Дания'],
  ['Ecuador', 'EC', 'Эквадор'],
  ['Egypt', 'EG', 'Египет'],
  ['Estonia', 'EE', 'Эстония'],
  ['Finland', 'FI', 'Финляндия'],
  ['France', 'FR', 'Франция'],
  ['Georgia', 'GE', 'Грузия'],
  ['Germany', 'DE', 'Германия'],
  ['Greece', 'GR', 'Греция'],
  ['Hong Kong', 'HK', 'Гонконг'],
  ['Hungary', 'HU', 'Венгрия'],
  ['Iceland', 'IS', 'Исландия'],
  ['India', 'IN', 'Индия'],
  ['Indonesia', 'ID', 'Индонезия'],
  ['Iran', 'IR', 'Иран'],
  ['Iraq', 'IQ', 'Ирак'],
  ['Ireland', 'IE', 'Ирландия'],
  ['Israel', 'IL', 'Израиль'],
  ['Italy', 'IT', 'Италия'],
  ['Japan', 'JP', 'Япония'],
  ['Jordan', 'JO', 'Иордания'],
  ['Kazakhstan', 'KZ', 'Казахстан'],
  ['Kenya', 'KE', 'Кения'],
  ['Kuwait', 'KW', 'Кувейт'],
  ['Kyrgyzstan', 'KG', 'Киргизия'],
  ['Latvia', 'LV', 'Латвия'],
  ['Lithuania', 'LT', 'Литва'],
  ['Luxembourg', 'LU', 'Люксембург'],
  ['Malaysia', 'MY', 'Малайзия'],
  ['Malta', 'MT', 'Мальта'],
  ['Mexico', 'MX', 'Мексика'],
  ['Moldova', 'MD', 'Молдова'],
  ['Monaco', 'MC', 'Монако'],
  ['Mongolia', 'MN', 'Монголия'],
  ['Montenegro', 'ME', 'Черногория'],
  ['Morocco', 'MA', 'Марокко'],
  ['Netherlands', 'NL', 'Нидерланды'],
  ['The Netherlands', 'NL', 'Нидерланды'],
  ['New Zealand', 'NZ', 'Новая Зеландия'],
  ['North Macedonia', 'MK', 'Северная Македония'],
  ['Norway', 'NO', 'Норвегия'],
  ['Oman', 'OM', 'Оман'],
  ['Nigeria', 'NG', 'Нигерия'],
  ['Pakistan', 'PK', 'Пакистан'],
  ['Panama', 'PA', 'Панама'],
  ['Paraguay', 'PY', 'Парагвай'],
  ['Peru', 'PE', 'Перу'],
  ['Philippines', 'PH', 'Филиппины'],
  ['Poland', 'PL', 'Польша'],
  ['Portugal', 'PT', 'Португалия'],
  ['Qatar', 'QA', 'Катар'],
  ['Romania', 'RO', 'Румыния'],
  ['Russia', 'RU', 'Россия'],
  ['Saudi Arabia', 'SA', 'Саудовская Аравия'],
  ['Serbia', 'RS', 'Сербия'],
  ['Singapore', 'SG', 'Сингапур'],
  ['Slovakia', 'SK', 'Словакия'],
  ['Slovenia', 'SI', 'Словения'],
  ['South Africa', 'ZA', 'ЮАР'],
  ['South Korea', 'KR', 'Южная Корея'],
  ['Spain', 'ES', 'Испания'],
  ['Sweden', 'SE', 'Швеция'],
  ['Switzerland', 'CH', 'Швейцария'],
  ['Taiwan', 'TW', 'Тайвань'],
  ['Tajikistan', 'TJ', 'Таджикистан'],
  ['Thailand', 'TH', 'Таиланд'],
  ['Tunisia', 'TN', 'Тунис'],
  ['Turkey', 'TR', 'Турция'],
  ['Turkmenistan', 'TM', 'Туркменистан'],
  ['UAE', 'AE', 'ОАЭ'],
  ['Ukraine', 'UA', 'Украина'],
  ['United Arab Emirates', 'AE', 'ОАЭ'],
  ['United Kingdom', 'GB', 'Великобритания'],
  ['United States', 'US', 'США'],
  ['Uruguay', 'UY', 'Уругвай'],
  ['Uzbekistan', 'UZ', 'Узбекистан'],
  ['Venezuela', 'VE', 'Венесуэла'],
  ['Vietnam', 'VN', 'Вьетнам'],
];

/** map EN -> RU */
const COUNTRY_RU = {};
/** map EN -> ISO (плюс алиасы для поиска по названию без флага) */
const COUNTRY_ISO = {};
/** map ISO -> каноническое EN-имя (первое в таблице) */
const ISO_TO_EN = {};

for (const [en, iso, ru] of COUNTRIES) {
  COUNTRY_RU[en] = ru;
  COUNTRY_ISO[en] = iso;
  if (!ISO_TO_EN[iso]) ISO_TO_EN[iso] = en;
}
// алиасы (только для поиска, в COUNTRY_RU их нет)
Object.assign(COUNTRY_ISO, { UK: 'GB', USA: 'US', 'Great Britain': 'GB', Holland: 'NL', 'Korea': 'KR' });

// Прекомпилированные матчеры «имя страны как отдельное слово», длинные имена — первыми.
let countryMatchers = null;
function getCountryMatchers() {
  if (!countryMatchers) {
    countryMatchers = Object.keys(COUNTRY_ISO)
      .sort((a, b) => b.length - a.length)
      .map((key) => ({
        iso: COUNTRY_ISO[key],
        key,
        re: new RegExp('(^|[^A-Za-z])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z])', 'i'),
      }));
  }
  return countryMatchers;
}

function findCountryInText(text) {
  if (!text) return null;
  for (const m of getCountryMatchers()) {
    if (m.re.test(text)) return { iso: m.iso, name: ISO_TO_EN[m.iso] || m.key };
  }
  return null;
}

/* ──────────────── Служебные метки (не страна) ──────────────── */

// Anycast, Relay, CDN, WARP, Cloudflare и т.п. — это НЕ страна, а тип узла.
const SERVICE_LABEL_RE =
  /\b(?:any\s?cast|relay|cdn|warp|cloud\s?flare|g-?core|fastly|akamai|bunny(?:cdn)?|edge|proxy|tunnel|mirror|unknown|mixed|multi(?:-?hop)?|load\s?balanc|round\s?robin)\b|anycast-?ip/i;

/** Похоже ли на осмысленный топоним (город/страна), а не служебная метка. */
function isPlausiblePlace(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length < 2) return false;
  if (SERVICE_LABEL_RE.test(t)) return false;
  // только буквы и мягкие разделители — без цифр, скобок, слэшей
  return /^[\p{L}][\p{L}\s.'’\-]*$/u.test(t);
}

/** Первый осмысленный «город» из сегментов (без флагов, [бейджей], (заметок), служебных слов). */
function pickCity(segments) {
  for (const raw of segments || []) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ') // regional-indicator символы (флаги)
      .replace(/\[[^\]]*\]/g, ' ') // [BL]-бейджи
      .replace(/\([^)]*\)/g, ' ') // (заметки)
      .replace(/[^0-9A-Za-zА-Яа-яЁё .,'’\-]/gu, ' ') // прочие эмодзи/символы
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!s) continue;
    if (!/[A-Za-zА-Яа-яЁё]/.test(s)) continue;
    if (SERVICE_LABEL_RE.test(s)) continue;
    return s;
  }
  return '';
}

/* ──────────────── Русское имя страны по ISO ──────────────── */

let _ruRegionDN; // ленивый Intl.DisplayNames
let _ruRegionDNInit = false;
const _ruRegionCache = new Map(); // ISO(upper) -> RU | '' (промах)

function _ruRegionNames() {
  if (!_ruRegionDNInit) {
    _ruRegionDNInit = true;
    try {
      _ruRegionDN = new Intl.DisplayNames(['ru'], { type: 'region' });
    } catch (e) {
      _ruRegionDN = null;
    }
  }
  return _ruRegionDN;
}

/**
 * Русское имя страны с фолбэками.
 * Приоритет (канон SPEC §3 — nameRu = COUNTRY_RU[name] || name — с расширенным фолбэком):
 * 1) COUNTRY_RU[name] (name — EN-имя из фрагмента) — курируемые короткие имена владельца
 *    (США, ОАЭ, ЮАР, Гонконг, Южная Корея…);
 * 2) Intl.DisplayNames(['ru'],{type:'region'}).of(ISO) (кэш, try/catch) — для ISO вне COUNTRY_RU;
 * 3) name (EN); 4) ISO.
 * Intl НЕ должен перекрывать курируемые имена (иначе США→«Соединённые Штаты», ЮАР→«Южно-Африканская
 * Республика», Гонконг→«Гонконг (САР)» — вразрез со SPEC §3 и §4-набором COUNTRY_RU).
 */
function nameRuOf(iso, name) {
  const code = typeof iso === 'string' ? iso.trim().toUpperCase() : '';
  // 1) курируемое имя из COUNTRY_RU по EN-имени
  if (name && COUNTRY_RU[name]) return COUNTRY_RU[name];
  // 2) Intl.DisplayNames по ISO — только для кодов, которых нет в курируемой карте
  if (/^[A-Z]{2}$/.test(code) && code !== 'XX') {
    let ru = '';
    if (_ruRegionCache.has(code)) {
      ru = _ruRegionCache.get(code);
    } else {
      const dn = _ruRegionNames();
      if (dn) {
        try {
          const got = dn.of(code);
          // Intl отдаёт сам код, если региона не знает — считаем это промахом
          if (got && got !== code) ru = got;
        } catch (e) {
          ru = '';
        }
      }
      _ruRegionCache.set(code, ru);
    }
    if (ru) return ru;
  }
  // 3) EN-имя как есть; 4) ISO
  if (name) return String(name);
  return code && code !== 'XX' ? code : 'XX';
}

/* ─────────────────────────── Флаги ─────────────────────────── */

const RI_BASE = 0x1f1e6; // 🇦
const RI_PAIR_RE = /\p{RI}\p{RI}/u;

/** '🇩🇪' -> 'DE'; мусор -> '' */
function flagToIso(flag) {
  if (!flag) return '';
  const cps = Array.from(String(flag))
    .map((c) => c.codePointAt(0))
    .filter((cp) => cp >= RI_BASE && cp <= RI_BASE + 25);
  if (cps.length < 2) return '';
  return String.fromCharCode(65 + cps[0] - RI_BASE, 65 + cps[1] - RI_BASE);
}

/** 'DE' -> '🇩🇪'; не двухбуквенный код -> '' */
function isoToFlag(iso) {
  if (typeof iso !== 'string' || !/^[A-Za-z]{2}$/.test(iso)) return '';
  const up = iso.toUpperCase();
  return String.fromCodePoint(RI_BASE + up.charCodeAt(0) - 65, RI_BASE + up.charCodeAt(1) - 65);
}

/* ─────────────────────────── Крипто и форматирование ─────────────────────────── */

/** случайный URL-safe токен */
function genToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** sha256 hex от произвольной строки (uri или канонического ключа) */
function hashUri(uri) {
  return crypto.createHash('sha256').update(String(uri), 'utf8').digest('hex');
}

/* ───────── дедуп по каноническому ключу сервера (SPEC-SOURCES §3) ───────── */

/**
 * canonicalKey(host, port, uuid, includeUuid) — единица «сервер» для кросс-источниковой
 * дедупликации (SPEC-SOURCES §3.1). Дефолт: lower(host):port. При includeUuid — добавляем
 * :lower(uuid) (строже: мультитенант за одним host:port). host уже без IPv6-скобок.
 */
function canonicalKey(host, port, uuid, includeUuid) {
  const h = String(host == null ? '' : host).trim().toLowerCase();
  const p = Number(port) || 0;
  let key = h + ':' + p;
  if (includeUuid) {
    const u = String(uuid == null ? '' : uuid).trim().toLowerCase();
    if (u) key += ':' + u;
  }
  return key;
}

/**
 * configHash(uri, includeUuid) — репозиторий ключа = configs.hash (SPEC-SOURCES §3.2):
 * sha256(canonicalKey), НЕ sha256(uri). Стабилен между рефрешами при неизменном host:port,
 * поэтому upsertConfigs схлопывает один сервер из разных источников/рефрешей в одну строку и
 * сохраняет alive/first_seen. Используется и парсером, и rehash-миграцией db (одинаковый ключ).
 */
function configHash(uri, includeUuid) {
  const a = parseAuthority(uri);
  return hashUri(canonicalKey(a.host, a.port, a.uuid, includeUuid));
}

/* ───────── нормализация тела источника (SPEC-SOURCES §2.2) ───────── */

/** Регэксп схемы протокола в начале строки: 'vless://', 'trojan://', 'ss://', … */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Схема строки в lowercase ('vless') или '' если это не URI. */
function schemeOf(line) {
  const m = SCHEME_RE.exec(String(line == null ? '' : line));
  return m ? m[1].toLowerCase() : '';
}

/** Разрешён ли протокол строки списком allow (дефолт ['vless']). */
function isAllowedProtocol(line, allow) {
  const s = schemeOf(line);
  if (!s) return false;
  const list = Array.isArray(allow) && allow.length ? allow : ['vless'];
  return list.indexOf(s) !== -1;
}

/**
 * maybeDecodeB64(text) — некоторые подписки приходят как единый base64-блок без '://'
 * (SPEC-SOURCES §2.2). Если тело уже содержит '://' — возвращаем как есть (быстрый путь, важно
 * для тяжёлого #2: не гоняем регэксп по 63 MB). Иначе пробуем base64-декод (std и url-safe);
 * успех только если декодированное содержит '://'.
 */
function maybeDecodeB64(text) {
  const t = String(text == null ? '' : text);
  if (t.indexOf('://') !== -1) return t; // уже плоский список
  const compact = t.replace(/\s+/g, '');
  if (compact.length < 8 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return t;
  try {
    const std = compact.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(std, 'base64').toString('utf8');
    if (decoded.indexOf('://') !== -1) return decoded;
  } catch (e) {
    // не base64 — вернём исходный текст
  }
  return t;
}

/**
 * splitGluedLine(line) — некоторые источники клеят несколько vless:// в одну строку
 * (SPEC-SOURCES §2.2). Вставляем перенос перед каждым НЕ-ведущим 'vless://' и разбиваем.
 * Возвращает массив кусков (для одиночной строки — [line]). Экономно: вызывается только когда
 * во входе реально ещё раз встречается 'vless://' (см. mergeInto), поэтому по 63 MB не гоняется.
 */
function splitGluedLine(line) {
  const s = String(line == null ? '' : line);
  const glued = s.replace(/([^\n])(vless:\/\/)/g, '$1\n$2');
  return glued.indexOf('\n') !== -1 ? glued.split('\n') : [s];
}

/** Уровень security по uri: reality=3 > tls=2 > none/прочее=1 (для pickBest). */
function securityRank(uri) {
  const m = /[?&]security=([^&#\s]*)/i.exec(String(uri == null ? '' : uri));
  const v = m ? m[1].toLowerCase() : '';
  if (v === 'reality') return 3;
  if (v === 'tls') return 2;
  return 1;
}

/** Похоже ли userinfo на валидный UUID v4-подобный (8-4-4-4-12 hex). */
function looksLikeUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s == null ? '' : s).trim());
}

/**
 * pickBest(a, b) — выбрать «лучшего» представителя при коллизии canonicalKey (SPEC-SOURCES §3.3).
 * Приоритет (по убыванию): security reality>tls>none; распознанная страна (iso≠XX); валидный uuid;
 * более короткий/чистый label. Возвращает один из объектов (при равенстве — a, «первого»).
 * Категория (white>black) разрешается ОТДЕЛЬНО в mergeInto — здесь только представитель uri/меток.
 */
function scoreConfig(c) {
  if (!c) return -1;
  let score = 0;
  score += (typeof c._sec === 'number' ? c._sec : securityRank(c.uri)) * 1000;
  if (c.countryIso && c.countryIso !== 'XX') score += 300;
  if (c._uuidValid || looksLikeUuid(c.uuid)) score += 100;
  // короче label — чуть лучше (штраф за длину, слабый вес, не перебивает старшие критерии)
  const len = c.label ? String(c.label).length : 0;
  score += Math.max(0, 40 - Math.min(40, len));
  return score;
}

function pickBest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return scoreConfig(b) > scoreConfig(a) ? b : a;
}

/** HTML-эскейп для parse_mode:'HTML' */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const DATETIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** unix-секунды -> 'DD.MM.YYYY' (Москва) */
function fmtDate(unixSec) {
  return DATE_FMT.format(new Date(Number(unixSec) * 1000));
}

/** unix-секунды -> 'DD.MM.YYYY, HH:MM' (Москва) */
function fmtDateTime(unixSec) {
  return DATETIME_FMT.format(new Date(Number(unixSec) * 1000));
}

/** UTF-8 строка -> base64 */
function b64utf8(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/* ─────────────────────────── Парсер источника ─────────────────────────── */

/**
 * parseAuthority(uri) -> {host, port, uuid} из authority любого `scheme://userinfo@host:port…`.
 * uuid = userinfo (часть до последнего '@' в authority) — для строгого дедупа host:port:uuid.
 * IPv6 в [скобках] учтён. Схема не важна (работает и для не-vless, но каталог оставляет vless).
 */
function parseAuthority(uri) {
  try {
    const str = String(uri == null ? '' : uri);
    const schemeIdx = str.indexOf('://');
    const noScheme = schemeIdx === -1 ? str : str.slice(schemeIdx + 3);
    let end = noScheme.length;
    for (const ch of ['?', '#', '/']) {
      const i = noScheme.indexOf(ch);
      if (i !== -1 && i < end) end = i;
    }
    const authority = noScheme.slice(0, end);
    const at = authority.lastIndexOf('@');
    const uuid = at === -1 ? '' : authority.slice(0, at);
    const hostport = at === -1 ? authority : authority.slice(at + 1);
    let host = '';
    let port = 0;
    if (hostport.startsWith('[')) {
      const close = hostport.indexOf(']');
      if (close === -1) return { host: hostport, port: 0, uuid };
      host = hostport.slice(1, close);
      const rest = hostport.slice(close + 1);
      if (rest.startsWith(':')) port = parseInt(rest.slice(1), 10) || 0;
    } else {
      const colon = hostport.lastIndexOf(':');
      if (colon === -1) {
        host = hostport;
      } else {
        host = hostport.slice(0, colon);
        port = parseInt(hostport.slice(colon + 1), 10) || 0;
      }
    }
    return { host, port, uuid };
  } catch (e) {
    return { host: '', port: 0, uuid: '' };
  }
}

/**
 * одна строка vless:// -> объект конфига (или null, если совсем мусор).
 * opts = {category:'black'|'white', includeUuid:bool} — влияет на hash (canonicalKey) и list_type.
 * hash = sha256(canonicalKey) (SPEC-SOURCES §3.2). На объект кладём служебные _sec/_uuidValid/uuid
 * (для pickBest) и category (для list_type) — upsertConfigs берёт только известные поля.
 */
function parseVlessLine(uri, opts) {
  try {
    const o = opts || {};
    const { host, port, uuid } = parseAuthority(uri);

    // фрагмент после # -> человекочитаемый лейбл
    const hashIdx = uri.indexOf('#');
    let label = '';
    if (hashIdx !== -1) {
      const rawFrag = uri.slice(hashIdx + 1);
      try {
        label = decodeURIComponent(rawFrag);
      } catch (e) {
        label = rawFrag;
      }
    }
    label = label.trim();

    // флаг — первая пара regional-indicator символов
    let flag = '';
    let countryIso = 'XX';
    const fm = label.match(RI_PAIR_RE);
    if (fm) {
      flag = fm[0];
      countryIso = flagToIso(flag) || 'XX';
    }

    // остаток без флага; хвостовые бейджи | ... | режем на сегменты по '|'
    const noFlag = flag ? label.replace(flag, ' ') : label;
    const segments = noFlag.split('|').map((s) => s.trim());
    const firstSeg = segments[0] || '';

    // 'Country, City (Note)' -> countryName / city
    let countryName = firstSeg;
    let city = '';
    const comma = firstSeg.indexOf(',');
    if (comma !== -1) {
      countryName = firstSeg.slice(0, comma).trim();
      city = firstSeg
        .slice(comma + 1)
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    // косметика: срезать ведущие эмодзи/значки перед именем ('🌐 Anycast-IP' -> 'Anycast-IP')
    countryName = countryName.replace(/^[^0-9A-Za-zА-Яа-яЁё]+/u, '').trim();

    // флага нет — ищем известное имя страны в лейбле
    if (!fm) {
      const found = findCountryInText(label);
      if (found) {
        countryIso = found.iso;
        countryName = found.name;
      }
    }

    // Служебная метка вместо страны ('🌐 Anycast-IP | 🇨🇦 🇫🇮 | [BL]', Relay, CDN…):
    // в первом сегменте нет запятой и не распознаётся страна — страну берём из флага/ISO,
    // countryName из фрагмента (метку) не тащим в имя.
    const segIsCountry =
      comma !== -1 || !!COUNTRY_ISO[countryName] || !!findCountryInText(firstSeg);
    if (!segIsCountry && (SERVICE_LABEL_RE.test(firstSeg) || countryIso !== 'XX')) {
      if (countryIso && countryIso !== 'XX') {
        // страна — из флага; город — второй осмысленный сегмент,
        // либо сам первый, если он правдоподобный топоним (а не служебная метка)
        countryName = ISO_TO_EN[countryIso] || '';
        const city2 = pickCity(segments.slice(1));
        city = city2 || (isPlausiblePlace(firstSeg) ? firstSeg : '');
      } else {
        // страну определить нельзя, а метка служебная — не засоряем именем
        countryName = '';
        city = '';
      }
    }

    return {
      uri,
      host,
      port,
      uuid,
      flag,
      countryIso,
      countryName,
      city,
      label,
      // «Белые списки» = премиум-протокол REALITY (самый устойчивый в РФ), определяется по САМОМУ
      // конфигу, а не по источнику (источники падают/скачут). reality → white (50⭐), иначе → black.
      category: securityRank(uri) === 3 ? 'white' : 'black',
      _sec: securityRank(uri),
      _uuidValid: looksLikeUuid(uuid),
      hash: configHash(uri, !!o.includeUuid),
    };
  } catch (e) {
    return null;
  }
}

/**
 * parseSource(text, opts) -> { meta:{title,count,dateLine,dropped}, configs:[{…,hash,category}] }
 * opts = {category:'black'|'white', includeUuid:bool, allow:[protocols]} (все необязательны;
 * дефолты — black / host:port / ['vless'] — полная обратная совместимость parseSource(text)).
 *
 * Изменения SPEC-SOURCES §2/§3: base64-подписка декодируется (maybeDecodeB64); склеенные строки
 * (несколько vless:// в одной) разбиваются; не-vless (по allow) отбрасываются (meta.dropped);
 * дедуп по НОВОМУ hash = sha256(canonicalKey=host:port) — внутрифайловые host:port-дубли
 * схлопываются автоматически, остаётся ПЕРВЫЙ (для одиночного источника этого достаточно;
 * кросс-источниковый выбор лучшего — в mergeInto/pickBest).
 */
function parseSource(text, opts) {
  const o = opts || {};
  const category = o.category === 'white' ? 'white' : 'black';
  const includeUuid = !!o.includeUuid;
  const allow = Array.isArray(o.allow) && o.allow.length ? o.allow : ['vless'];

  const body = maybeDecodeB64(text);
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  const meta = { title: '', count: 0, dateLine: '', dropped: 0 };
  const configs = [];
  const seen = new Set();
  let firstHeader = '';

  const handle = (part0) => {
    const part = String(part0 == null ? '' : part0).trim();
    if (!part) return;
    if (!isAllowedProtocol(part, allow)) {
      if (schemeOf(part)) meta.dropped++; // не-vless URI — сознательно отбрасываем
      return;
    }
    const parsed = parseVlessLine(part, { category, includeUuid });
    if (!parsed || !parsed.hash) return;
    if (seen.has(parsed.hash)) return; // host:port-дубль внутри файла
    seen.add(parsed.hash);
    configs.push(parsed);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!schemeOf(line)) {
      // строки шапки вида "# profile-title: ...", "# Date/Time: ...", "# Количество: 150"
      const hm = line.match(/^#\s*(.+)$/);
      if (hm) {
        const h = hm[1].trim();
        if (!firstHeader) firstHeader = h;
        let m;
        if ((m = h.match(/^profile-title:\s*(.+)$/i))) meta.title = m[1].trim();
        else if ((m = h.match(/^Date\/?Time:\s*(.+)$/i))) meta.dateLine = m[1].trim();
        else if ((m = h.match(/^(?:Количество|Count|Total)\s*:\s*(\d+)/i))) meta.count = parseInt(m[1], 10);
      }
      continue;
    }

    // строка-URI: может быть склеенной (несколько vless:// подряд) — тогда разбиваем
    if (line.indexOf('vless://', 1) !== -1) {
      for (const p of splitGluedLine(line)) handle(p);
    } else {
      handle(line);
    }
  }

  if (!meta.title && firstHeader) meta.title = firstHeader;
  if (!meta.count) meta.count = configs.length;
  return { meta, configs };
}

/**
 * mergeInto(map, text, opts) — стриминговый merge-редьюс источника в общий Map<hash, bestConfig>
 * (SPEC-SOURCES §2.6). Пик памяти = число уникальных host:port, а не сумма всех строк — критично
 * для тяжёлого #2. Дедуп по hash=sha256(canonicalKey); при коллизии — pickBest (лучший uri/метки),
 * а категория white побеждает black (§4.2: whitelist — положительное свойство, не теряем).
 * opts = {category, includeUuid, allow}. Возвращает {added, merged, dropped}.
 */
function mergeInto(map, text, opts) {
  const o = opts || {};
  const category = o.category === 'white' ? 'white' : 'black';
  const includeUuid = !!o.includeUuid;
  const allow = Array.isArray(o.allow) && o.allow.length ? o.allow : ['vless'];
  const stats = { added: 0, merged: 0, dropped: 0 };

  let body = maybeDecodeB64(text);
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  body = null; // отпускаем крупную строку до цикла (память тяжёлого #2)

  const handle = (part0) => {
    const part = String(part0 == null ? '' : part0).trim();
    if (!part) return;
    const scheme = schemeOf(part);
    if (!scheme) return; // шапка/комментарий/мусор
    if (allow.indexOf(scheme) === -1) {
      stats.dropped++;
      return;
    }
    const cfg = parseVlessLine(part, { category, includeUuid });
    if (!cfg || !cfg.hash) return;
    const prev = map.get(cfg.hash);
    if (!prev) {
      map.set(cfg.hash, cfg);
      stats.added++;
    } else {
      const best = pickBest(prev, cfg);
      // Категория теперь по протоколу (см. parseVlessLine): если ЛЮБОЙ вариант этого host:port —
      // REALITY (white), сервер попадает в премиум-раздел «Белые списки». pickBest и так предпочитает
      // reality-представителя, но подстрахуемся явно.
      if (prev.category === 'white' || cfg.category === 'white') best.category = 'white';
      map.set(cfg.hash, best);
      stats.merged++;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf('vless://', 1) !== -1) {
      for (const p of splitGluedLine(line)) handle(p);
    } else {
      handle(line);
    }
  }
  return stats;
}

module.exports = {
  parseSource,
  mergeInto,
  flagToIso,
  isoToFlag,
  COUNTRY_RU,
  COUNTRY_ISO,
  nameRuOf,
  genToken,
  hashUri,
  // SPEC-SOURCES §3: канонический ключ и его хэш (использует db.rehash-миграция и парсер)
  canonicalKey,
  configHash,
  parseAuthority,
  // SPEC-SOURCES §2: нормализация тела источника
  maybeDecodeB64,
  splitGluedLine,
  schemeOf,
  isAllowedProtocol,
  // SPEC-SOURCES §3.3: выбор лучшего представителя при коллизии canonicalKey
  pickBest,
  esc,
  fmtDate,
  fmtDateTime,
  b64utf8,
};
