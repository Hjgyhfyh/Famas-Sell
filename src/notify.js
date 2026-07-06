'use strict';

/**
 * src/notify.js — авто-напоминания об истечении подписки (SPEC-IDEAS §2, retention).
 *
 * Таймер каждые ~30 мин (unref — процесс не держит): по заказам paid|gift с expires_at
 * (renewal-«чеки» исключены на уровне db.ordersForNotify) шлём владельцу:
 *   за ≤3 дн  → «⏳ истекает через N дн.»  (notify_stage=3)
 *   за ≤1 дн  → «⏳ истекает менее чем через день» (notify_stage=1)
 *   после     → «○ ключ истёк — продли»    (notify_stage=-1, финал)
 * Стадии идут строго вперёд (0 → 3 → 1 → -1), по stage не спамим. Кнопка «🔄 Продлить»
 * (cb renew:<orderId> — обрабатывает bot.js). ВСЁ в try/catch: 403 (юзер закрыл бота) и любые
 * сбои — молча, stage при этом выставлен (не долбим повторно). Давно истёкшие заказы (истекли
 * раньше, чем EXPIRED_GRACE_SEC назад — например, на первом деплое фичи) получают stage=-1
 * МОЛЧА, без сообщения — не бомбим владельцев старых ключей.
 *
 * Экспорт: startNotifier(botApi) — звать из index.js при !SKIP_BOT; sweep — для тестов.
 * config.NOTIFY_ENABLED=0 → полный no-op.
 */

const config = require('./config');
const db = require('./db');
const util = require('./util');

/* ── интервалы (константы, SPEC-IDEAS §2.3) ── */
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // проход раз в ~30 минут
const WARN3_SEC = 3 * 86400; // «за ≤3 дня»
const WARN1_SEC = 1 * 86400; // «за ≤1 день»
const EXPIRED_GRACE_SEC = 3 * 86400; // «истёк» шлём, только если истёк не давнее этого
const SEND_PAUSE_MS = 60; // пауза между отправками (не душим Telegram)
const MAX_PER_SWEEP = 200; // максимум сообщений за один проход

// Порядок стадий: 0 (ничего) → 3 (за ≤3 дн) → 1 (за ≤1 дн) → -1 (истёк, финал).
const STAGE_RANK = { 0: 0, 3: 1, 1: 2, '-1': 3 };

let timer = null;

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

function rankOf(stage) {
  const key = String(Math.floor(Number(stage) || 0));
  return STAGE_RANK[key] !== undefined ? STAGE_RANK[key] : 0;
}

/** Целевая стадия заказа на момент t: -1 (истёк) | 1 (≤1 дн) | 3 (≤3 дн) | null (рано). */
function targetStage(order, t) {
  const exp = Number(order && order.expires_at) || 0;
  if (!exp) return null;
  if (t > exp) return -1;
  const left = exp - t;
  if (left <= WARN1_SEC) return 1;
  if (left <= WARN3_SEC) return 3;
  return null;
}

/** Строка флагов заказа (🇩🇪🇳🇱) из orders.regions (JSON). Пусто при сбое. */
function flagsOf(order) {
  try {
    const arr = JSON.parse((order && order.regions) || '[]');
    if (!Array.isArray(arr)) return '';
    return arr
      .map((iso) => util.isoToFlag(String(iso || '').trim().toUpperCase()) || '')
      .join('');
  } catch (e) {
    return '';
  }
}

/** Текст + inline-клавиатура напоминания для стадии (3 | 1 | -1). */
function buildMessage(order, stage, t) {
  const LINE = '━━━━━━━━━━━━━━━';
  const exp = Number(order.expires_at) || 0;
  const till = exp ? util.fmtDate(exp) : '—';
  const flags = flagsOf(order);
  const head = `⬛️ FAMAS STORE ⁂`;

  let body;
  if (stage === -1) {
    body = [
      `○ Ключ #${order.id}${flags ? ' · ' + flags : ''} истёк ${till}.`,
      '',
      'Продли — и та же ссылка снова оживёт:',
      'ничего перенастраивать не придётся.',
    ];
  } else if (stage === 1) {
    body = [
      `⏳ Ключ #${order.id}${flags ? ' · ' + flags : ''} истекает`,
      `менее чем через день — ${till}.`,
      '',
      'Продли сейчас, чтобы серверы работали',
      'без перерыва (ссылка останется той же).',
    ];
  } else {
    const daysLeft = Math.max(1, Math.ceil((exp - t) / 86400));
    body = [
      `⏳ Ключ #${order.id}${flags ? ' · ' + flags : ''} истекает через ${daysWord(daysLeft)} (${till}).`,
      '',
      'Продли заранее — серверы продолжат',
      'работать без перерыва, ссылка та же.',
    ];
  }

  // Кнопка продления с ценой (renewQuote чистый — ничего не списывает).
  let renewLabel = '🔄 Продлить';
  try {
    const rq = db.renewQuote(order);
    renewLabel = `🔄 Продлить (${rq.days}дн · ${rq.stars}⭐)`;
  } catch (e) {
    /* без цены — просто «Продлить» */
  }

  return {
    text: [head, LINE, ...body].join('\n'),
    kb: {
      inline_keyboard: [
        [{ text: renewLabel, callback_data: `renew:${order.id}` }],
        [{ text: '👤 Профиль', callback_data: 'profile' }],
      ],
    },
  };
}

/**
 * Один проход: найти кандидатов (db.ordersForNotify), выставить стадию и отправить напоминание.
 * Stage выставляется ДО отправки (анти-спам важнее гарантии доставки: краш между send и set не
 * приводит к повторной бомбёжке). Любая ошибка на отдельном заказе не роняет проход.
 */
async function sweep(api) {
  if (!config.NOTIFY_ENABLED || !api || typeof api.sendMessage !== 'function') return { sent: 0 };
  let rows = [];
  try {
    rows = db.ordersForNotify(nowSec());
  } catch (e) {
    return { sent: 0 };
  }
  let sent = 0;
  for (const o of rows) {
    if (sent >= MAX_PER_SWEEP) break;
    try {
      const t = nowSec();
      const target = targetStage(o, t);
      if (target === null) continue;
      if (rankOf(target) <= rankOf(o.notify_stage)) continue; // эту стадию уже слали
      db.setNotifyStage(o.id, target);
      // давно истёкший (первый деплой фичи и т.п.) — финал ставим молча, без сообщения
      if (target === -1 && t - (Number(o.expires_at) || 0) > EXPIRED_GRACE_SEC) continue;
      if (!o.user_id) continue;
      const m = buildMessage(o, target, t);
      try {
        await api.sendMessage(o.user_id, m.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: m.kb,
        });
        sent++;
      } catch (e) {
        // 403 (заблокировал бота) и прочее — молча; stage уже выставлен, повторов не будет
      }
      await sleep(SEND_PAUSE_MS);
    } catch (e) {
      // один битый заказ не роняет проход
    }
  }
  return { sent };
}

/**
 * startNotifier(botApi) — запустить напоминания (SPEC-IDEAS §2): немедленный проход +
 * setInterval каждые ~30 мин (unref — не держит процесс). Повторный вызов — no-op.
 * При config.NOTIFY_ENABLED=0 не запускается вовсе.
 */
function startNotifier(botApi) {
  if (!config.NOTIFY_ENABLED) return null;
  if (!botApi || timer) return timer;
  sweep(botApi).catch(() => {});
  timer = setInterval(() => {
    sweep(botApi).catch(() => {});
  }, CHECK_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** Остановить таймер (для тестов/остановки). */
function stopNotifier() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startNotifier, stopNotifier, sweep, targetStage };
