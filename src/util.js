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

/** sha256 hex от строки uri */
function hashUri(uri) {
  return crypto.createHash('sha256').update(String(uri), 'utf8').digest('hex');
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

/** host:port из authority vless-URI (uuid@host:port; IPv6 в [скобках]) */
function parseHostPort(uri) {
  try {
    const noScheme = String(uri).slice('vless://'.length);
    let end = noScheme.length;
    for (const ch of ['?', '#']) {
      const i = noScheme.indexOf(ch);
      if (i !== -1 && i < end) end = i;
    }
    const authority = noScheme.slice(0, end);
    const at = authority.lastIndexOf('@');
    const hostport = at === -1 ? authority : authority.slice(at + 1);
    let host = '';
    let port = 0;
    if (hostport.startsWith('[')) {
      const close = hostport.indexOf(']');
      if (close === -1) return { host: hostport, port: 0 };
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
    return { host, port };
  } catch (e) {
    return { host: '', port: 0 };
  }
}

/** одна строка vless:// -> объект конфига (или null, если совсем мусор) */
function parseVlessLine(uri) {
  try {
    const { host, port } = parseHostPort(uri);

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

    // остаток без флага; хвостовые бейджи | ... | отрезаем — берём первый сегмент до '|'
    const noFlag = flag ? label.replace(flag, ' ') : label;
    const firstSeg = (noFlag.split('|')[0] || '').trim();

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

    return {
      uri,
      host,
      port,
      flag,
      countryIso,
      countryName,
      city,
      label,
      hash: hashUri(uri),
    };
  } catch (e) {
    return null;
  }
}

/**
 * parseSource(text) -> { meta:{title,count,dateLine}, configs:[{uri,host,port,flag,countryIso,countryName,city,label,hash}] }
 * Дубликаты uri (одинаковый hash) схлопываются — остаётся первый.
 */
function parseSource(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const meta = { title: '', count: 0, dateLine: '' };
  const configs = [];
  const seen = new Set();
  let firstHeader = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!line.startsWith('vless://')) {
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

    const parsed = parseVlessLine(line);
    if (!parsed || !parsed.hash) continue;
    if (seen.has(parsed.hash)) continue;
    seen.add(parsed.hash);
    configs.push(parsed);
  }

  if (!meta.title && firstHeader) meta.title = firstHeader;
  if (!meta.count) meta.count = configs.length;
  return { meta, configs };
}

module.exports = {
  parseSource,
  flagToIso,
  isoToFlag,
  COUNTRY_RU,
  COUNTRY_ISO,
  genToken,
  hashUri,
  esc,
  fmtDate,
  fmtDateTime,
  b64utf8,
};
