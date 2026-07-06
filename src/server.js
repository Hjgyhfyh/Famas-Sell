'use strict';

/**
 * FAMAS STORE — HTTP-слой (агент SERVER, §9 SPEC.md + §4.1 SPEC-V2.md).
 *
 * Экспорт: createServer(botApi) -> express app (без .listen — его вызывает index.js).
 * botApi (bot.api из grammY) нужен только POST /famas/api/order — там создаётся
 * ссылка-инвойс Telegram Stars: createInvoiceLink(..., '' (пустой provider_token), 'XTR', prices).
 *
 * Все маршруты — С ПРЕФИКСОМ /famas (префикс входит в пути, nginx проксирует как есть):
 *   GET  /famas/api/regions       витрина регионов + цена/срок
 *   POST /famas/api/order         pending-заказ + invoiceLink (XTR)
 *   GET  /famas/api/me            заказы владельца initData
 *   GET  /famas/api/key/:token    данные ключа для страницы товара
 *   GET  /famas/s/:token          подписка: заголовки §6 + тело base64
 *   GET  /famas/qr/:token.svg     QR-код ссылки-подписки (SVG)
 *   GET  /famas/k/:token          страница товара (public/key.html)
 *   GET  /famas/app/*             статика mini app (public/app), кеш 10 мин
 *   GET  /famas/flags/*           SVG-флаги (public/flags), кеш 30 дней immutable
 *   GET  /famas/health            статус процесса
 *   всё остальное                 404 text/plain 'famas: not found'
 */

const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const config = require('./config');
const db = require('./db');
const util = require('./util');
const inventory = require('./inventory');
const subscription = require('./subscription');
const saleslog = require('./saleslog');
const tgauth = require('./tgauth');

// По контракту §7 tgauth экспортирует validateInitData; страховка на случай экспорта функцией.
const validateInitData = typeof tgauth === 'function' ? tgauth : tgauth.validateInitData;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Токены заказов — base64url от randomBytes(16) → 22 символа; берём с запасом.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/* ──────────────── SPEC-HARDEN ч.2 §1: UA-gate на /famas/s/:token ──────────────── */

// Списки маркеров — из config (env-переопределяемые). allow — реальные VPN-клиенты,
// block — явные браузеры/утилиты.
const VPN_UA_ALLOW = Array.isArray(config.VPN_UA_ALLOW) ? config.VPN_UA_ALLOW : [];
const BROWSER_UA_BLOCK = Array.isArray(config.BROWSER_UA_BLOCK) ? config.BROWSER_UA_BLOCK : [];

/**
 * «Похоже на браузер/утилиту» → отдать страницу-подсказку вместо сырой подписки.
 * Порядок важен: СНАЧАЛА allow (реальный VPN-клиент по подстроке → НЕ режем, даже если в UA
 * затесались 'safari'/'mozilla'), ЗАТЕМ block (явный браузер/утилита → режем). Пустой и
 * незнакомый UA → НЕ режем (пропускаем к подписке) — безопаснее белого списка, не ломает
 * реальные приложения (SPEC-HARDEN ч.2 §1: резать только явные браузеры/утилиты).
 */
function isBrowserLikeUA(ua) {
  const s = String(ua == null ? '' : ua).toLowerCase();
  if (!s) return false; // пустой UA — многие клиенты его не шлют → пропускаем
  for (const m of VPN_UA_ALLOW) if (m && s.includes(m)) return false; // реальный VPN-клиент
  for (const b of BROWSER_UA_BLOCK) if (b && s.includes(b)) return true; // браузер/утилита
  return false; // незнакомый UA — пропускаем к подписке
}

/** ?app=1 / app=true / заголовок X-Famas-App:1 — форс-выдача подписки (для наших deep-link кнопок). */
function forcesAppDelivery(req) {
  const a = req.query && req.query.app;
  if (a === '1' || a === 'true') return true;
  return String(req.get('X-Famas-App') || '') === '1';
}

/** Маленькая ЧБ страница-подсказка «открой в приложении» вместо сырых конфигов (self-contained). */
function subGateStubHtml(pageUrlStr) {
  const href = String(pageUrlStr || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<!doctype html><html lang="ru"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex,nofollow">',
    '<title>FAMAS STORE — подписка</title>',
    '<style>',
    ':root{color-scheme:dark}*{box-sizing:border-box}',
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px}",
    '.card{max-width:420px;width:100%;border:1px solid #1a1a1a;padding:28px 24px;text-align:center}',
    ".brand{font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:.04em;margin:0 0 6px}",
    '.rule{height:1px;background:#1a1a1a;margin:16px 0}',
    'h1{font-size:14px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin:0 0 12px}',
    'p{font-size:14px;line-height:1.55;color:#999;margin:0 0 10px}',
    ".mono{font-family:'SF Mono','Cascadia Mono',Consolas,monospace;font-size:12px;color:#666}",
    'a.btn{display:block;margin-top:18px;padding:14px;background:#fff;color:#000;text-decoration:none;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px}',
    '.foot{margin-top:16px;font-size:11px;color:#444}',
    '</style></head><body><div class="card">',
    '<div class="brand">FAMAS STORE ⁂</div>',
    '<div class="rule"></div>',
    '<h1>Это ссылка-подписка</h1>',
    '<p>Её нужно открыть в VPN-приложении (Happ · v2rayTun · v2rayNG), а не в браузере.</p>',
    '<p class="mono">На странице ключа — кнопки для приложений и QR-код.</p>',
    '<a class="btn" href="' + href + '">Открыть страницу ключа</a>',
    '<div class="foot">⁂ FAMAS STORE</div>',
    '</div></body></html>',
  ].join('');
}

/* ────────────────────────────── помощники ────────────────────────────── */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function logErr(where, err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(new Date().toISOString() + ' [server] ' + where + ': ' + msg);
}

/** Обёртка async-роутов: express 4 сам не ловит отклонённые промисы. */
function wrap(fn) {
  return function (req, res, next) {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

/** Русские склонения: plural(3, 'регион', 'региона', 'регионов') → 'региона'. */
function plural(n, one, few, many) {
  const a = Math.abs(Number(n) || 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** regions заказа лежат в БД JSON-строкой (§3) — разбираем аккуратно. */
function orderRegions(order) {
  if (!order) return [];
  const v = order.regions;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
    } catch (e) {
      // не JSON — считаем, что регионов нет
    }
  }
  return [];
}

/** orders.qty ({iso:count} JSON) → объект или null (старый заказ; SPEC-QTY §6). */
function orderQty(order) {
  if (!order || order.qty == null) return null;
  let o = order.qty;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch (e) {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return Object.keys(o).length ? o : null;
}

/** Сумма купленных серверов заказа (Σqty). */
function sumQty(qty) {
  let n = 0;
  if (qty) for (const k of Object.keys(qty)) n += Number(qty[k]) || 0;
  return n;
}

// SPEC-STABILITY2 §5: пометки для выдачи, когда живых серверов временно меньше купленного. Ключ
// НИКОГДА не выглядит «пропавшим»: при 0 живых показываем усиленный текст «обновляются, скоро
// вернутся» (не «пусто/исчезло»); при частичной недоступности — мягкую «часть недоступна».
const NOTE_REFRESHING = '△ серверы временно обновляются, скоро вернутся';
const NOTE_PARTIAL = 'Часть серверов временно недоступна — заменятся автоматически.';
function serverNote(available, purchased) {
  const a = Number(available) || 0;
  const p = Number(purchased) || 0;
  if (p > 0 && a === 0) return NOTE_REFRESHING; // 0 живых, но заказ куплен → «обновляются»
  if (a < p) return NOTE_PARTIAL; // часть недоступна
  return null;
}

/** Заказ «действует»: оплачен/подарен и срок не вышел (§6: expired = now > expires_at). */
function isOrderActive(order, now) {
  return Boolean(
    order &&
    (order.status === 'paid' || order.status === 'gift') &&
    order.expires_at &&
    now <= order.expires_at
  );
}

/** Конфиги, которые попадут в подписку заказа: активные + fallback (ровно как buildSub §6).
 * SPEC-SOURCES §4.4: listType (дефолт 'black') — пул заказа; старые заказы = black (совместимо). */
function subConfigsSafe(isos, where, listType) {
  if (!Array.isArray(isos) || isos.length === 0) return [];
  const lt = listType === 'white' ? 'white' : 'black';
  let main = [];
  let fb = [];
  try {
    main = db.configsForRegions(isos, lt) || [];
  } catch (e) {
    logErr(where + '/configsForRegions', e);
  }
  try {
    fb = db.fallbackForRegions(isos) || [];
  } catch (e) {
    logErr(where + '/fallbackForRegions', e);
  }
  return main.concat(fb);
}

/** Проверка initData Telegram WebApp (общая для /api/order и /api/me). */
function authFromInitData(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  if (typeof validateInitData !== 'function') {
    logErr('tgauth', new Error('validateInitData недоступна'));
    return null;
  }
  let auth = null;
  try {
    auth = validateInitData(raw);
  } catch (e) {
    logErr('validateInitData', e);
    return null;
  }
  if (!auth || auth.ok !== true || !auth.user || !auth.user.id) return null;
  return auth;
}

/* ───────────────────────── админка (SPEC-ADMIN §2) ───────────────────────── */

/** initData админ-запроса: из query ?initData= или заголовка X-Init-Data. */
function adminInitData(req) {
  let raw = typeof req.query.initData === 'string' ? req.query.initData : '';
  if (!raw) {
    const h = req.get('X-Init-Data');
    if (typeof h === 'string') raw = h;
  }
  return raw;
}

/**
 * requireAdmin(initData) -> {ok:true, user} | {ok:false}
 * validateInitData (HMAC + свежесть) И user.id ∈ config.ADMIN_IDS. Иначе {ok:false} → 403.
 */
function requireAdmin(initData) {
  const auth = authFromInitData(initData);
  if (!auth) return { ok: false };
  const id = Number(auth.user.id);
  if (!Array.isArray(config.ADMIN_IDS) || !config.ADMIN_IDS.includes(id)) return { ok: false };
  return { ok: true, user: auth.user };
}

/** Русское имя региона по iso: из свежей сводки, иначе фолбэк nameRuOf (для неактивных). */
function nameRuFor(iso, summaryByIso) {
  const s = summaryByIso && summaryByIso.get(iso);
  if (s && s.nameRu) return s.nameRu;
  return util.nameRuOf(iso, null) || iso;
}

/**
 * Маппинг сырой строки ordersForAdmin → API-форма (SPEC-ADMIN §2).
 * regions из qty JSON {iso:count}; старый заказ (qty NULL) → по regions с qty:null
 * (servers = число выданных конфигов). kind: gift→'gift'; FREE/0⭐→'free'; иначе 'paid'.
 */
function mapAdminOrder(row, now, summaryByIso) {
  const isos = orderRegions(row);
  const qty = orderQty(row);

  let regions;
  let servers;
  if (qty) {
    regions = isos.map((iso) => ({
      iso: iso,
      nameRu: nameRuFor(iso, summaryByIso),
      flag: util.isoToFlag(iso),
      qty: Number(qty[iso]) || 0,
    }));
    servers = sumQty(qty);
  } else {
    // старый заказ: количество серверов = число реально выданных конфигов, ×N не показываем
    const cfgs = subConfigsSafe(isos, 'admin/orders');
    servers = cfgs.length;
    regions = isos.map((iso) => ({
      iso: iso,
      nameRu: nameRuFor(iso, summaryByIso),
      flag: util.isoToFlag(iso),
      qty: null,
    }));
  }

  let kind;
  if (row.status === 'gift') kind = 'gift';
  else if (row.charge_id === 'FREE' || Number(row.stars) === 0) kind = 'free';
  else kind = 'paid';

  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    firstName: row.first_name || null,
    kind: kind,
    // SPEC-IDEAS §1: renewal-«чек» — id продлённого заказа (NULL у обычных покупок).
    renewOf: row.renew_of != null ? Number(row.renew_of) : null,
    stars: Number(row.stars) || 0,
    servers: servers,
    regions: regions,
    createdAt: row.created_at || null,
    paidAt: row.paid_at || null,
    expiresAt: row.expires_at || null,
    active: isOrderActive(row, now),
    token: row.token,
    page: subscription.pageUrl(row.token),
  };
}

/* ─────────────────── объединённый ключ (SPEC-MERGE §5) ─────────────────── */

/**
 * resolveToken(token) -> {kind:'order', order} | {kind:'merged', user} | null (SPEC-MERGE §5).
 * Сперва пробуем заказ (обычный случай), затем объединённый токен юзера. TOKEN_RE-гейт как везде.
 */
function resolveToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  let order = null;
  try {
    order = db.getOrderByToken(token);
  } catch (e) {
    logErr('resolveToken/order', e);
  }
  if (order) return { kind: 'order', order: order };
  let user = null;
  try {
    user = db.getUserByMergedToken(token);
  } catch (e) {
    logErr('resolveToken/merged', e);
  }
  if (user) return { kind: 'merged', user: user };
  return null;
}

/**
 * Объект «единого ключа» для /api/me и /api/merge (SPEC-MERGE §5): токен, страница, подписка,
 * серверов (дедуп-живых), макс срок, регионы с их qty/сроками. Данные — из db.mergedSummary.
 */
function mergedKeyObject(userId, token) {
  const s = db.mergedSummary(userId);
  const sub = subscription.subUrl(token);
  return {
    token: token,
    page: subscription.pageUrl(token),
    sub: sub,
    servers: s.servers,
    serversAvailable: s.servers,
    expiresMax: s.expiresMax,
    active: s.orders > 0,
    orders: s.orders,
    regions: s.regions.map((r) => ({
      iso: r.iso,
      nameRu: r.nameRu,
      flag: r.flag,
      qty: r.qty,
      liveServers: r.liveServers,
      expiresAt: r.expiresAt,
    })),
    links: subscription.deepLinks(sub),
  };
}

/**
 * Ответ /api/key/:token для объединённого токена (SPEC-MERGE §5): объединённые regions с их сроками,
 * servers, active=есть ли активные заказы. Поля выровнены под форму заказа (regions/servers/sub/page/
 * links/active/expiresAt), чтобы страница ключа рендерила объединённый ключ теми же средствами.
 */
function mergedKeyResponse(user) {
  const token = user.merged_token;
  const s = db.mergedSummary(user.id);
  const sub = subscription.subUrl(token);
  const regions = s.regions.map((r) => ({
    iso: r.iso,
    nameRu: r.nameRu,
    flag: r.flag,
    count: r.qty, // купленное ×N
    available: r.liveServers, // доступно живых
    expiresAt: r.expiresAt, // срок этого региона (свой заказ)
  }));
  // «частично» = есть регион, полностью погасший сейчас (0 живых при купленном qty>0), либо
  // суммарно живых меньше купленного. SPEC-STABILITY2 §5: при 0 живых во всём ключе — «обновляются».
  const purchasedTotal = regions.reduce((n, r) => n + (Number(r.count) || 0), 0);
  const availTotal = Number(s.servers) || 0;
  const partial =
    availTotal < purchasedTotal ||
    regions.some((r) => (Number(r.count) || 0) > 0 && (Number(r.available) || 0) === 0);
  const lr = inventory.lastRefresh || null;
  return {
    ok: true,
    merged: true,
    orderId: null,
    status: 'merged',
    regions: regions,
    servers: s.servers,
    serversAvailable: s.servers,
    partial: partial,
    note: serverNote(availTotal, purchasedTotal),
    expiresAt: s.expiresMax,
    expiresMax: s.expiresMax,
    orders: s.orders,
    active: s.orders > 0,
    sub: sub,
    page: subscription.pageUrl(token),
    links: subscription.deepLinks(sub),
    createdAt: null,
    updatedAt: lr && lr.at ? lr.at : null,
    // SPEC-IDEAS §1: объединённый ключ целиком не продлевается — продлеваются отдельные заказы.
    canRenew: false,
    renewStars: null,
    renewDays: null,
  };
}

/* ────────────────────────────── сервер ────────────────────────────── */

function createServer(botApi) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // сидим за nginx на 127.0.0.1

  // Заголовки безопасности — на все ответы.
  app.use(function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // API не кешируем.
  app.use('/famas/api', function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  /* GET /famas/api/regions — витрина: регионы, цена, срок, всего серверов.
   * SPEC-V3 §B.4: ?list=main|unstable|white (дефолт main; 'black' = main для совместимости).
   *   main     → основной каталог (чёрный пул, alive > UNSTABLE_MAX), цена 20;
   *   unstable → нестабильные регионы (чёрный пул, alive 1..UNSTABLE_MAX), цена 7, флаг предупреждения;
   *   white    → белые списки (белый пул), цена 50. */
  app.get('/famas/api/regions', function (req, res) {
    const raw = req.query && req.query.list;
    const section = raw === 'white' ? 'white' : raw === 'unstable' ? 'unstable' : 'main';
    const regions = db.regionsSummary(section) || [];
    let total = 0;
    for (const r of regions) total += Number(r.count) || 0;
    const lr = inventory.lastRefresh || null;
    res.json({
      ok: true,
      list: section, // раздел витрины (main|unstable|white)
      unstable: section === 'unstable', // SPEC-V3 §B.4: показать предупреждающую плашку на витрине
      regions, // каждый регион уже с popularity (regionsSummary, SPEC-QTY §3/§4)
      price: db.priceStars(section), // SPEC-V3 §B: main → 20, unstable → 7, white → 50
      extra: db.extraStars(), // доплата за доп. сервер (SPEC-QTY §6)
      subDays: db.subDays(),
      total,
      updatedAt: lr && lr.at ? lr.at : null
    });
  });

  /* POST /famas/api/order — pending-заказ + инвойс Telegram Stars (XTR). */
  app.post('/famas/api/order', wrap(async function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const auth = authFromInitData(body.initData);
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Авторизация не пройдена — открой магазин из Telegram' });
    }

    // SPEC-V3 §B.3: раздел заказа — 'main' (дефолт; 'black' = main для совместимости) | 'unstable'
    // (нестабильные, цена 7) | 'white' (премиум, цена 50). section влияет на base-цену и пул валидации
    // (reserveOrder); listType — реальный пул ДОСТАВКИ и orders.list_type (buildSub по нему): main и
    // unstable доставляются из чёрного пула (отличаются только ценой/предупреждением), white — из белого.
    const section = body.list === 'white' ? 'white' : body.list === 'unstable' ? 'unstable' : 'main';
    const listType = section === 'white' ? 'white' : 'black';

    // Тело заказа — три совместимых формата (SPEC-QTY §6):
    //   {items:[{iso,qty}]} (предпочтительно) | {qty:{iso:count}} | {regions:[iso]} (каждый qty=1).
    // Собираем qtyMap {iso:count}; аккуратная валидация ISO/кол-ва.
    const qtyInput = {};
    const addQty = (isoRaw, countRaw) => {
      const iso = String(isoRaw == null ? '' : isoRaw).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso)) return { error: 'Некорректный код региона' };
      const c = Math.floor(Number(countRaw));
      if (!Number.isFinite(c) || c < 1) return { error: 'Некорректное количество серверов' };
      qtyInput[iso] = (qtyInput[iso] || 0) + c;
      return null;
    };

    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        if (!it || typeof it !== 'object') {
          return res.status(400).json({ ok: false, error: 'Некорректный формат позиции заказа' });
        }
        const err = addQty(it.iso, it.qty == null ? 1 : it.qty);
        if (err) return res.status(400).json({ ok: false, error: err.error });
      }
    } else if (body.qty && typeof body.qty === 'object' && !Array.isArray(body.qty)) {
      for (const [k, v] of Object.entries(body.qty)) {
        const err = addQty(k, v);
        if (err) return res.status(400).json({ ok: false, error: err.error });
      }
    } else if (Array.isArray(body.regions)) {
      for (const r of body.regions) {
        const err = addQty(r, 1); // старый формат: каждый регион = 1 сервер
        if (err) return res.status(400).json({ ok: false, error: err.error });
      }
    }

    const isos = Object.keys(qtyInput);
    if (isos.length === 0) {
      return res.status(400).json({ ok: false, error: 'Выбери хотя бы один регион' });
    }
    if (isos.length > 100) {
      return res.status(400).json({ ok: false, error: 'Слишком много регионов в одном заказе' });
    }
    let totalServers = 0;
    for (const iso of isos) totalServers += qtyInput[iso];
    if (totalServers > 500) {
      return res.status(400).json({ ok: false, error: 'Слишком много серверов в одном заказе' });
    }

    try {
      db.upsertUser({
        id: auth.user.id,
        username: auth.user.username || null,
        first_name: auth.user.first_name || null
      });
    } catch (e) {
      logErr('order/upsertUser', e); // не критично для заказа
    }

    const days = db.subDays();
    // АТОМАРНОЕ оформление со скидкой (§7b): free списывается ПРЯМО СЕЙЧАС в одной
    // транзакции (не при выдаче) — закрывает абьюз частичной скидки. Валидация qty
    // (активность региона, 1<=count<=available) — внутри reserveOrder: бросит Error → 400,
    // free при этом НЕ списывается (валидация до транзакции). q.stars/q.servers — итог.
    let q;
    try {
      q = db.reserveOrder(auth.user.id, qtyInput, section); // SPEC-V3 §B: base/валидация по разделу
    } catch (e) {
      return res.status(400).json({ ok: false, error: (e && e.message) || 'Некорректный заказ' });
    }

    // Полностью бесплатный заказ: выдаём сразу, БЕЗ invoiceLink и без botApi (XTR на 0 нельзя).
    if (q.fullyFree) {
      const created = db.createOrder({
        userId: auth.user.id,
        regions: isos,
        qty: qtyInput,
        stars: 0,
        status: 'paid',
        days,
        freeApplied: q.freeUsed,
        bonusApplied: q.bonusUsed,
        chargeId: 'FREE',
        listType: listType
      });
      if (!created || !created.id) {
        return res.status(500).json({ ok: false, error: 'Не удалось создать заказ' });
      }
      // free уже списан атомарно в reserveOrder (§7b) — повторный consumeFree тут был бы двойным списанием.
      try {
        db.logEvent('free_order', { orderId: created.id, userId: auth.user.id, regions: isos, qty: qtyInput, freeApplied: q.freeUsed });
      } catch (e) {
        logErr('order/logEvent', e);
      }
      // SPEC-LOG §5: лог бесплатной выдачи (через mini app) в приватный канал.
      // botApi может быть null (SKIP_BOT) — saleslog это сам глотает (no-op). Fire-and-forget.
      try {
        const fullOrder = db.getOrder(created.id);
        saleslog.logSale(botApi, fullOrder, 'free').catch(() => {});
      } catch (e) {
        logErr('order/saleslog', e);
      }
      return res.json({
        ok: true,
        free: true,
        list: section, // SPEC-V3 §B: раздел заказа (main|unstable|white)
        orderId: created.id,
        page: subscription.pageUrl(created.token),
        sub: subscription.subUrl(created.token),
        servers: q.servers, // Σqty
        regions: isos,
        freeApplied: q.freeUsed,
        bonusApplied: q.bonusUsed
      });
    }

    // Обычная (в т.ч. частичная) оплата: pending + инвойс только на платную часть.
    const created = db.createOrder({
      userId: auth.user.id,
      regions: isos,
      qty: qtyInput,
      stars: q.stars,
      status: 'pending',
      days,
      freeApplied: q.freeUsed,
      bonusApplied: q.bonusUsed,
      listType: listType
    });
    if (!created || !created.id) {
      return res.status(500).json({ ok: false, error: 'Не удалось создать заказ' });
    }

    if (!botApi || typeof botApi.createInvoiceLink !== 'function') {
      logErr('order/invoice', new Error('botApi.createInvoiceLink недоступен'));
      return res.status(503).json({ ok: false, error: 'Оплата временно недоступна, попробуй позже' });
    }

    const daysWord = plural(days, 'день', 'дня', 'дней');
    // Регионы в описании: флаг + ×N для регионов с несколькими серверами.
    let description = 'Регионы: ' + isos.map((iso) => {
      const f = util.isoToFlag(iso) || iso;
      return qtyInput[iso] > 1 ? f + '×' + qtyInput[iso] : f;
    }).join(' ') + ' · ' + days + ' ' + daysWord;
    if (q.freeUsed > 0) description += ' · −' + q.freeUsed + ' бесплатно';
    if (description.length > 255) {
      description = 'Серверов: ' + q.servers + ' в ' + q.regionsCount + ' стр. · ' + days + ' ' + daysWord;
      if (q.freeUsed > 0) description += ' · −' + q.freeUsed + ' бесплатно';
    }
    const label = 'VLESS · ' + q.servers + ' серв. в ' + q.regionsCount + ' стр.';

    let invoiceLink;
    try {
      // grammY: createInvoiceLink(title, description, payload, provider_token, currency, prices)
      invoiceLink = await botApi.createInvoiceLink(
        'FAMAS ⁂ VPN-ключ',
        description,
        'order:' + created.id,
        '', // provider_token пустой — оплата в Telegram Stars
        'XTR',
        [{ label: label, amount: q.stars }]
      );
    } catch (e) {
      logErr('order/createInvoiceLink', e);
      return res.status(502).json({ ok: false, error: 'Не удалось создать счёт, попробуй ещё раз' });
    }

    try {
      db.logEvent('order_created', { orderId: created.id, userId: auth.user.id, regions: isos, qty: qtyInput, stars: q.stars, freeApplied: q.freeUsed });
    } catch (e) {
      logErr('order/logEvent', e);
    }

    res.json({
      ok: true,
      list: section, // SPEC-V3 §B: раздел заказа (main|unstable|white)
      invoiceLink: invoiceLink,
      orderId: created.id,
      stars: q.stars,
      servers: q.servers, // Σqty
      freeApplied: q.freeUsed,
      bonusApplied: q.bonusUsed
    });
  }));

  /* GET /famas/api/me?initData=... — заказы владельца initData (paid|gift). */
  app.get('/famas/api/me', function (req, res) {
    const auth = authFromInitData(typeof req.query.initData === 'string' ? req.query.initData : '');
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Авторизация не пройдена — открой магазин из Telegram' });
    }

    const rows = db.ordersOfUser(auth.user.id) || [];
    const now = nowSec();
    const orders = rows.map(function (o) {
      const regions = orderRegions(o);
      const lt = o.list_type === 'white' ? 'white' : 'black'; // пул заказа (SPEC-SOURCES §4.4)
      const qty = orderQty(o); // SPEC-QTY §6: servers = Σqty (для новых) / configs len (старых)
      const servers = qty ? sumQty(qty) : subConfigsSafe(regions, 'me', lt).length;
      // SPEC-HARDEN ч.1 §5: доступно живых сейчас (Σ по регионам min(qty, aliveCount)).
      let serversAvailable = servers;
      try {
        const alive = db.aliveCountForRegions(regions, lt);
        let a = 0;
        for (const iso of regions) {
          const av = Number(alive.get(iso)) || 0;
          a += qty ? Math.min(Number(qty[iso]) || 0, av) : av;
        }
        serversAvailable = a;
      } catch (e) {
        logErr('me/aliveCountForRegions', e);
      }
      // SPEC-IDEAS §1: продление — доступно для любого выданного ключа (активного и истёкшего);
      // цена = повтор заказа (renewQuote чистый, ничего не списывает).
      let canRenew = false;
      let renewStars = null;
      let renewDays = null;
      try {
        const rq = db.renewQuote(o);
        canRenew = !!o.expires_at; // как в POST /api/renew: без срока продлевать нечего
        renewStars = rq.stars;
        renewDays = rq.days;
      } catch (e) {
        canRenew = false;
      }
      return {
        id: o.id,
        regions: regions,
        flags: regions.map((iso) => util.isoToFlag(iso)).join(''),
        status: o.status,
        expiresAt: o.expires_at || null,
        active: isOrderActive(o, now),
        page: subscription.pageUrl(o.token),
        sub: subscription.subUrl(o.token),
        servers: servers,
        serversAvailable: serversAvailable,
        // SPEC-STABILITY2 §5: заказ остаётся видимым даже при 0 живых (ordersOfUser НЕ фильтрует
        // по живости) — с пометкой «обновляются, скоро вернутся» вместо исчезновения.
        partial: serversAvailable < servers,
        note: serverNote(serversAvailable, servers),
        canRenew: canRenew,
        renewStars: renewStars,
        renewDays: renewDays
      };
    });

    let free = 0;
    try {
      free = db.getFree(auth.user.id);
    } catch (e) {
      logErr('me/getFree', e);
    }

    // SPEC-REFERRAL §6: бонус-баланс + реф-сводка (для реф-блока mini app).
    let bonus = 0;
    try {
      bonus = db.getBonus(auth.user.id);
    } catch (e) {
      logErr('me/getBonus', e);
    }
    let refI = { count: 0, bonus: 0, referredBy: null };
    try {
      refI = db.refInfo(auth.user.id);
    } catch (e) {
      logErr('me/refInfo', e);
    }
    const ref = {
      count: refI.count,
      bonus: refI.bonus,
      referredBy: refI.referredBy,
      link: 'https://t.me/' + config.BOT_USERNAME + '?start=ref' + auth.user.id,
    };

    // SPEC-MERGE §5: всегда отдаём canMerge (≥2 активных заказа) и текущее состояние merged.
    // Если merged включён и есть merged_token → ЕДИНЫЙ ключ (key) поверх списка orders (orders
    // оставляем — mini app сам решит, что показать: при merged=1 индивидуальные скрываются в UI).
    let canMerge = false;
    try {
      canMerge = (db.activeOrdersOf(auth.user.id) || []).length >= 2;
    } catch (e) {
      logErr('me/activeOrdersOf', e);
    }
    let mergedOn = false;
    let key = null;
    try {
      const u = db.getUser(auth.user.id);
      mergedOn = !!(u && u.merged === 1 && u.merged_token);
      if (mergedOn) key = mergedKeyObject(auth.user.id, u.merged_token);
    } catch (e) {
      logErr('me/merged', e);
    }

    res.json({
      ok: true,
      orders: orders,
      free: free,
      bonus: bonus,
      ref: ref,
      merged: mergedOn,
      canMerge: canMerge,
      key: key,
    });
  });

  /* POST /famas/api/merge — переключить объединённый ключ (SPEC-MERGE §5). */
  app.post('/famas/api/merge', function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const auth = authFromInitData(body.initData);
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Авторизация не пройдена — открой магазин из Telegram' });
    }
    const on = body.on === true || body.on === 1 || body.on === '1' || body.on === 'true';

    try {
      db.upsertUser({
        id: auth.user.id,
        username: auth.user.username || null,
        first_name: auth.user.first_name || null,
      });
    } catch (e) {
      logErr('merge/upsertUser', e);
    }

    let state;
    try {
      state = db.setMerged(auth.user.id, on);
    } catch (e) {
      logErr('merge/setMerged', e);
      return res.status(500).json({ ok: false, error: 'Не удалось изменить режим' });
    }

    let canMerge = false;
    try {
      canMerge = (db.activeOrdersOf(auth.user.id) || []).length >= 2;
    } catch (e) {
      logErr('merge/activeOrdersOf', e);
    }

    const merged = state.merged === 1 || state.merged === true;
    const resp = { ok: true, merged: merged, canMerge: canMerge, mergedToken: state.token || null };
    if (merged && state.token) resp.key = mergedKeyObject(auth.user.id, state.token);

    try {
      db.logEvent('merge_toggle', { userId: auth.user.id, on: merged });
    } catch (e) {
      /* журнал не критичен */
    }

    res.json(resp);
  });

  /* POST /famas/api/renew — продление ключа (SPEC-IDEAS §1): {initData, orderId} →
   * renewal-заказ владельца этого orderId (regions/qty/list_type — копия, renew_of=origId).
   * free/bonus применяются как в обычной покупке (атомарно, db.reserveRenewal). Полностью
   * покрыто скидками → продлеваем СРАЗУ (без инвойса — XTR на 0 нельзя); иначе invoiceLink,
   * а applyRenewal сработает в боте на successful_payment (строго один раз, гейт wasPending). */
  app.post('/famas/api/renew', wrap(async function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const auth = authFromInitData(body.initData);
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Авторизация не пройдена — открой магазин из Telegram' });
    }

    const orderId = Math.floor(Number(body.orderId));
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: 'Некорректный номер заказа' });
    }
    let order = null;
    try {
      order = db.getOrder(orderId);
    } catch (e) {
      logErr('renew/getOrder', e);
    }
    // чужой/несуществующий — единый 404 (не палим чужие номера заказов)
    if (!order || Number(order.user_id) !== Number(auth.user.id)) {
      return res.status(404).json({ ok: false, error: 'Ключ не найден' });
    }
    if ((order.status !== 'paid' && order.status !== 'gift') || order.renew_of != null || !order.expires_at) {
      return res.status(400).json({ ok: false, error: 'Этот заказ нельзя продлить' });
    }

    // АТОМАРНО (SPEC-FREE §7b): free/bonus списываются прямо сейчас; ошибка → ничего не списано.
    let q;
    try {
      q = db.reserveRenewal(auth.user.id, order);
    } catch (e) {
      return res.status(400).json({ ok: false, error: (e && e.message) || 'Не удалось посчитать продление' });
    }

    // Полностью покрыто free/бонусом: продлеваем сразу, БЕЗ invoiceLink и botApi.
    if (q.fullyFree) {
      const created = db.createOrder({
        userId: auth.user.id,
        regions: order.regions, // JSON-строка — копия оригинала
        qty: order.qty,
        stars: 0,
        status: 'paid',
        days: q.days,
        freeApplied: q.freeUsed,
        bonusApplied: q.bonusUsed,
        chargeId: 'FREE',
        listType: order.list_type,
        renewOf: order.id
      });
      if (!created || !created.id) {
        return res.status(500).json({ ok: false, error: 'Не удалось создать заказ' });
      }
      let orig = null;
      try {
        orig = db.applyRenewal(order.id, q.days);
      } catch (e) {
        logErr('renew/applyRenewal', e);
      }
      try {
        db.logEvent('renewal', {
          orderId: created.id, renewOf: order.id, userId: auth.user.id,
          stars: 0, free: true, freeApplied: q.freeUsed, bonusApplied: q.bonusUsed
        });
      } catch (e) {
        logErr('renew/logEvent', e);
      }
      // SPEC-LOG §5: транзакция реальная (0⭐ по free/бонусам) — в канал как free. Fire-and-forget.
      try {
        const fullOrder = db.getOrder(created.id);
        saleslog.logSale(botApi, fullOrder, 'free').catch(() => {});
      } catch (e) {
        logErr('renew/saleslog', e);
      }
      return res.json({
        ok: true,
        free: true,
        renewed: true,
        orderId: created.id,
        renewOf: order.id,
        days: q.days,
        expiresAt: orig ? orig.expires_at : null,
        freeApplied: q.freeUsed,
        bonusApplied: q.bonusUsed
      });
    }

    // Платное продление: pending renewal-заказ + инвойс ровно на q.stars (инвойс на 0 не создаётся).
    const created = db.createOrder({
      userId: auth.user.id,
      regions: order.regions,
      qty: order.qty,
      stars: q.stars,
      status: 'pending',
      days: q.days,
      freeApplied: q.freeUsed,
      bonusApplied: q.bonusUsed,
      listType: order.list_type,
      renewOf: order.id
    });
    if (!created || !created.id) {
      return res.status(500).json({ ok: false, error: 'Не удалось создать заказ' });
    }

    if (!botApi || typeof botApi.createInvoiceLink !== 'function') {
      logErr('renew/invoice', new Error('botApi.createInvoiceLink недоступен'));
      return res.status(503).json({ ok: false, error: 'Оплата временно недоступна, попробуй позже' });
    }

    const dWord = plural(q.days, 'день', 'дня', 'дней');
    let description = 'Продление ключа #' + order.id + ' · +' + q.days + ' ' + dWord;
    if (q.freeUsed > 0) description += ' · −' + q.freeUsed + ' бесплатно';
    if (q.bonusUsed > 0) description += ' · −' + q.bonusUsed + '⭐ бонус';

    let invoiceLink;
    try {
      invoiceLink = await botApi.createInvoiceLink(
        'FAMAS ⁂ Продление ключа',
        description.slice(0, 255),
        'order:' + created.id,
        '', // provider_token пустой — Telegram Stars
        'XTR',
        [{ label: 'Продление · ' + q.days + ' ' + dWord, amount: q.stars }]
      );
    } catch (e) {
      logErr('renew/createInvoiceLink', e);
      return res.status(502).json({ ok: false, error: 'Не удалось создать счёт, попробуй ещё раз' });
    }

    try {
      db.logEvent('renewal_created', {
        orderId: created.id, renewOf: order.id, userId: auth.user.id,
        stars: q.stars, freeApplied: q.freeUsed, bonusApplied: q.bonusUsed
      });
    } catch (e) {
      logErr('renew/logEvent', e);
    }

    res.json({
      ok: true,
      invoiceLink: invoiceLink,
      orderId: created.id,
      renewOf: order.id,
      stars: q.stars,
      days: q.days,
      freeApplied: q.freeUsed,
      bonusApplied: q.bonusUsed
    });
  }));

  /* GET /famas/api/key/:token — данные ключа для страницы товара (key.html). */
  app.get('/famas/api/key/:token', function (req, res) {
    const token = String(req.params.token || '');
    // SPEC-MERGE §5: :token может быть объединённым — тогда отдаём объединённый ключ.
    const r = resolveToken(token);
    if (!r) {
      return res.status(404).json({ ok: false, error: 'Ключ не найден' });
    }
    if (r.kind === 'merged') {
      return res.json(mergedKeyResponse(r.user));
    }
    const order = r.order;

    const isos = orderRegions(order);
    const lt = order.list_type === 'white' ? 'white' : 'black'; // пул заказа (SPEC-SOURCES §4.4)
    const qty = orderQty(order); // SPEC-QTY §6: count = купленное qty (для старых — available)
    const rows = subConfigsSafe(isos, 'key', lt);

    // Число серверов на регион по фактически выданным конфигам (для старых заказов).
    const countByIso = new Map();
    for (const c of rows) {
      const iso = c && c.country_iso ? c.country_iso : 'XX';
      countByIso.set(iso, (countByIso.get(iso) || 0) + 1);
    }

    const summaryByIso = new Map();
    try {
      for (const r of db.regionsSummary() || []) summaryByIso.set(r.iso, r);
    } catch (e) {
      logErr('key/regionsSummary', e);
    }

    // SPEC-HARDEN ч.1 §5: число ДОСТУПНЫХ (живых) серверов по регионам сейчас (пул заказа).
    const aliveCount = (() => {
      try {
        return db.aliveCountForRegions(isos, lt);
      } catch (e) {
        logErr('key/aliveCountForRegions', e);
        return new Map();
      }
    })();

    const regions = isos.map(function (iso) {
      const s = summaryByIso.get(iso);
      let nameRu = s && s.nameRu ? s.nameRu : null;
      if (!nameRu) {
        const row = rows.find((c) => c && c.country_iso === iso && c.country_name);
        nameRu = util.nameRuOf(iso, row && row.country_name);
      }
      // count: для нового заказа — купленное qty; для старого — реально выданные серверы.
      const count = qty ? (Number(qty[iso]) || 0) : (countByIso.get(iso) || 0);
      // available: доступно живых сейчас; для нового — не больше купленного (min(qty, aliveCount)).
      const alive = Number(aliveCount.get(iso)) || 0;
      const available = qty ? Math.min(count, alive) : alive;
      return {
        iso: iso,
        nameRu: nameRu || iso,
        flag: util.isoToFlag(iso),
        count: count,
        available: available
      };
    });

    // servers — купленное (совместимость); serversAvailable — Σ по регионам min(qty, aliveCount).
    const serversPurchased = qty ? sumQty(qty) : rows.length;
    let serversAvailable = 0;
    for (const r of regions) serversAvailable += Number(r.available) || 0;
    const partial = serversAvailable < serversPurchased;

    // SPEC-IDEAS §1: продление на странице ключа — canRenew/renewStars/renewDays.
    let canRenew = false;
    let renewStars = null;
    let renewDays = null;
    if ((order.status === 'paid' || order.status === 'gift') && order.renew_of == null && order.expires_at) {
      try {
        const rq = db.renewQuote(order);
        canRenew = true;
        renewStars = rq.stars;
        renewDays = rq.days;
      } catch (e) {
        canRenew = false;
      }
    }

    const sub = subscription.subUrl(order.token);
    const lr = inventory.lastRefresh || null;
    res.json({
      ok: true,
      orderId: order.id,
      status: order.status,
      regions: regions,
      servers: serversPurchased,          // Σqty (новые) / configs len (старые) — купленное
      serversAvailable: serversAvailable, // доступно живых сейчас (SPEC-HARDEN ч.1 §5)
      partial: partial,                   // доступно меньше купленного (часть серверов недоступна)
      // SPEC-STABILITY2 §5: при 0 живых — «обновляются, скоро вернутся» (ключ не «исчезает»).
      note: serverNote(serversAvailable, serversPurchased),
      expiresAt: order.expires_at || null,
      active: isOrderActive(order, nowSec()),
      sub: sub,
      page: subscription.pageUrl(order.token),
      links: subscription.deepLinks(sub),
      createdAt: order.created_at || null,
      updatedAt: lr && lr.at ? lr.at : null, // время последнего обновления базы (для «обновлено HH:MM»)
      canRenew: canRenew,
      renewStars: renewStars,
      renewDays: renewDays
    });
  });

  /* GET /famas/s/:token — подписка: заголовки из §6 + тело base64. */
  app.get('/famas/s/:token', function (req, res) {
    const token = String(req.params.token || '');
    // SPEC-MERGE §5: сперва заказ, затем объединённый токен юзера — тот же UA-gate/заголовки.
    const r = resolveToken(token);
    if (!r) {
      return res.status(404).type('text/plain; charset=utf-8').send('not found');
    }

    // SPEC-HARDEN ч.1 §3: /s не кешируем никогда (контент живой). Ставим до любой ветки.
    res.set('Cache-Control', 'no-store');

    // страница-подсказка ведёт на страницу ключа (заказа ИЛИ объединённого).
    const pageToken = r.kind === 'merged' ? r.user.merged_token : r.order.token;

    // UA-gate ОТКЛЮЧЁН по требованию владельца: ссылки подписки не скрываем, отдаём всем (браузер,
    // приложение, curl) — прямой доступ по ссылке ключа. Можно вернуть включив SUB_UA_GATE=1.
    void pageToken;
    if (config.SUB_UA_GATE && !forcesAppDelivery(req) && isBrowserLikeUA(req.get('user-agent'))) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(subGateStubHtml(subscription.pageUrl(pageToken)));
    }

    const sub =
      r.kind === 'merged' ? subscription.buildMerged(r.user.id) : subscription.buildSub(r.order);
    if (sub && sub.headers && typeof sub.headers === 'object') {
      res.set(sub.headers);
    }
    res.set('Cache-Control', 'no-store'); // buildSub/buildMerged мог не выставить — гарантируем no-store
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(sub && typeof sub.b64 === 'string' ? sub.b64 : '');
  });

  /* GET /famas/qr/:token.svg — QR-код ссылки-подписки. */
  app.get('/famas/qr/:token.svg', wrap(async function (req, res) {
    const token = String(req.params.token || '');
    // SPEC-MERGE §5: QR поддерживает и заказный, и объединённый токен (subUrl использует сам token).
    const r = resolveToken(token);
    if (!r) {
      return res.status(404).type('text/plain; charset=utf-8').send('not found');
    }

    const svg = await QRCode.toString(subscription.subUrl(token), {
      type: 'svg',
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  }));

  /* GET /famas/k/:token — страница товара; сама дёрнет /famas/api/key/:token. */
  app.get('/famas/k/:token', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'key.html'), function (err) {
      if (err) {
        logErr('k/sendFile', err);
        if (!res.headersSent) {
          res.status(404).type('text/plain; charset=utf-8').send('famas: not found');
        }
      }
    });
  });

  /* GET /famas/app/* — статика mini app, кеш 10 минут. */
  app.use('/famas/app', express.static(path.join(PUBLIC_DIR, 'app'), {
    maxAge: '10m',
    index: 'index.html'
  }));

  /* GET /famas/flags/* — SVG-флаги (SPEC-V2 §4.1), кеш 30 дней immutable. */
  app.use('/famas/flags', express.static(path.join(PUBLIC_DIR, 'flags'), {
    maxAge: '30d',
    immutable: true
  }));

  /* GET /famas/health — статус процесса. */
  app.get('/famas/health', function (req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      up: Math.floor(process.uptime()),
      lastRefresh: inventory.lastRefresh || null
    });
  });

  /* ─────────────────── АДМИНКА «кто что купил» (SPEC-ADMIN §2) ─────────────────── */
  /* Всё под /famas/admin/*, регистрируется ДО дефолтного 404 и не пересекается с
   * существующими маршрутами (/famas/api, /famas/app, /famas/flags и т.д.). Все данные —
   * только через admin-API со строгой проверкой requireAdmin (initData + ADMIN_IDS). */

  // In-memory кэш аватарок: userId -> {buf, type, ts}. TTL ~1ч, ≤200 записей (простая эвикция).
  const AVATAR_TTL_MS = 60 * 60 * 1000;
  const AVATAR_MAX = 200;
  const avatarCache = new Map();

  // /admin/api не кешируем (SPEC-ADMIN §2).
  app.use('/famas/admin/api', function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
  });

  function denyAdmin(res) {
    return res.status(403).json({ ok: false, error: 'Доступ только для администратора' });
  }

  /* GET /famas/admin/api/summary — сводная статистика для панели. */
  app.get('/famas/admin/api/summary', function (req, res) {
    const gate = requireAdmin(adminInitData(req));
    if (!gate.ok) return denyAdmin(res);

    let base = { ordersPaid: 0, revenueStars: 0, salesToday: 0, activeConfigs: 0, regionsCount: 0 };
    try {
      base = db.statsSummary();
    } catch (e) {
      logErr('admin/summary/statsSummary', e);
    }
    let extra = { uniqueBuyers: 0, ordersTotal: 0, freeActive: 0 };
    try {
      extra = db.adminSummary();
    } catch (e) {
      logErr('admin/summary/adminSummary', e);
    }
    // SPEC-IDEAS §3: счётчик открытых тикетов поддержки (аддитивно).
    let openTickets = 0;
    try {
      openTickets = db.openTicketsCount();
    } catch (e) {
      logErr('admin/summary/openTicketsCount', e);
    }

    res.json({
      ok: true,
      stats: {
        ordersPaid: base.ordersPaid,
        revenueStars: base.revenueStars,
        salesToday: base.salesToday,
        uniqueBuyers: extra.uniqueBuyers,
        activeConfigs: base.activeConfigs,
        regionsCount: base.regionsCount,
        ordersTotal: extra.ordersTotal,
        freeActive: extra.freeActive,
        openTickets: openTickets,
      },
    });
  });

  /* GET /famas/admin/api/orders — лента покупок (paid|gift), сортировка/поиск/пагинация. */
  app.get('/famas/admin/api/orders', function (req, res) {
    const gate = requireAdmin(adminInitData(req));
    if (!gate.ok) return denyAdmin(res);

    const sort = req.query.sort === 'price' ? 'price' : 'new';
    let result;
    try {
      result = db.ordersForAdmin({
        sort: sort,
        limit: req.query.limit, // db клампит (дефолт 50, макс 200)
        offset: req.query.offset, // db клампит (дефолт 0)
        q: typeof req.query.q === 'string' ? req.query.q : '',
      });
    } catch (e) {
      logErr('admin/orders', e);
      return res.status(500).json({ ok: false, error: 'Не удалось получить заказы' });
    }

    const now = nowSec();
    const summaryByIso = new Map();
    try {
      for (const r of db.regionsSummary() || []) summaryByIso.set(r.iso, r);
    } catch (e) {
      logErr('admin/orders/regionsSummary', e);
    }

    const orders = (result.rows || []).map((row) => mapAdminOrder(row, now, summaryByIso));
    res.json({ ok: true, total: result.total, orders: orders });
  });

  /* GET /famas/admin/api/log — журнал действий (SPEC-V3 §A.4): фильтры user/action/admin + пагинация.
   * Только requireAdmin (initData + ADMIN_IDS). no-store (общий /famas/admin/api middleware). */
  app.get('/famas/admin/api/log', function (req, res) {
    const gate = requireAdmin(adminInitData(req));
    if (!gate.ok) return denyAdmin(res);

    let result;
    try {
      result = db.actionsQuery({
        user: typeof req.query.user === 'string' ? req.query.user : '',
        action: typeof req.query.action === 'string' ? req.query.action : '',
        admin: req.query.admin === '1' || req.query.admin === 'true',
        limit: req.query.limit, // db клампит (дефолт 50, макс 200)
        offset: req.query.offset, // db клампит (дефолт 0)
      });
    } catch (e) {
      logErr('admin/log', e);
      return res.status(500).json({ ok: false, error: 'Не удалось получить журнал' });
    }

    const rows = (result.rows || []).map((r) => ({
      id: r.id,
      ts: r.ts,
      userId: r.user_id,
      username: r.username || null,
      isAdmin: Number(r.is_admin) === 1,
      kind: r.kind || null,
      action: r.action || null,
      detail: r.detail || null,
    }));
    res.json({ ok: true, total: result.total, rows: rows });
  });

  /* GET /famas/admin/api/activity — сводка активности (SPEC-V3 §A.4): плитки панели «Логи». */
  app.get('/famas/admin/api/activity', function (req, res) {
    const gate = requireAdmin(adminInitData(req));
    if (!gate.ok) return denyAdmin(res);

    let stats = { totalUsers: 0, activeToday: 0, active7d: 0, actionsToday: 0, admins: 0 };
    try {
      stats = db.activityStats();
    } catch (e) {
      logErr('admin/activity', e);
    }
    res.json({
      ok: true,
      totalUsers: stats.totalUsers,
      activeToday: stats.activeToday,
      active7d: stats.active7d,
      actionsToday: stats.actionsToday,
      admins: stats.admins,
    });
  });

  /* GET /famas/admin/avatar/:userId — аватар покупателя, ПРОКСИ через бота (токен не светим). */
  app.get('/famas/admin/avatar/:userId', wrap(async function (req, res) {
    const gate = requireAdmin(adminInitData(req));
    if (!gate.ok) return denyAdmin(res);

    const avatar404 = () => res.status(404).type('text/plain; charset=utf-8').send('no avatar');

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return avatar404();

    // userId должен встречаться среди пользователей/заказов — иначе 404 (нельзя пробить чужой id).
    let known = false;
    try {
      known = db.adminUserExists(userId);
    } catch (e) {
      logErr('admin/avatar/adminUserExists', e);
    }
    if (!known) return avatar404();

    // кэш (TTL ~1ч)
    const cached = avatarCache.get(userId);
    if (cached && Date.now() - cached.ts < AVATAR_TTL_MS) {
      res.set('Content-Type', cached.type || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(cached.buf);
    }
    if (cached) avatarCache.delete(userId); // протух

    if (!botApi || typeof botApi.getUserProfilePhotos !== 'function') return avatar404();

    // 1) фото профиля
    let photos;
    try {
      photos = await botApi.getUserProfilePhotos(userId, { limit: 1 });
    } catch (e) {
      return avatar404();
    }
    if (!photos || !Number(photos.total_count) || !Array.isArray(photos.photos) || !photos.photos.length) {
      return avatar404();
    }
    const sizes = photos.photos[0];
    if (!Array.isArray(sizes) || !sizes.length) return avatar404();

    // выбрать самый крупный размер ≤320px; если таких нет — наименьший доступный
    let chosen = null;
    for (const s of sizes) {
      if (!s || !s.file_id) continue;
      const w = Number(s.width) || 0;
      if (w <= 320) {
        if (!chosen || w > (Number(chosen.width) || 0)) chosen = s;
      }
    }
    if (!chosen) {
      for (const s of sizes) {
        if (!s || !s.file_id) continue;
        if (!chosen || (Number(s.width) || 0) < (Number(chosen.width) || 0)) chosen = s;
      }
    }
    if (!chosen || !chosen.file_id) return avatar404();

    // 2) file_path
    let file;
    try {
      file = await botApi.getFile(chosen.file_id);
    } catch (e) {
      return avatar404();
    }
    const filePath = file && file.file_path;
    if (!filePath || typeof filePath !== 'string') return avatar404();

    // 3) скачать байты (BOT_TOKEN — только на сервере, клиенту не отдаём)
    const token = config.BOT_TOKEN;
    if (!token) return avatar404();
    const fileUrl = 'https://api.telegram.org/file/bot' + token + '/' + filePath;

    let resp;
    try {
      resp = await fetch(fileUrl);
    } catch (e) {
      logErr('admin/avatar/fetch', e);
      return avatar404();
    }
    if (!resp || !resp.ok) return avatar404();

    let buf;
    try {
      buf = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      logErr('admin/avatar/arrayBuffer', e);
      return avatar404();
    }
    if (!buf || buf.length === 0) return avatar404();

    // положить в кэш с простой эвикцией самого старого при переполнении
    if (avatarCache.size >= AVATAR_MAX) {
      const oldestKey = avatarCache.keys().next().value;
      if (oldestKey !== undefined) avatarCache.delete(oldestKey);
    }
    avatarCache.set(userId, { buf: buf, type: 'image/jpeg', ts: Date.now() });

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  }));

  /* GET /famas/admin/* — статика админки (public/admin). Публична (секретов нет),
   * данные только через admin-API выше. Регистрируется после точечных admin-роутов. */
  app.use('/famas/admin', express.static(path.join(PUBLIC_DIR, 'admin'), {
    maxAge: '1m',
    index: 'index.html',
  }));

  /* Дефолтный 404. */
  app.use(function (req, res) {
    res.status(404).type('text/plain; charset=utf-8').send('famas: not found');
  });

  /* Централизованный обработчик ошибок. */
  app.use(function (err, req, res, next) {
    let status = Number(err && (err.status || err.statusCode)) || 500;
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) {
      logErr(req.method + ' ' + (req.originalUrl || req.url), err);
    }
    if (res.headersSent) return next(err);

    const isApi = String(req.originalUrl || req.url || '').indexOf('/famas/api') === 0;
    let message = 'Внутренняя ошибка сервера';
    if (err && err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Некорректный JSON в теле запроса';
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      message = 'Слишком большой запрос';
    } else if (status < 500) {
      message = 'Некорректный запрос';
    }

    if (isApi) {
      res.status(status).json({ ok: false, error: message });
    } else {
      res.status(status).type('text/plain; charset=utf-8').send('famas: error ' + status);
    }
  });

  return app;
}

module.exports = { createServer: createServer };
