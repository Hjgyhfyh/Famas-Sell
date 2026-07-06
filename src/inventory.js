'use strict';
/**
 * src/inventory.js — загрузка источника VLESS-конфигов и синхронизация с БД.
 * SPEC §5: start(), refreshNow(), lastRefresh. Ошибки сети процесс НЕ роняют.
 */
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const util = require('./util');

const FETCH_TIMEOUT_MS = 30000;

// SPEC-QUALITY §4: сейфгард — если недоступных больше этой доли от проверенных
// (вероятный сетевой сбой на VDS/резолвере), TCP-результаты прогона НЕ применяем.
const HEALTHCHECK_MAX_DEAD_FRACTION = 0.85;

/** {at, ok, total, alive, error} — мутируется на месте каждым refreshNow */
const lastRefresh = { at: 0, ok: false, total: 0, alive: 0, error: null };

let timer = null;
let hcTimer = null;
let inflight = null;
// SPEC-HARDEN ч.1 §2: single-flight флаг healthcheck — чтобы отдельный периодический прогон
// и прогон после refresh НЕ накладывались друг на друга.
let hcInflight = false;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** путь из file:-URL ('file:fixtures/x.txt', 'file:///C:/x.txt') */
function filePathFromUrl(url) {
  let p = String(url).slice('file:'.length);
  if (p.startsWith('//')) p = p.slice(2);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

async function loadSourceText() {
  if (config.SOURCE_URL.startsWith('file:')) {
    return fs.readFileSync(filePathFromUrl(config.SOURCE_URL), 'utf8');
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(config.SOURCE_URL, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'famas-shop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} от источника`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

/**
 * Одна TCP-проверка доступности host:port. Успешное соединение → true, иначе false
 * (ошибка/таймаут/отказ). Никогда не бросает и не оставляет висящих сокетов/таймеров.
 */
function tcpAlive(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    let timer = null;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        if (socket) socket.destroy();
      } catch (e) {
        // сокет уже закрыт
      }
      resolve(ok);
    };
    try {
      socket = net.connect({ host: String(host), port: Number(port) || 0 });
    } catch (e) {
      resolve(false);
      return;
    }
    timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 4000));
    if (timer && typeof timer.unref === 'function') timer.unref();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    try {
      socket.setTimeout(Math.max(1, Number(timeoutMs) || 4000));
    } catch (e) {
      // не критично
    }
  });
}

/** Прогнать worker по items пулом заданного размера; results[i] соответствует items[i]. */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), items.length || 1));
  const runners = [];
  for (let k = 0; k < n; k++) {
    runners.push(
      (async () => {
        for (;;) {
          const i = idx++;
          if (i >= items.length) break;
          try {
            results[i] = await worker(items[i], i);
          } catch (e) {
            results[i] = false;
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * SPEC-QUALITY §4: прогон здоровья после upsert.
 * 1) блэклист (синхронно): каждый паттерн HOST_BLACKLIST → alive=0;
 * 2) TCP-живость (если HEALTHCHECK_ENABLED): пулом проверить hostsToCheck(); успех→alive=1,
 *    иначе→alive=0. СЕЙФГАРД: если недоступных > 85% проверенных — TCP-результаты НЕ применять
 *    (оставить прежний alive), только блэклист;
 * 3) logEvent('healthcheck', aliveStats()).
 * Ошибки глотаются, процесс не роняется, event loop не блокируется.
 */
async function runHealthcheck() {
  try {
    // 1) блэклист — быстрый синхронный проход
    const bl = config.HOST_BLACKLIST || [];
    for (const p of bl) {
      try {
        db.setAliveByHostPattern(p, 0);
      } catch (e) {
        // один паттерн не должен ронять весь прогон
      }
    }

    // 2) TCP-живость
    if (config.HEALTHCHECK_ENABLED) {
      let hosts = [];
      try {
        hosts = db.hostsToCheck();
      } catch (e) {
        hosts = [];
      }
      if (hosts.length) {
        const timeoutMs = config.HEALTHCHECK_TIMEOUT_MS;
        const conc = config.HEALTHCHECK_CONCURRENCY;
        const results = await runPool(hosts, conc, (h) => tcpAlive(h.host, h.port, timeoutMs));
        const checked = hosts.length;
        let up = 0;
        for (let i = 0; i < checked; i++) if (results[i] === true) up++;
        const down = checked - up;
        const deadFraction = checked > 0 ? down / checked : 0;

        if (deadFraction > HEALTHCHECK_MAX_DEAD_FRACTION) {
          // сейфгард: вероятный сетевой сбой — не трогаем alive, только блэклист остаётся
          try {
            db.logEvent('healthcheck_skip', {
              checked,
              up,
              down,
              deadFraction: Number(deadFraction.toFixed(3)),
            });
          } catch (e) {
            // журнал не критичен
          }
          console.error(
            `[${new Date().toISOString()}] inventory: healthcheck пропущен (сейфгард): ` +
              `${down}/${checked} недоступны (${Math.round(deadFraction * 100)}%) — TCP не применён`
          );
        } else {
          for (let i = 0; i < checked; i++) {
            const h = hosts[i];
            try {
              db.setAliveByHostPort(h.host, h.port, results[i] === true ? 1 : 0);
            } catch (e) {
              // отдельная запись не должна ронять прогон
            }
          }
        }
      }
    }

    // 3) статистика в журнал
    try {
      db.logEvent('healthcheck', db.aliveStats());
    } catch (e) {
      // журнал не критичен
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    try {
      db.logEvent('healthcheck', { error: msg });
    } catch (e2) {
      // журнал не критичен
    }
    console.error(`[${new Date().toISOString()}] inventory: ошибка healthcheck: ${msg}`);
  }
}

/**
 * SPEC-HARDEN ч.1 §2: обёртка runHealthcheck с single-flight флагом. Два прогона
 * (периодический таймер + прогон после refresh) не накладываются — второй тихо пропускается,
 * уже идущий и так обновит alive. Ошибки внутри runHealthcheck уже проглочены.
 */
async function runHealthcheckGuarded() {
  if (hcInflight) return false;
  hcInflight = true;
  try {
    await runHealthcheck();
    return true;
  } finally {
    hcInflight = false;
  }
}

async function doRefresh() {
  try {
    const text = await loadSourceText();
    const bodyHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const prevHash = db.getSetting('source_hash', '');

    let added = 0;
    let revived = 0;
    let deactivated = 0;
    let total = 0;
    let skipped = false;

    if (bodyHash === prevHash) {
      const s = db.statsSummary();
      if (s.activeConfigs > 0) {
        // контент не изменился — upsert пропускаем, lastRefresh всё равно обновим
        total = s.activeConfigs;
        skipped = true;
      }
    }

    if (!skipped) {
      const { configs } = util.parseSource(text);
      if (!configs.length) throw new Error('источник пуст: 0 конфигов после парсинга');
      const r = db.upsertConfigs(configs);
      added = r.added;
      revived = r.revived;
      deactivated = r.deactivated;
      total = r.total;
      db.setSetting('source_hash', bodyHash);
    }

    // SPEC-QUALITY §4: прогон здоровья каждый refresh (в т.ч. при неизменившемся
    // источнике — сервер мог отвалиться с прошлой проверки). Не роняет процесс.
    // SPEC-HARDEN ч.1 §2: через guarded — не накладывается на периодический прогон.
    await runHealthcheckGuarded();

    let alive = 0;
    try {
      alive = db.aliveStats().alive;
    } catch (e) {
      alive = 0;
    }
    // регионов теперь считаем по живым (regionsSummary фильтрует alive)
    const regions = db.regionsSummary().length;

    lastRefresh.at = nowSec();
    lastRefresh.ok = true;
    lastRefresh.total = total;
    lastRefresh.alive = alive;
    lastRefresh.error = null;

    const out = { ok: true, total, alive, added, revived, deactivated, regions };
    db.logEvent('refresh', { ...out, skipped });
    return out;
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? `таймаут загрузки источника (${FETCH_TIMEOUT_MS / 1000}с)`
        : String((e && e.message) || e);

    lastRefresh.at = nowSec();
    lastRefresh.ok = false;
    lastRefresh.error = msg;
    // total не трогаем — оставляем последнее удачное значение

    try {
      db.logEvent('refresh', { ok: false, error: msg });
    } catch (e2) {
      // журнал не критичен
    }
    console.error(`[${new Date().toISOString()}] inventory: ошибка обновления: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** обновить прямо сейчас; параллельные вызовы склеиваются в один */
function refreshNow() {
  if (inflight) return inflight;
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** сразу refreshNow(), затем каждые FETCH_INTERVAL_MIN минут (unref) */
function start() {
  refreshNow().catch(() => {});
  const ms = Math.max(1, Number(config.FETCH_INTERVAL_MIN) || 10) * 60 * 1000;
  timer = setInterval(() => {
    refreshNow().catch(() => {});
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();

  // SPEC-HARDEN ч.1 §2: ОТДЕЛЬНЫЙ, более частый таймер healthcheck (помимо refresh источника).
  // Мёртвый сервер выпадает из живых за ≤HEALTHCHECK_INTERVAL_MIN, а не ждёт FETCH_INTERVAL_MIN.
  // guarded → не накладывается на прогон после refresh; .unref() → не держит процесс; ошибки глотаем.
  const hcMs = Math.max(1, Number(config.HEALTHCHECK_INTERVAL_MIN) || 3) * 60 * 1000;
  hcTimer = setInterval(() => {
    runHealthcheckGuarded().catch(() => {});
  }, hcMs);
  if (hcTimer && typeof hcTimer.unref === 'function') hcTimer.unref();
}

module.exports = { start, refreshNow, runHealthcheck: runHealthcheckGuarded, lastRefresh };
