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
    // SPEC §6 + SPEC-QTY §5 + SPEC-SOURCES §4.4: живые конфиги заказа — единая точка db.liveRowsForOrder
    // (заказ с qty → РОВНО купленное на регион, стабильно; старый заказ qty NULL → все серверы + fallback;
    // пул order.list_type). Ту же выборку дедупит объединённый ключ (SPEC-MERGE §4): merged =
    // дедуп(объединение индивидуальных подписок).
    lines = db.liveRowsForOrder(order).map(rebrandUri);
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

/* ─────────────── объединённый ключ (SPEC-MERGE §4) ─────────────── */

/** DD.MM (Москва) из unix-секунд — метка «· до DD.MM» в объединённом ключе. */
function ddmm(unixSec) {
  return util.fmtDate(unixSec).slice(0, 5);
}

/** Ребренд фрагмента сервера объединённого ключа: FAMAS ⁂ <флаг> <СтранаRu> · до DD.MM (срок владельца). */
function rebrandMergedUri(row, expiresAt) {
  const ruNameRaw = util.nameRuOf(row.country_iso, row.country_name);
  const ruName = ruNameRaw && ruNameRaw !== 'XX' ? ruNameRaw : '';
  const flag =
    row.flag || (row.country_iso && row.country_iso !== 'XX' ? util.isoToFlag(row.country_iso) : '');
  let label = 'FAMAS ⁂';
  if (flag) label += ' ' + flag;
  if (ruName) label += ' ' + ruName;
  if (expiresAt) label += ' · до ' + ddmm(expiresAt);
  const base = String(row.uri).split('#')[0];
  return base + '#' + encodeURIComponent(label);
}

/**
 * buildMerged(userId) -> { lines, b64, headers, servers, expiresMax, regions } (SPEC-MERGE §4).
 * Динамическое объединение всех АКТИВНЫХ заказов юзера: живые серверы каждого (db.mergedBundle),
 * дедуп по host:port:uuid, ребренд «FAMAS ⁂ <флаг> <СтранаRu> · до DD.MM» (срок заказа-владельца
 * сервера). Заголовки как §6 SPEC, но subscription-userinfo.expire = expiresMax (макс срок активных
 * заказов, чтобы клиент не считал ключ просроченным раньше времени). Пусто, если активных заказов нет
 * (как истёкший). UA-gate (SPEC-HARDEN) применяется на server-слое так же, как для /s/:token заказа.
 */
function buildMerged(userId) {
  const bundle = db.mergedBundle(userId);
  const lines = bundle.rows.map((r) => rebrandMergedUri(r.row, r.expiresAt));
  const b64 = util.b64utf8(lines.join('\n'));

  const user = db.getUser(userId);
  const token = user && user.merged_token ? String(user.merged_token) : '';
  const expiresMax = Number(bundle.expiresMax) || 0;

  const headers = {
    'profile-title': 'base64:' + util.b64utf8('⁂ FAMAS STORE'),
    'profile-update-interval': String(config.SUB_UPDATE_HOURS),
    'subscription-userinfo': `upload=0; download=0; total=0; expire=${expiresMax}`,
    'support-url': 'https://t.me/' + config.SUPPORT_USERNAME,
    'content-disposition': 'attachment; filename=famas.txt',
  };
  if (token) headers['profile-web-page-url'] = pageUrl(token);

  return { lines, b64, headers, servers: bundle.servers, expiresMax, regions: bundle.regions };
}

module.exports = { subUrl, pageUrl, deepLinks, buildSub, buildMerged };
