'use strict';
/**
 * src/subscription.js — сборка живой подписки по заказу (SPEC §6).
 */
const config = require('./config');
const db = require('./db');
const util = require('./util');

function subUrl(token) {
  return `${config.PUBLIC_BASE}/s/${token}`;
}

function pageUrl(token) {
  return `${config.PUBLIC_BASE}/k/${token}`;
}

function deepLinks(subUrlStr) {
  return {
    happ: 'happ://add/' + subUrlStr,
    v2raytun: 'v2raytun://import/' + subUrlStr,
    v2rayng: 'v2rayng://install-sub?url=' + encodeURIComponent(subUrlStr) + '&name=FAMAS%20STORE',
  };
}

function safeParseRegions(val) {
  if (Array.isArray(val)) return val;
  try {
    const a = JSON.parse(val);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

/** Разобрать orders.qty ({iso:count} JSON) → объект или null (старый заказ). */
function safeParseQty(val) {
  if (val == null) return null;
  let o = val;
  if (typeof val === 'string') {
    try {
      o = JSON.parse(val);
    } catch (e) {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return Object.keys(o).length ? o : null;
}

/** переписать фрагмент uri на брендовый: FAMAS ⁂ <флаг> <СтранаRu> · <Город> */
function rebrandUri(row) {
  const ruNameRaw = util.nameRuOf(row.country_iso, row.country_name);
  const ruName = ruNameRaw && ruNameRaw !== 'XX' ? ruNameRaw : '';
  const flag =
    row.flag || (row.country_iso && row.country_iso !== 'XX' ? util.isoToFlag(row.country_iso) : '');
  let label = 'FAMAS ⁂';
  if (flag) label += ' ' + flag;
  if (ruName) label += ' ' + ruName;
  if (row.city) label += ' · ' + row.city;
  const base = String(row.uri).split('#')[0];
  return base + '#' + encodeURIComponent(label);
}

/**
 * buildSub(order) -> { lines, b64, headers, regions, expired }
 * Контент живой: конфиги берутся из БД на момент запроса.
 */
function buildSub(order) {
  const regions = safeParseRegions(order.regions);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = nowSec > Number(order.expires_at || 0);

  let lines = [];
  if (!expired) {
    // SPEC-QTY §5: заказ с qty → РОВНО купленное число серверов на регион (стабильно
    // по hash + добор fallback). Старый заказ (qty IS NULL) → прежний путь: все серверы.
    const qty = safeParseQty(order.qty);
    const rows = qty
      ? db.configsForRegionsQty(qty)
      : db.configsForRegions(regions).concat(db.fallbackForRegions(regions));
    lines = rows.map(rebrandUri);
  }

  const b64 = util.b64utf8(lines.join('\n'));

  const headers = {
    'profile-title': 'base64:' + util.b64utf8('⁂ FAMAS STORE'),
    // SPEC-HARDEN ч.1 §3: интервал перечитывания подписки клиентом (часы), из config (дефолт 1).
    'profile-update-interval': String(config.SUB_UPDATE_HOURS),
    'subscription-userinfo': `upload=0; download=0; total=0; expire=${Number(order.expires_at || 0)}`,
    'profile-web-page-url': pageUrl(order.token),
    'support-url': 'https://t.me/' + config.SUPPORT_USERNAME,
    'content-disposition': 'attachment; filename=famas.txt',
  };

  return { lines, b64, headers, regions, expired };
}

module.exports = { subUrl, pageUrl, deepLinks, buildSub };
