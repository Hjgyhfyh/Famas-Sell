'use strict';

/* ════════════════════════════════════════════════════════════════
 * FAMAS STORE ⁂ — Telegram-бот магазина (grammY ^1). Агент BOT, §8 SPEC.
 *
 * Экспорты (контракт, менять нельзя):
 *   createBot()                      — собрать и настроить бота (БЕЗ запуска polling)
 *   sendDelivery(api, chatId, order) — карточка выдачи товара
 *   notifyAdmins(api, html)          — сообщение всем админам (ошибки глотаются)
 * ════════════════════════════════════════════════════════════════ */

const { Bot, InlineKeyboard } = require('grammy');

const config = require('./config');
const db = require('./db');
const util = require('./util');
const inventory = require('./inventory');
const subscription = require('./subscription');

const { esc, fmtDate, fmtDateTime, isoToFlag } = util;

/* ── оформление: ЧБ-премиум ───────────────────────────────────── */

const LINE = '━━━━━━━━━━━━━━━';
const THIN = '─────────────────';
const BRAND = '⬛️ FAMAS STORE ⁂';
const SUPPORT_URL = `https://t.me/${config.SUPPORT_USERNAME}`;
const APP_URL = `${config.PUBLIC_BASE}/app/`;
const BOT_URL = `https://t.me/${config.BOT_USERNAME}`;

/* ── мелкие утилиты ───────────────────────────────────────────── */

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const regionsWord = (n) => `${n} ${plural(n, 'регион', 'региона', 'регионов')}`;

function isAdmin(id) {
  return config.ADMIN_IDS.includes(Number(id));
}

function cut(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function errText(e) {
  return String((e && (e.description || e.message)) || e || 'неизвестная ошибка');
}

function isNotModified(e) {
  return !!(e && typeof e.description === 'string' && e.description.includes('message is not modified'));
}

/** Общие опции сообщений: HTML + без превью ссылок. */
function msgOpts(kb) {
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (kb) opts.reply_markup = kb;
  return opts;
}

function isPrivateCtx(ctx) {
  return !ctx.chat || ctx.chat.type === 'private';
}

function userLabel(from) {
  if (!from) return '—';
  return from.username
    ? '@' + esc(from.username)
    : `${esc(from.first_name || '')} <code>${from.id}</code>`;
}

/* ── состояние в памяти ───────────────────────────────────────── */

const SEL_TTL = 2 * 60 * 60 * 1000;    // выбор регионов живёт 2 часа
const PROMPT_TTL = 30 * 60 * 1000;     // админ-промпты (ForceReply) — 30 минут

/** userId -> { set:Set<ISO>, at:ms } — мультивыбор регионов */
const selections = new Map();
/** adminId -> { type:'price'|'days'|'gift'|'bcast', msgId, at:ms } */
const adminPrompts = new Map();
/** adminId -> { fromChat, msgId, at:ms } — подготовленная рассылка */
const pendingBroadcasts = new Map();

function getSelection(userId) {
  const t = Date.now();
  // ленивая подчистка протухших выборов
  for (const [k, v] of selections) if (t - v.at > SEL_TTL) selections.delete(k);
  let entry = selections.get(userId);
  if (!entry) {
    entry = { set: new Set(), at: t };
    selections.set(userId, entry);
  }
  entry.at = t;
  return entry.set;
}

/* ── регионы и заказы: справочные помощники ───────────────────── */

function regionMetaMap() {
  const map = new Map();
  try {
    for (const r of db.regionsSummary()) map.set(r.iso, r);
  } catch (e) {
    console.error('[bot] regionsSummary:', errText(e));
  }
  return map;
}

function parseRegions(order) {
  try {
    const arr = JSON.parse((order && order.regions) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/** Строка флагов заказа: 🇩🇪🇳🇱 */
function flagsOf(isos, meta) {
  const m = meta || regionMetaMap();
  return isos
    .map((iso) => {
      const r = m.get(iso);
      return (r && r.flag) || isoToFlag(iso) || iso;
    })
    .join('');
}

/** Русское имя региона, даже если он сейчас неактивен. */
function regionNameRu(iso, meta) {
  const r = (meta || regionMetaMap()).get(iso);
  if (r && r.nameRu) return r.nameRu;
  try {
    const rows = db.configsForRegions([iso]);
    const row = rows[0] || (db.fallbackForRegions([iso]) || [])[0];
    return util.nameRuOf(iso, row && row.country_name);
  } catch (e) { /* не критично */ }
  return util.nameRuOf(iso, null);
}

/** «🇩🇪 Германия · 🇳🇱 Нидерланды» */
function regionNamesLine(isos, meta) {
  const m = meta || regionMetaMap();
  if (!isos.length) return '—';
  return isos
    .map((iso) => {
      const r = m.get(iso);
      const flag = (r && r.flag) || isoToFlag(iso) || '';
      return `${flag} ${esc(regionNameRu(iso, m))}`.trim();
    })
    .join(' · ');
}

/** Сколько серверов реально попадёт в подписку по этим регионам. */
function countServers(isos) {
  try {
    return db.configsForRegions(isos).length + db.fallbackForRegions(isos).length;
  } catch (e) {
    console.error('[bot] countServers:', errText(e));
    return 0;
  }
}

/* ── тексты и клавиатуры экранов ──────────────────────────────── */

function mainMenuKb(isPrivate) {
  const kb = new InlineKeyboard();
  if (isPrivate) kb.webApp('⬛ ОТКРЫТЬ МАГАЗИН', APP_URL);
  else kb.url('⬛ ОТКРЫТЬ МАГАЗИН', BOT_URL);
  kb.row()
    .text('🔐 VPN-ключи', 'shop')
    .text('🛍 Каталог', 'catalog')
    .row()
    .text('👤 Профиль', 'profile')
    .text('❓ Помощь', 'help')
    .row()
    .url('💬 Поддержка', SUPPORT_URL);
  return kb;
}

function startView(isPrivate) {
  const text = [
    BRAND,
    LINE,
    'Ц И Ф Р О В О Й   М А Г А З И Н',
    '',
    'VPN-ключи VLESS · моментальная выдача.',
    'Выбери регионы — получи одну живую',
    'ссылку, конфиги обновляются сами.',
    '',
    'Оплата — Telegram Stars ⭐',
    LINE,
  ].join('\n');
  return { text, kb: mainMenuKb(isPrivate) };
}

function catalogView(isPrivate) {
  let regionsCount = 0;
  let serversCount = 0;
  try {
    const s = db.statsSummary();
    regionsCount = s.regionsCount;
    serversCount = s.activeConfigs;
  } catch (e) {
    console.error('[bot] statsSummary:', errText(e));
  }
  const price = db.priceStars();
  const days = db.subDays();
  const text = [
    `${BRAND} · КАТАЛОГ`,
    LINE,
    '01 / VPN-КЛЮЧИ VLESS',
    THIN,
    `Регионов: ${regionsCount} · Серверов: ${serversCount}`,
    `От ${price} ⭐ за регион · срок ${daysWord(days)}`,
    'Одна живая ссылка на все регионы:',
    'конфиги внутри обновляются сами.',
    '',
    '02 / ─ скоро ─',
    LINE,
  ].join('\n');
  const kb = new InlineKeyboard().text('🔐 Выбрать регионы', 'shop');
  if (isPrivate) kb.webApp('⬛ Mini App', APP_URL);
  else kb.url('⬛ Mini App', BOT_URL);
  return { text, kb };
}

function shopView(userId) {
  let regions = [];
  try {
    regions = db.regionsSummary();
  } catch (e) {
    console.error('[bot] regionsSummary:', errText(e));
  }
  if (!regions.length) {
    const text = [
      BRAND,
      LINE,
      'База серверов сейчас обновляется.',
      'Загляни через минуту.',
    ].join('\n');
    return { text, kb: new InlineKeyboard().text('⟳ Проверить ещё раз', 'shop') };
  }

  const sel = getSelection(userId);
  const known = new Set(regions.map((r) => r.iso));
  for (const iso of [...sel]) if (!known.has(iso)) sel.delete(iso);

  const price = db.priceStars();
  const kb = new InlineKeyboard();
  regions.forEach((r, i) => {
    const mark = sel.has(r.iso) ? '☑' : '☐';
    const flag = r.flag || isoToFlag(r.iso) || '';
    kb.text(`${mark} ${flag} ${r.nameRu} · ${r.count}`, `r:${r.iso}`);
    if (i % 2 === 1) kb.row();
  });
  if (regions.length % 2 === 1) kb.row();

  const n = sel.size;
  kb.text(`▸ Выбрано: ${n} · Итого: ${n}×${price} ⭐`, 'noop').row();
  kb.text('✦ Выбрать всё', 'all').text('✕ Сброс', 'clr').row();
  kb.text(`⭐ ОПЛАТИТЬ ${n * price}`, 'pay');

  const text = [
    BRAND,
    LINE,
    'В Ы Б О Р   Р Е Г И О Н О В',
    '',
    'Отметь страны — все выбранные регионы',
    'соберутся в одну живую ссылку-подписку.',
    '',
    `Цена: ${price} ⭐ / регион · Срок: ${daysWord(db.subDays())}`,
  ].join('\n');
  return { text, kb };
}

function profileView(from) {
  let orders = [];
  try {
    orders = db.ordersOfUser(from.id);
  } catch (e) {
    console.error('[bot] ordersOfUser:', errText(e));
  }
  const meta = regionMetaMap();
  const t = now();
  const lines = [
    '👤 ПРОФИЛЬ',
    LINE,
    `Имя: ${esc(from.first_name || '—')}${from.username ? ' · @' + esc(from.username) : ''}`,
    `ID: <code>${from.id}</code>`,
    `Покупок: ${orders.length}`,
  ];
  const kb = new InlineKeyboard();
  if (orders.length) {
    lines.push(THIN);
    const shown = orders.slice(0, 10);
    for (const o of shown) {
      const active = o.expires_at && t <= o.expires_at;
      const flags = flagsOf(parseRegions(o), meta) || '—';
      const till = o.expires_at ? fmtDate(o.expires_at) : '—';
      lines.push(`#${o.id} · ${flags} · до ${till} · ${active ? '● активен' : '○ истёк'}`);
    }
    if (orders.length > shown.length) lines.push(`… и ещё ${orders.length - shown.length}`);
    for (let i = 0; i < shown.length; i += 2) {
      kb.text(`Ключ #${shown[i].id}`, `key:${shown[i].id}`);
      if (shown[i + 1]) kb.text(`Ключ #${shown[i + 1].id}`, `key:${shown[i + 1].id}`);
      kb.row();
    }
  } else {
    lines.push(THIN, 'Покупок пока нет — начни с /vpn ⁂');
  }
  kb.text('🔐 Купить ключ', 'shop');
  return { text: lines.join('\n'), kb };
}

function helpView(isPrivate) {
  const text = [
    `${BRAND} · ПОМОЩЬ`,
    LINE,
    'К А К   Э Т О   Р А Б О Т А Е Т',
    '',
    '01 / выбери регионы — /vpn',
    '02 / оплати Telegram Stars ⭐',
    '03 / получи одну ссылку-подписку',
    '04 / вставь её в приложение — готово',
    '',
    THIN,
    'HAPP',
    '▸ открой страницу ключа',
    '▸ жми «ОТКРЫТЬ В HAPP» — подписка',
    '  добавится сама',
    '',
    'V2RAYTUN',
    '▸ страница ключа → «ОТКРЫТЬ В V2RAYTUN»',
    '▸ подтверди импорт подписки',
    '',
    'V2RAYNG',
    '▸ скопируй ссылку-подписку',
    '▸ ≡ → Группа подписок → ＋ → вставь URL',
    '▸ обнови подписку и подключайся',
    THIN,
    'Ссылка живая: серверы внутри',
    'обновляются автоматически.',
    'Вопросы — /support',
  ].join('\n');
  const kb = new InlineKeyboard();
  if (isPrivate) kb.webApp('⬛ Открыть магазин', APP_URL);
  else kb.url('⬛ Открыть магазин', BOT_URL);
  return { text, kb };
}

function supportView() {
  const text = [
    `${BRAND} · ПОДДЕРЖКА`,
    LINE,
    'Живой человек. Отвечаем 24/7.',
    '',
    'Оплата, ключи, настройка приложений —',
    'пиши, решаем быстро и по делу.',
    LINE,
  ].join('\n');
  const kb = new InlineKeyboard().url('✉︎ Написать', SUPPORT_URL);
  return { text, kb };
}

function paysupportView() {
  const text = [
    `${BRAND} · ОПЛАТА И ВОЗВРАТЫ`,
    LINE,
    '01 / товар цифровой — ключ выдаётся',
    'мгновенно после оплаты Telegram Stars ⭐',
    '',
    '02 / оплата прошла, а ключа нет —',
    'напиши в поддержку: проверим и выдадим',
    'заново или вернём ⭐ при сбое.',
    '',
    '03 / возврат приходит на баланс Stars',
    'тем же платежом.',
    LINE,
  ].join('\n');
  const kb = new InlineKeyboard().url('✉︎ Поддержка', SUPPORT_URL);
  return { text, kb };
}

function adminPanelView(extraLine) {
  let s = { users: 0, ordersPaid: 0, revenueStars: 0, activeConfigs: 0, regionsCount: 0, salesToday: 0 };
  try {
    s = db.statsSummary();
  } catch (e) {
    console.error('[bot] statsSummary:', errText(e));
  }
  const lr = inventory.lastRefresh || {};
  const updLine = lr.at
    ? `${fmtDateTime(lr.at)} · ${lr.ok ? `● ok (${lr.total})` : `○ ${esc(cut(lr.error || 'ошибка', 80))}`}`
    : '— ещё не было';
  const price = db.priceStars();
  const days = db.subDays();
  const lines = [
    `${BRAND} · АДМИН`,
    LINE,
    `01 / Пользователи: <b>${s.users}</b>`,
    `02 / Продаж: <b>${s.ordersPaid}</b> · сегодня: <b>${s.salesToday}</b>`,
    `03 / Выручка: <b>${s.revenueStars}</b> ⭐`,
    `04 / Конфигов: <b>${s.activeConfigs}</b> · регионов: <b>${s.regionsCount}</b>`,
    THIN,
    `Цена: ${price} ⭐ / регион · Срок: ${daysWord(days)}`,
    `Обновление: ${updLine}`,
  ];
  if (extraLine) lines.push(THIN, extraLine);
  const kb = new InlineKeyboard()
    .text('⟳ Обновить базу', 'adm:refresh')
    .row()
    .text(`💰 Цена: ${price}⭐`, 'adm:price')
    .text(`🗓 Срок: ${days} дн`, 'adm:days')
    .row()
    .text('📣 Рассылка', 'adm:bcast')
    .text('📦 Последние заказы', 'adm:orders')
    .row()
    .text('🎁 Выдать ключ', 'adm:gift');
  return { text: lines.join('\n'), kb };
}

/** Последние 10 заказов (сырой запрос по инстансу better-sqlite3 из db). */
function ordersListText() {
  const rows = db.db
    .prepare(
      `SELECT o.*, u.username, u.first_name
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC LIMIT 10`
    )
    .all();
  if (!rows.length) return `📦 ПОСЛЕДНИЕ ЗАКАЗЫ\n${LINE}\nЗаказов пока нет ⁂`;
  const st = { pending: '◌ ожидает', paid: '● оплачен', refunded: '↩ возврат', gift: '◈ подарок' };
  const meta = regionMetaMap();
  const blocks = rows.map((o) => {
    const who = o.username
      ? '@' + esc(o.username)
      : `${esc(o.first_name || '')} <code>${o.user_id}</code>`.trim();
    const flags = flagsOf(parseRegions(o), meta) || '—';
    const till = o.expires_at ? ` · до ${fmtDate(o.expires_at)}` : '';
    return [
      `#${o.id} · ${o.created_at ? fmtDateTime(o.created_at) : '—'} · ${who}`,
      `   ${st[o.status] || esc(o.status || '?')} · ${o.stars} ⭐ · ${flags}${till}`,
    ].join('\n');
  });
  return [`📦 ПОСЛЕДНИЕ ЗАКАЗЫ`, LINE, blocks.join('\n')].join('\n');
}

/* ── экспортируемые функции контракта ─────────────────────────── */

/**
 * Карточка выдачи товара (§8): одна ссылка-подписка + кнопки.
 * api = bot.api; order — строка из таблицы orders.
 */
async function sendDelivery(api, chatId, order) {
  const isos = parseRegions(order);
  const meta = regionMetaMap();
  const servers = countServers(isos);
  const link = subscription.subUrl(order.token);
  const page = subscription.pageUrl(order.token);
  const expired = order.expires_at ? now() > order.expires_at : false;
  const statusWord =
    order.status === 'gift' ? 'ПОДАРОК'
    : order.status === 'refunded' ? 'ВОЗВРАТ'
    : order.status === 'pending' ? 'ОЖИДАЕТ ОПЛАТЫ'
    : 'ОПЛАЧЕН';
  const tillLine = !order.expires_at
    ? 'Действует: —'
    : expired
      ? `○ Истёк: ${fmtDate(order.expires_at)} · новый — /vpn`
      : `Действует до: ${fmtDate(order.expires_at)}`;

  const text = [
    BRAND,
    LINE,
    `ЗАКАЗ #${order.id} · ${statusWord}`,
    `Регионы: ${regionNamesLine(isos, meta)}`,
    `Серверов внутри: ${servers}`,
    tillLine,
    '',
    'ТВОЯ ССЫЛКА — ОДНА НА ВСЁ:',
    `<code>${esc(link)}</code>`,
    '(нажми — скопируется)',
    '',
    '▸ Открой страницу ключа — там кнопки для',
    'Happ / v2rayTun / v2rayNG и QR-код.',
  ].join('\n');

  const kb = new InlineKeyboard()
    .url('⬛ СТРАНИЦА КЛЮЧА', page)
    .row()
    .text('❓ Как подключить', 'help')
    .text('👤 Профиль', 'profile');

  return api.sendMessage(chatId, text, msgOpts(kb));
}

/** Разослать HTML всем админам; любые ошибки глотаются. */
async function notifyAdmins(api, html) {
  for (const id of config.ADMIN_IDS) {
    try {
      await api.sendMessage(id, html, msgOpts());
    } catch (e) {
      /* глотаем — админ мог не открыть бота */
    }
  }
}

/* ── вспомогательные async-помощники ──────────────────────────── */

/** Для колбэков — редактируем текущее сообщение; иначе (или при сбое) шлём новое. */
async function editOrReply(ctx, text, kb) {
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, msgOpts(kb));
      return;
    } catch (e) {
      if (isNotModified(e)) return;
      // сообщение слишком старое/не редактируется — падаем в reply
    }
  }
  await ctx.reply(text, msgOpts(kb));
}

/** Перерисовать клавиатуру выбора регионов (после toggle/all/clr). */
async function refreshShopMarkup(ctx) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: shopView(ctx.from.id).kb });
  } catch (e) {
    if (!isNotModified(e)) console.error('[bot] edit markup:', errText(e));
  }
}

/**
 * Инвойс Telegram Stars. Основной путь — grammY ^1 (5 аргументов, БЕЗ
 * provider_token); если установлена версия со старой сигнатурой — raw call.
 */
async function sendStarsInvoice(ctx, description, payload, label, amount) {
  const title = 'FAMAS ⁂ VPN-ключ';
  const prices = [{ label, amount }];
  try {
    await ctx.replyWithInvoice(title, description, payload, 'XTR', prices);
  } catch (e) {
    const signatureIssue = e instanceof TypeError || (e && e.error_code === 400);
    if (!signatureIssue) throw e;
    await ctx.api.raw.sendInvoice({
      chat_id: ctx.chat.id,
      title,
      description,
      payload,
      currency: 'XTR',
      prices,
    });
  }
}

/** Возврат Stars: метод grammY, при его отсутствии — raw. */
async function refundStars(api, userId, chargeId) {
  if (typeof api.refundStarPayment === 'function') {
    return api.refundStarPayment(userId, chargeId);
  }
  return api.raw.refundStarPayment({
    user_id: userId,
    telegram_payment_charge_id: chargeId,
  });
}

/** Фоновая рассылка: копируем сообщение админа всем, пауза 50мс. */
async function runBroadcast(api, adminChatId, task) {
  let ids = [];
  try {
    ids = db.allUserIds();
  } catch (e) {
    console.error('[bot] allUserIds:', errText(e));
  }
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await api.copyMessage(id, task.fromChat, task.msgId);
      sent++;
    } catch (e) {
      failed++;
    }
    await sleep(50);
  }
  try {
    db.logEvent('broadcast', { sent, failed, total: ids.length });
  } catch (e) { /* не критично */ }
  await api
    .sendMessage(adminChatId, `⁂ РАССЫЛКА ЗАВЕРШЕНА\n${LINE}\nОтправлено: ${sent} · Ошибок: ${failed}`)
    .catch(() => {});
}

/* ── обработка ответов админа на ForceReply-промпты ───────────── */

async function handlePriceReply(ctx) {
  const n = parseInt(((ctx.message && ctx.message.text) || '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    await ctx.reply('✕ Нужно целое число от 1 до 10000. Заново: /admin');
    return;
  }
  db.setSetting('price_stars', String(n));
  try { db.logEvent('price_change', { price: n, by: ctx.from.id }); } catch (e) { /* ок */ }
  await ctx.reply(`✓ Цена обновлена: <b>${n}</b> ⭐ за регион.\nПанель: /admin`, msgOpts());
}

async function handleDaysReply(ctx) {
  const n = parseInt(((ctx.message && ctx.message.text) || '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    await ctx.reply('✕ Нужно целое число дней от 1 до 3650. Заново: /admin');
    return;
  }
  db.setSetting('sub_days', String(n));
  try { db.logEvent('days_change', { days: n, by: ctx.from.id }); } catch (e) { /* ок */ }
  await ctx.reply(`✓ Срок обновлён: <b>${daysWord(n)}</b>.\nПанель: /admin`, msgOpts());
}

async function handleGiftReply(ctx) {
  const raw = ((ctx.message && ctx.message.text) || '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    await ctx.reply(
      '✕ Формат: <code>&lt;user_id&gt; &lt;ISO,ISO|all&gt; [дней]</code>\nНапример: <code>927937870 DE,NL 30</code>',
      msgOpts()
    );
    return;
  }
  const targetId = parseInt(parts[0], 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    await ctx.reply('✕ Первым идёт числовой user_id. Заново: /admin');
    return;
  }
  let isos;
  if (parts[1].toLowerCase() === 'all') {
    isos = db.regionsSummary().map((r) => r.iso);
  } else {
    isos = [...new Set(
      parts[1]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{2}$/.test(s))
    )];
  }
  if (!isos.length) {
    await ctx.reply('✕ Не разобрал регионы. Формат: <code>DE,NL</code> или <code>all</code>.', msgOpts());
    return;
  }
  let days = db.subDays();
  if (parts[2] !== undefined) {
    days = parseInt(parts[2], 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await ctx.reply('✕ Дни — целое число от 1 до 3650. Заново: /admin');
      return;
    }
  }
  const servers = countServers(isos);
  if (!servers) {
    await ctx.reply('✕ По этим регионам нет ни одного сервера — ключ был бы пуст. Отмена.');
    return;
  }
  const created = db.createOrder({ userId: targetId, regions: isos, stars: 0, status: 'gift', days });
  const order = db.getOrder(created.id);
  try {
    db.logEvent('gift', { orderId: created.id, to: targetId, regions: isos, days, by: ctx.from.id });
  } catch (e) { /* ок */ }

  let deliveredNote;
  try {
    await sendDelivery(ctx.api, targetId, order);
    deliveredNote = '✓ ключ отправлен пользователю в чат';
  } catch (e) {
    deliveredNote = '△ не доставлен (пользователь не открывал бота) — передай страницу вручную';
  }
  await ctx.reply(
    [
      `✓ ВЫДАН КЛЮЧ #${order.id}`,
      LINE,
      `Кому: <code>${targetId}</code>`,
      `Регионы: ${flagsOf(isos)}`,
      `Срок: ${daysWord(days)} · Серверов: ${servers}`,
      `Страница: ${esc(subscription.pageUrl(order.token))}`,
      deliveredNote,
    ].join('\n'),
    msgOpts()
  );
}

async function handleBroadcastReply(ctx) {
  const adminId = ctx.from.id;
  pendingBroadcasts.set(adminId, {
    fromChat: ctx.chat.id,
    msgId: ctx.message.message_id,
    at: Date.now(),
  });
  // превью: копия сообщения — ровно так его увидят пользователи
  let previewNote = '⁂ ПРЕВЬЮ ВЫШЕ — так увидят пользователи.';
  try {
    await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);
  } catch (e) {
    previewNote = '⁂ Превью скопировать не вышло, но сообщение принято.';
  }
  let total = 0;
  try {
    total = db.allUserIds().length;
  } catch (e) { /* ок */ }
  await ctx.reply(
    `${previewNote}\n${THIN}\nПолучателей: ${total}. Отправляем?`,
    msgOpts(new InlineKeyboard().text('✓ Отправить', 'adm:bc_go').text('✕ Отмена', 'adm:bc_no'))
  );
}

/** Роутер ответов админа на ForceReply-промпты (проверка reply-контекста). */
async function adminReplyRouter(ctx, next) {
  const uid = ctx.from && ctx.from.id;
  if (!uid || !isAdmin(uid)) return next();
  const pend = adminPrompts.get(uid);
  if (!pend) return next();
  if (Date.now() - pend.at > PROMPT_TTL) {
    adminPrompts.delete(uid);
    return next();
  }
  const replyTo = ctx.message && ctx.message.reply_to_message;
  if (!replyTo || replyTo.message_id !== pend.msgId) return next();
  adminPrompts.delete(uid);

  switch (pend.type) {
    case 'price': return handlePriceReply(ctx);
    case 'days': return handleDaysReply(ctx);
    case 'gift': return handleGiftReply(ctx);
    case 'bcast': return handleBroadcastReply(ctx);
    default: return next();
  }
}

/** Отправить ForceReply-промпт и запомнить его id за админом. */
async function askAdmin(ctx, type, text, placeholder) {
  const sent = await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: cut(placeholder, 60) },
  });
  adminPrompts.set(ctx.from.id, { type, msgId: sent.message_id, at: Date.now() });
}

/* ── регистрация меню команд (не критично, ошибки глотаем) ────── */

function registerCommandMenu(api) {
  const publicCmds = [
    { command: 'start', description: '⬛ FAMAS STORE — главное меню' },
    { command: 'vpn', description: '🔐 Купить VPN-ключ: выбор регионов' },
    { command: 'catalog', description: '🛍 Каталог' },
    { command: 'profile', description: '👤 Профиль и мои ключи' },
    { command: 'help', description: '❓ Как это работает' },
    { command: 'support', description: '💬 Поддержка' },
    { command: 'paysupport', description: '⭐ Вопросы по оплате' },
  ];
  api.setMyCommands(publicCmds).catch(() => {});
  const adminCmds = publicCmds.concat([
    { command: 'admin', description: '⬛ Админ-панель' },
    { command: 'refund', description: '↩ Возврат: /refund <order_id>' },
  ]);
  for (const id of config.ADMIN_IDS) {
    api.setMyCommands(adminCmds, { scope: { type: 'chat', chat_id: id } }).catch(() => {});
  }
}

/* ── guard: только для админов; чужим — тихий ответ на колбэк ── */

function guardAdmin(fn) {
  return async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    return fn(ctx);
  };
}

/* ════════════════════════════════════════════════════════════════
 * createBot() — сборка бота. Polling НЕ запускается (это делает index.js).
 * ════════════════════════════════════════════════════════════════ */

function createBot() {
  const bot = new Bot(config.BOT_TOKEN);

  /* — учёт пользователей: каждый апдейт с message/callback — */
  bot.use(async (ctx, next) => {
    try {
      const from = ctx.from;
      if (from && !from.is_bot && (ctx.message || ctx.callbackQuery)) {
        db.upsertUser({
          id: from.id,
          username: from.username || null,
          first_name: from.first_name || null,
        });
      }
    } catch (e) {
      console.error('[bot] upsertUser:', errText(e));
    }
    return next();
  });

  /* ── команды ── */

  bot.command('start', async (ctx) => {
    const v = startView(isPrivateCtx(ctx));
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('catalog', async (ctx) => {
    const v = catalogView(isPrivateCtx(ctx));
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('vpn', async (ctx) => {
    const v = shopView(ctx.from.id);
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('profile', async (ctx) => {
    const v = profileView(ctx.from);
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('help', async (ctx) => {
    const v = helpView(isPrivateCtx(ctx));
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('support', async (ctx) => {
    const v = supportView();
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('paysupport', async (ctx) => {
    const v = paysupportView();
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('admin', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return; // тихий игнор
    const v = adminPanelView();
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.command('refund', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return; // тихий игнор
    const arg = String(ctx.match || '').trim();
    if (!/^\d+$/.test(arg)) {
      await ctx.reply('Формат: <code>/refund &lt;order_id&gt;</code>', msgOpts());
      return;
    }
    const order = db.getOrder(Number(arg));
    if (!order) {
      await ctx.reply(`✕ Заказ #${esc(arg)} не найден.`, msgOpts());
      return;
    }
    if (order.status === 'refunded') {
      await ctx.reply(`✕ По заказу #${order.id} возврат уже сделан.`, msgOpts());
      return;
    }
    if (order.status !== 'paid' || !order.charge_id) {
      await ctx.reply(
        `✕ Возврат возможен только по оплаченному Stars-заказу (статус: ${esc(order.status || '?')}).`,
        msgOpts()
      );
      return;
    }
    try {
      await refundStars(ctx.api, order.user_id, order.charge_id);
    } catch (e) {
      await ctx.reply(`✕ Telegram отклонил возврат: ${esc(errText(e))}`, msgOpts());
      return;
    }
    db.setOrderStatus(order.id, 'refunded');
    try {
      db.logEvent('refund', { orderId: order.id, userId: order.user_id, stars: order.stars, by: ctx.from.id });
    } catch (e) { /* ок */ }
    await ctx.api
      .sendMessage(
        order.user_id,
        [
          BRAND,
          LINE,
          `Заказ #${order.id}: платёж отменён,`,
          `${order.stars} ⭐ вернулись на твой баланс.`,
          'Подписка по этому заказу отключена.',
        ].join('\n'),
        msgOpts()
      )
      .catch(() => {});
    await ctx.reply(
      `✓ Возврат по заказу #${order.id} выполнен · ${order.stars} ⭐ → <code>${order.user_id}</code>`,
      msgOpts()
    );
  });

  /* ── платежи ── */

  bot.on('pre_checkout_query', async (ctx) => {
    const q = ctx.preCheckoutQuery;
    const m = /^order:(\d+)$/.exec(q.invoice_payload || '');
    let order = null;
    try {
      order = m ? db.getOrder(Number(m[1])) : null;
    } catch (e) {
      console.error('[bot] pre_checkout getOrder:', errText(e));
    }
    if (order && order.status === 'pending') {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, 'Заказ не найден, начни заново: /vpn');
    }
  });

  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const m = /^order:(\d+)$/.exec(sp.invoice_payload || '');
    if (!m) {
      await notifyAdmins(
        ctx.api,
        `△ Оплата с неизвестным payload <code>${esc(sp.invoice_payload || '')}</code> от ${userLabel(ctx.from)} · ${sp.total_amount} ⭐`
      );
      return;
    }
    const id = Number(m[1]);
    let order = db.getOrder(id);
    if (!order) {
      await ctx.reply(
        [
          BRAND,
          THIN,
          'Оплата получена, но заказ потерялся.',
          `Напиши в поддержку — решим сразу: @${config.SUPPORT_USERNAME}`,
        ].join('\n'),
        msgOpts()
      );
      await notifyAdmins(
        ctx.api,
        `△ Оплачен несуществующий заказ #${id} от ${userLabel(ctx.from)} · ${sp.total_amount} ⭐ · charge <code>${esc(sp.telegram_payment_charge_id || '')}</code>`
      );
      return;
    }
    const wasPending = order.status === 'pending';
    if (wasPending) {
      order = db.markOrderPaid(id, sp.telegram_payment_charge_id) || db.getOrder(id);
    }
    selections.delete(ctx.from.id); // корзина сыграла — чистим
    // ключ доставляем всегда (повторная доставка безвредна — юзер точно получит),
    // но журнал продажи и уведомление админов — только на реальном переходе
    // pending→paid: защита от повторной доставки одного апдейта Telegram
    // (после краша до ack) — без дублей продаж в журнале и спама админам.
    await sendDelivery(ctx.api, ctx.chat.id, order);
    if (wasPending) {
      try {
        db.logEvent('sale', { orderId: id, userId: ctx.from.id, stars: sp.total_amount });
      } catch (e) { /* ок */ }
      await notifyAdmins(
        ctx.api,
        `💰 Продажа #${id} · ${userLabel(ctx.from)} · ${sp.total_amount} ⭐ · ${flagsOf(parseRegions(order)) || '—'}`
      );
    }
  });

  /* ── ответы админа на ForceReply-промпты ── */

  bot.on('message', adminReplyRouter);

  /* ── колбэки: навигация ── */

  bot.callbackQuery('shop', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const v = shopView(ctx.from.id);
    await editOrReply(ctx, v.text, v.kb);
  });

  bot.callbackQuery('catalog', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const v = catalogView(isPrivateCtx(ctx));
    await editOrReply(ctx, v.text, v.kb);
  });

  // profile/help из колбэков шлём НОВЫМ сообщением: эти кнопки висят и на
  // карточке выдачи ключа — редактировать её нельзя (пропадёт ссылка).
  bot.callbackQuery('profile', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const v = profileView(ctx.from);
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const v = helpView(isPrivateCtx(ctx));
    await ctx.reply(v.text, msgOpts(v.kb));
  });

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  /* ── колбэки: выбор регионов ── */

  bot.callbackQuery(/^r:([A-Z]{2})$/, async (ctx) => {
    const iso = ctx.match[1];
    const sel = getSelection(ctx.from.id);
    let known = [];
    try {
      known = db.regionsSummary();
    } catch (e) {
      console.error('[bot] regionsSummary:', errText(e));
    }
    if (!known.some((r) => r.iso === iso)) {
      await ctx.answerCallbackQuery({ text: 'Этот регион сейчас недоступен.', show_alert: true }).catch(() => {});
    } else {
      if (sel.has(iso)) sel.delete(iso);
      else sel.add(iso);
      await ctx.answerCallbackQuery().catch(() => {});
    }
    await refreshShopMarkup(ctx);
  });

  bot.callbackQuery('all', async (ctx) => {
    const sel = getSelection(ctx.from.id);
    try {
      for (const r of db.regionsSummary()) sel.add(r.iso);
    } catch (e) {
      console.error('[bot] regionsSummary:', errText(e));
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await refreshShopMarkup(ctx);
  });

  bot.callbackQuery('clr', async (ctx) => {
    getSelection(ctx.from.id).clear();
    await ctx.answerCallbackQuery().catch(() => {});
    await refreshShopMarkup(ctx);
  });

  bot.callbackQuery('pay', async (ctx) => {
    const uid = ctx.from.id;
    const sel = getSelection(uid);
    let summary = [];
    try {
      summary = db.regionsSummary();
    } catch (e) {
      console.error('[bot] regionsSummary:', errText(e));
    }
    // валидный выбор — в порядке витрины (по nameRu)
    const chosen = summary.filter((r) => sel.has(r.iso)).map((r) => r.iso);
    if (!chosen.length) {
      await ctx
        .answerCallbackQuery({ text: 'Выбери хотя бы один регион ⬛', show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});

    const price = db.priceStars();
    const days = db.subDays();
    const total = price * chosen.length;
    const created = db.createOrder({ userId: uid, regions: chosen, stars: total, status: 'pending' });
    const meta = regionMetaMap();
    const flags = chosen.map((iso) => {
      const r = meta.get(iso);
      return (r && r.flag) || isoToFlag(iso) || iso;
    }).join(' ');
    const description = cut(`Регионы: ${flags} · ${daysWord(days)}`, 250);
    await sendStarsInvoice(
      ctx,
      description,
      `order:${created.id}`,
      `VLESS · ${regionsWord(chosen.length)}`,
      total
    );
  });

  /* ── колбэк: повторная выдача ключа (только своего) ── */

  bot.callbackQuery(/^key:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    let order = null;
    try {
      order = db.getOrder(orderId);
    } catch (e) {
      console.error('[bot] getOrder:', errText(e));
    }
    if (
      !order ||
      Number(order.user_id) !== ctx.from.id ||
      (order.status !== 'paid' && order.status !== 'gift')
    ) {
      await ctx.answerCallbackQuery({ text: 'Ключ не найден.', show_alert: true }).catch(() => {});
      return;
    }
    try {
      await sendDelivery(ctx.api, ctx.from.id, order);
      await ctx.answerCallbackQuery().catch(() => {});
    } catch (e) {
      await ctx
        .answerCallbackQuery({ text: 'Не получилось отправить. Открой личку с ботом.', show_alert: true })
        .catch(() => {});
    }
  });

  /* ── колбэки: админ-панель ── */

  bot.callbackQuery('adm:refresh', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    // работаем в фоне, чтобы long-poll не стоял 30 секунд на fetch
    (async () => {
      const waiting = adminPanelView('⟳ Обновляю базу…');
      await ctx.editMessageText(waiting.text, msgOpts(waiting.kb)).catch(() => {});
      let line;
      try {
        const r = await inventory.refreshNow();
        line = r && r.ok
          ? `⟳ Готово: +${r.added} новых · ${r.revived} вернулось · ${r.deactivated} выключено · активно ${r.total} · регионов ${r.regions}`
          : `⟳ Ошибка: ${esc(cut((r && r.error) || 'неизвестно', 120))}`;
      } catch (e) {
        line = `⟳ Ошибка: ${esc(cut(errText(e), 120))}`;
      }
      const v = adminPanelView(line);
      await ctx.editMessageText(v.text, msgOpts(v.kb)).catch(() => {});
    })().catch((e) => console.error('[bot] adm:refresh:', errText(e)));
  }));

  bot.callbackQuery('adm:price', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const cur = db.priceStars();
    await askAdmin(
      ctx,
      'price',
      `⁂ ЦЕНА ЗА РЕГИОН\nСейчас: <b>${cur}</b> ⭐.\nОтветь на это сообщение целым числом (1–10000).`,
      String(cur)
    );
  }));

  bot.callbackQuery('adm:days', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const cur = db.subDays();
    await askAdmin(
      ctx,
      'days',
      `⁂ СРОК ПОДПИСКИ\nСейчас: <b>${daysWord(cur)}</b>.\nОтветь на это сообщение числом дней (1–3650).`,
      String(cur)
    );
  }));

  bot.callbackQuery('adm:gift', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await askAdmin(
      ctx,
      'gift',
      [
        '⁂ ВЫДАЧА КЛЮЧА',
        'Ответь на это сообщение в формате:',
        '<code>&lt;user_id&gt; &lt;ISO,ISO|all&gt; [дней]</code>',
        'Примеры:',
        '<code>927937870 DE,NL 30</code>',
        '<code>927937870 all</code> — все регионы, срок по умолчанию.',
      ].join('\n'),
      '927937870 DE,NL 30'
    );
  }));

  bot.callbackQuery('adm:bcast', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await askAdmin(
      ctx,
      'bcast',
      '⁂ РАССЫЛКА\nОтветь на это сообщение текстом (можно фото с подписью) —\nпокажу превью и спрошу подтверждение.',
      'Текст рассылки…'
    );
  }));

  bot.callbackQuery('adm:orders', guardAdmin(async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    let text;
    try {
      text = ordersListText();
    } catch (e) {
      text = `✕ Не смог прочитать заказы: ${esc(errText(e))}`;
    }
    await ctx.reply(text, msgOpts());
  }));

  bot.callbackQuery('adm:bc_go', guardAdmin(async (ctx) => {
    const task = pendingBroadcasts.get(ctx.from.id);
    if (!task) {
      await ctx
        .answerCallbackQuery({ text: 'Нет подготовленной рассылки. Начни заново: /admin', show_alert: true })
        .catch(() => {});
      return;
    }
    pendingBroadcasts.delete(ctx.from.id);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('⁂ РАССЫЛКА ЗАПУЩЕНА…\nИтог пришлю отдельным сообщением.').catch(() => {});
    const adminChatId = ctx.chat ? ctx.chat.id : ctx.from.id;
    // фоном — не блокируем обработку остальных апдейтов
    runBroadcast(ctx.api, adminChatId, task).catch((e) =>
      console.error('[bot] broadcast:', errText(e))
    );
  }));

  bot.callbackQuery('adm:bc_no', guardAdmin(async (ctx) => {
    pendingBroadcasts.delete(ctx.from.id);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('✕ Рассылка отменена.').catch(() => {});
  }));

  /* ── неизвестные колбэки: просто гасим спиннер ── */

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  /* ── подсказка на прочий текст (только личка) ── */

  bot.on('message:text', async (ctx) => {
    if (!isPrivateCtx(ctx)) return;
    await ctx.reply(
      [
        BRAND,
        THIN,
        'Не понял. Вот что я умею:',
        '/vpn — купить ключ · /profile — мои ключи',
        '/help — как подключить · /support — поддержка',
      ].join('\n'),
      msgOpts()
    );
  });

  /* ── глобальный перехват ошибок ── */

  bot.catch(async (err) => {
    const ctx = err.ctx;
    const updId = ctx && ctx.update ? ctx.update.update_id : '?';
    console.error(`[bot] ошибка в апдейте ${updId}:`, errText(err.error || err));
    if (err.error && err.error.stack) console.error(err.error.stack);
    try {
      if (ctx && ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      if (ctx && ctx.chat && ctx.chat.type === 'private') {
        await ctx
          .reply(
            [
              BRAND,
              THIN,
              'Что-то пошло не так. Попробуй ещё раз,',
              `если повторится — напиши @${config.SUPPORT_USERNAME}.`,
            ].join('\n')
          )
          .catch(() => {});
      }
    } catch (e) {
      /* последний рубеж — молчим */
    }
  });

  /* меню команд Telegram (сетевые вызовы; в SKIP_BOT-режиме не дёргаем) */
  if (!config.SKIP_BOT) registerCommandMenu(bot.api);

  return bot;
}

module.exports = { createBot, sendDelivery, notifyAdmins };
