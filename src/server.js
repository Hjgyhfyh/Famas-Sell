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

/** Заказ «действует»: оплачен/подарен и срок не вышел (§6: expired = now > expires_at). */
function isOrderActive(order, now) {
  return Boolean(
    order &&
    (order.status === 'paid' || order.status === 'gift') &&
    order.expires_at &&
    now <= order.expires_at
  );
}

/** Конфиги, которые попадут в подписку заказа: активные + fallback (ровно как buildSub §6). */
function subConfigsSafe(isos, where) {
  if (!Array.isArray(isos) || isos.length === 0) return [];
  let main = [];
  let fb = [];
  try {
    main = db.configsForRegions(isos) || [];
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

  /* GET /famas/api/regions — витрина: регионы, цена, срок, всего серверов. */
  app.get('/famas/api/regions', function (req, res) {
    const regions = db.regionsSummary() || [];
    let total = 0;
    for (const r of regions) total += Number(r.count) || 0;
    const lr = inventory.lastRefresh || null;
    res.json({
      ok: true,
      regions, // каждый регион уже с popularity (regionsSummary, SPEC-QTY §3/§4)
      price: db.priceStars(),
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
      q = db.reserveOrder(auth.user.id, qtyInput);
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
        chargeId: 'FREE'
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
        orderId: created.id,
        page: subscription.pageUrl(created.token),
        sub: subscription.subUrl(created.token),
        servers: q.servers, // Σqty
        regions: isos
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
      freeApplied: q.freeUsed
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
      invoiceLink: invoiceLink,
      orderId: created.id,
      stars: q.stars,
      servers: q.servers, // Σqty
      freeApplied: q.freeUsed
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
      const qty = orderQty(o); // SPEC-QTY §6: servers = Σqty (для новых) / configs len (старых)
      const servers = qty ? sumQty(qty) : subConfigsSafe(regions, 'me').length;
      return {
        id: o.id,
        regions: regions,
        flags: regions.map((iso) => util.isoToFlag(iso)).join(''),
        status: o.status,
        expiresAt: o.expires_at || null,
        active: isOrderActive(o, now),
        page: subscription.pageUrl(o.token),
        sub: subscription.subUrl(o.token),
        servers: servers
      };
    });

    let free = 0;
    try {
      free = db.getFree(auth.user.id);
    } catch (e) {
      logErr('me/getFree', e);
    }

    res.json({ ok: true, orders: orders, free: free });
  });

  /* GET /famas/api/key/:token — данные ключа для страницы товара (key.html). */
  app.get('/famas/api/key/:token', function (req, res) {
    const token = String(req.params.token || '');
    const order = TOKEN_RE.test(token) ? db.getOrderByToken(token) : null;
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Ключ не найден' });
    }

    const isos = orderRegions(order);
    const qty = orderQty(order); // SPEC-QTY §6: count = купленное qty (для старых — available)
    const rows = subConfigsSafe(isos, 'key');

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

    const regions = isos.map(function (iso) {
      const s = summaryByIso.get(iso);
      let nameRu = s && s.nameRu ? s.nameRu : null;
      if (!nameRu) {
        const row = rows.find((c) => c && c.country_iso === iso && c.country_name);
        nameRu = util.nameRuOf(iso, row && row.country_name);
      }
      // count: для нового заказа — купленное qty; для старого — реально выданные серверы.
      const count = qty ? (Number(qty[iso]) || 0) : (countByIso.get(iso) || 0);
      return {
        iso: iso,
        nameRu: nameRu || iso,
        flag: util.isoToFlag(iso),
        count: count
      };
    });

    const sub = subscription.subUrl(order.token);
    res.json({
      ok: true,
      orderId: order.id,
      status: order.status,
      regions: regions,
      servers: qty ? sumQty(qty) : rows.length, // Σqty (новые) / configs len (старые)
      expiresAt: order.expires_at || null,
      active: isOrderActive(order, nowSec()),
      sub: sub,
      page: subscription.pageUrl(order.token),
      links: subscription.deepLinks(sub),
      createdAt: order.created_at || null
    });
  });

  /* GET /famas/s/:token — подписка: заголовки из §6 + тело base64. */
  app.get('/famas/s/:token', function (req, res) {
    const token = String(req.params.token || '');
    const order = TOKEN_RE.test(token) ? db.getOrderByToken(token) : null;
    if (!order) {
      return res.status(404).type('text/plain; charset=utf-8').send('not found');
    }

    const sub = subscription.buildSub(order);
    if (sub && sub.headers && typeof sub.headers === 'object') {
      res.set(sub.headers);
    }
    res.set('Cache-Control', 'no-store'); // контент живой — кешировать нельзя
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(sub && typeof sub.b64 === 'string' ? sub.b64 : '');
  });

  /* GET /famas/qr/:token.svg — QR-код ссылки-подписки. */
  app.get('/famas/qr/:token.svg', wrap(async function (req, res) {
    const token = String(req.params.token || '');
    const order = TOKEN_RE.test(token) ? db.getOrderByToken(token) : null;
    if (!order) {
      return res.status(404).type('text/plain; charset=utf-8').send('not found');
    }

    const svg = await QRCode.toString(subscription.subUrl(order.token), {
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
