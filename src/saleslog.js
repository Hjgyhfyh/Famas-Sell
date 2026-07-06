'use strict';

/* ════════════════════════════════════════════════════════════════
 * src/saleslog.js — логи продаж в приватный канал + живая статистика.
 * SPEC-LOG §2-§4. Только совместимое ДОБАВЛЕНИЕ: ничего из существующей
 * логики бота/оплаты/выдачи не меняет и НЕ роняет.
 *
 * Экспорты (контракт SPEC-LOG §2):
 *   enabled()                 -> bool   // SALES_CHANNEL_ID задан (не пуст/не 0)
 *   ensureStats(api)          -> Promise // гарантировать закреплённую статистику
 *   updateStats(api)          -> Promise // перерисовать статистику актуальными числами
 *   logSale(api, order, kind) -> Promise // kind:'paid'|'free' — пост о покупке (самоудаляемый) + updateStats
 *
 * ЖЕЛЕЗНЫЕ правила:
 *   - при !enabled() ВСЕ функции — немедленный no-op (бот работает как раньше);
 *   - любые ошибки сети/Telegram глотаются (console.error), наружу не пробрасываются —
 *     оплата/выдача не должны падать из-за канала;
 *   - id закреплённого сообщения статистики хранится в settings['stats_msg_id'].
 * ════════════════════════════════════════════════════════════════ */

const config = require('./config');
const db = require('./db');
const util = require('./util');

const STATS_KEY = 'stats_msg_id';
const SEP = '━━━━━━━━━━━━━━━━━━━';

/** HH:MM по Москве (util «пуст» для этого — держим локальный форматтер, чтобы не парсить строки). */
const TIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/* ── низкоуровневые помощники ──────────────────────────────────── */

function errText(e) {
  return String((e && (e.description || e.message)) || e || 'неизвестная ошибка');
}

/** Сообщение Telegram «нельзя изменить, т.к. содержимое не поменялось» — глотаем. */
function isNotModified(e) {
  return errText(e).includes('message is not modified');
}

/** Сообщение статистики потеряно/не редактируется/удалено — повод пересоздать. */
function isMissing(e) {
  const s = errText(e);
  return (
    s.includes('message to edit not found') ||
    s.includes("message can't be edited") ||
    s.includes('message to delete not found') ||
    s.includes('message not found') ||
    s.includes('MESSAGE_ID_INVALID') ||
    s.includes('message identifier is not specified')
  );
}

/**
 * chat_id канала продаж из конфига (читается ДИНАМИЧЕСКИ — тест может мутировать config).
 * Пусто/'0' → null (фича выключена). Числовую строку приводим к Number (в пределах
 * безопасного целого: -1004297326871 ≈ 1e12 « 9e15).
 */
function channelId() {
  const raw = config.SALES_CHANNEL_ID;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

function enabled() {
  return channelId() !== null;
}

/** TTL самоудаляемого сообщения, минут (динамически из config; некорректное → 60, SPEC-LOG §7b). */
function ttlMinutes() {
  const n = Number(config.SALE_LOG_TTL_MIN);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Общие опции сообщений канала (SPEC-LOG §3/§4): HTML, без превью ссылок. */
function msgOpts() {
  return { parse_mode: 'HTML', disable_web_page_preview: true };
}

/* ── settings: id закреплённого сообщения статистики ───────────── */

function getStatsMsgId() {
  try {
    const n = parseInt(db.getSetting(STATS_KEY, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

function setStatsMsgId(id) {
  try {
    db.setSetting(STATS_KEY, String(id));
  } catch (e) {
    console.error('[saleslog] setStatsMsgId:', errText(e));
  }
}

function clearStatsMsgId() {
  try {
    db.setSetting(STATS_KEY, '');
  } catch (e) {
    /* не критично */
  }
}

/* ── разбор полей заказа (локальные копии — модуль самодостаточен) ── */

function parseRegions(order) {
  const v = order && order.regions;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

/** orders.qty ({iso:count} JSON/объект) → объект или null (старый заказ без qty). */
function parseQty(order) {
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

/** Срок заказа в днях: round((expires - paid|created)/86400), иначе db.subDays(). */
function orderDays(order) {
  const exp = Number(order && order.expires_at) || 0;
  const start = Number(order && order.paid_at) || Number(order && order.created_at) || 0;
  if (exp > 0 && start > 0 && exp > start) {
    const d = Math.round((exp - start) / 86400);
    if (d > 0) return d;
  }
  try {
    return db.subDays();
  } catch (e) {
    return config.DEFAULT_SUB_DAYS || 30;
  }
}

/** Карта iso → сводка региона (для флага/имени); при сбое БД — пустая. */
function regionMeta() {
  const m = new Map();
  try {
    for (const r of db.regionsSummary() || []) m.set(r.iso, r);
  } catch (e) {
    /* нет БД/регионов — упадём на util-фолбэки */
  }
  return m;
}

function flagOf(iso, meta) {
  const r = meta && meta.get(iso);
  return (r && r.flag) || util.isoToFlag(iso) || iso;
}

function nameOf(iso, meta) {
  const r = meta && meta.get(iso);
  return (r && r.nameRu) || util.nameRuOf(iso, null);
}

/* ── статистика ────────────────────────────────────────────────── */

/** Уникальные покупатели: DISTINCT user_id среди заказов status IN ('paid','gift'). */
function uniqueBuyers() {
  try {
    const row = db.db
      .prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM orders WHERE status IN ('paid','gift')`)
      .get();
    return (row && Number(row.c)) || 0;
  } catch (e) {
    return 0;
  }
}

/** HTML-текст закреплённой статистики (SPEC-LOG §3). */
function formatStats() {
  let s = { ordersPaid: 0, revenueStars: 0, salesToday: 0, activeConfigs: 0, regionsCount: 0 };
  try {
    s = db.statsSummary() || s;
  } catch (e) {
    console.error('[saleslog] statsSummary:', errText(e));
  }
  const buyers = uniqueBuyers();
  let time = '';
  try {
    time = TIME_FMT.format(new Date());
  } catch (e) {
    time = '';
  }
  return [
    '📊 <b>FAMAS STORE — статистика</b>',
    SEP,
    `💰 Продаж: <b>${s.ordersPaid}</b>`,
    `⭐ Выручка: <b>${s.revenueStars}</b> ⭐`,
    `📈 Сегодня: <b>${s.salesToday}</b>`,
    `👥 Покупателей: <b>${buyers}</b>`,
    `🌍 Стран в базе: <b>${s.regionsCount}</b> · серверов: <b>${s.activeConfigs}</b>`,
    `🕒 обновлено ${time} МСК`,
  ].join('\n');
}

/* ── сообщение о покупке ───────────────────────────────────────── */

/** HTML-текст сообщения о покупке (SPEC-LOG §4). kind: 'paid' | 'free'. */
function formatSale(order, kind) {
  const isos = parseRegions(order);
  const qty = parseQty(order);
  const meta = regionMeta();

  let regionsLine;
  let servers;
  if (qty) {
    regionsLine = isos
      .map((iso) => {
        const qn = Number(qty[iso]) || 0;
        return `${flagOf(iso, meta)} ${util.esc(nameOf(iso, meta))} ×${qn}`.trim();
      })
      .join(' · ');
    servers = isos.reduce((n, iso) => n + (Number(qty[iso]) || 0), 0);
  } else {
    regionsLine = isos.map((iso) => `${flagOf(iso, meta)} ${util.esc(nameOf(iso, meta))}`.trim()).join(' · ');
    servers = isos.length;
  }
  if (!regionsLine) regionsLine = '—';

  const days = orderDays(order);
  const id = Number(order && order.id) || 0;
  const stars = Number(order && order.stars) || 0;

  const head =
    kind === 'free'
      ? '🎁 <b>Выдача по промо</b> · бесплатно'
      : `💰 <b>Новая покупка</b> · +${stars} ⭐`;

  return [head, `🌍 ${regionsLine}`, `📦 ${servers} серв. · ${days} дней`, `🧾 заказ #${id}`].join('\n');
}

/* ── работа с закреплённым сообщением статистики ───────────────── */

/** Создать новое сообщение статистики, сохранить id, закрепить (ошибку пина глотаем). */
async function createStatsMessage(api) {
  const chat = channelId();
  const sent = await api.sendMessage(chat, formatStats(), msgOpts());
  if (sent && sent.message_id != null) {
    setStatsMsgId(sent.message_id);
    try {
      await api.pinChatMessage(chat, sent.message_id, { disable_notification: true });
    } catch (e) {
      /* пин не критичен — глотаем */
    }
  }
  return sent;
}

/**
 * Гарантировать закреплённое сообщение статистики (SPEC-LOG §3).
 * Есть id → пробуем отредактировать; «not found»/«can't be edited» → создать заново.
 * Нет id → создать + закрепить. Идемпотентно: при рестартах дубли не плодит.
 */
async function ensureStats(api) {
  if (!enabled() || !api) return;
  try {
    const chat = channelId();
    const id = getStatsMsgId();
    if (id) {
      try {
        await api.editMessageText(chat, id, formatStats(), msgOpts());
        return;
      } catch (e) {
        if (isNotModified(e)) return; // сообщение есть — всё ок
        if (!isMissing(e)) {
          console.error('[saleslog] ensureStats edit:', errText(e));
          return;
        }
        clearStatsMsgId(); // потеряно → пересоздаём ниже
      }
    }
    await createStatsMessage(api);
  } catch (e) {
    console.error('[saleslog] ensureStats:', errText(e));
  }
}

/**
 * Перерисовать закреплённую статистику актуальными числами (SPEC-LOG §3).
 * «not modified» — глотаем; «message not found» — пересоздать.
 */
async function updateStats(api) {
  if (!enabled() || !api) return;
  try {
    const chat = channelId();
    const id = getStatsMsgId();
    if (!id) {
      await createStatsMessage(api);
      return;
    }
    try {
      await api.editMessageText(chat, id, formatStats(), msgOpts());
    } catch (e) {
      if (isNotModified(e)) return;
      if (isMissing(e)) {
        clearStatsMsgId();
        await createStatsMessage(api);
        return;
      }
      console.error('[saleslog] updateStats edit:', errText(e));
    }
  } catch (e) {
    console.error('[saleslog] updateStats:', errText(e));
  }
}

/**
 * Пост о покупке + план самоудаления + обновление статистики (SPEC-LOG §4).
 * kind: 'paid' (реальная оплата) | 'free' (выдача по промо-регионам).
 * Всё в try/catch — исключение наружу не уходит (оплата/выдача не падают).
 */
async function logSale(api, order, kind) {
  if (!enabled() || !api || !order) return;
  const chat = channelId();
  try {
    let sent = null;
    try {
      sent = await api.sendMessage(chat, formatSale(order, kind), msgOpts());
    } catch (e) {
      console.error('[saleslog] logSale send:', errText(e));
    }

    // Самоудаление через SALE_LOG_TTL_MIN минут — ПЕРСИСТЕНТНО (SPEC-LOG §7b):
    // ставим в очередь sale_log_msgs, удаляет свипер (startSweeper). Переживает рестарт бота.
    if (sent && sent.message_id != null) {
      const deleteAt = Math.floor(Date.now() / 1000) + ttlMinutes() * 60;
      db.addSaleMsg(sent.message_id, String(chat), deleteAt);
    }

    await updateStats(api);
  } catch (e) {
    console.error('[saleslog] logSale:', errText(e));
  }
}

/* ── персистентный свипер самоудаления (SPEC-LOG §7b) ──────────────
 * За час бот может рестартнуться (деплой/автопул) — setTimeout не переживёт.
 * Поэтому сообщения о покупке кладутся в БД (db.addSaleMsg) и удаляются свипером,
 * который переживает рестарт: при старте прогоняется немедленно + раз в минуту. */

let sweeperTimer = null;

/**
 * Один тик свипера: удалить все просроченные сообщения о покупке.
 * Успех ИЛИ «сообщение не найдено» → вычищаем из очереди (чтобы не копилось);
 * прочие ошибки — оставляем в очереди на следующий тик. Наружу не бросает.
 */
async function sweep(api) {
  if (!enabled() || !api) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = db.dueSaleMsgs(nowSec) || [];
    for (const row of rows) {
      const id = Number(row && row.message_id);
      if (!Number.isFinite(id) || id <= 0) {
        db.removeSaleMsg(row && row.message_id);
        continue;
      }
      const chat =
        row && row.chat_id != null && String(row.chat_id) !== '' ? row.chat_id : channelId();
      try {
        await api.deleteMessage(chat, id);
        db.removeSaleMsg(id); // удалено — убираем из очереди
      } catch (e) {
        if (isMissing(e)) {
          db.removeSaleMsg(id); // сообщения уже нет — тоже убираем
        } else {
          console.error('[saleslog] sweep delete:', errText(e)); // прочее — оставим на след. тик
        }
      }
    }
  } catch (e) {
    console.error('[saleslog] sweep:', errText(e));
  }
}

/**
 * Запустить персистентный свипер (SPEC-LOG §7b): немедленный прогон +
 * setInterval(60000).unref(). Интервал не запускается дважды (храним ссылку).
 * При !enabled() — no-op. Fire-and-forget, наружу не бросает.
 */
function startSweeper(api) {
  if (!enabled() || !api) return;
  // (1) немедленный прогон
  try {
    const p = sweep(api);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* sweep сам глотает — подстраховка */
  }
  // (2) периодический тик — ровно один раз на процесс
  if (!sweeperTimer) {
    sweeperTimer = setInterval(() => {
      try {
        const p = sweep(api);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {
        /* подстраховка */
      }
    }, 60000);
    if (sweeperTimer && typeof sweeperTimer.unref === 'function') sweeperTimer.unref();
  }
}

// startSweeper — публичный запуск свипера (index.js). sweep/ttlMinutes экспортируются
// дополнительно для детерминированных проверок E2E-гейта (чистое ДОБАВЛЕНИЕ, поведение не меняют).
module.exports = { enabled, ensureStats, updateStats, logSale, startSweeper, sweep, ttlMinutes };
