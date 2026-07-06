'use strict';
/**
 * src/inventory.js — загрузка источника VLESS-конфигов и синхронизация с БД.
 * SPEC §5: start(), refreshNow(), lastRefresh. Ошибки сети процесс НЕ роняют.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const util = require('./util');

// SPEC-SOURCES §6: geoip-lite опционален. Если не установлен/не грузится — GEO_ENABLED игнорируется
// (регионы по флагу как раньше). Грузим один раз, мягко.
let geoip = null;
try {
  geoip = require('geoip-lite');
} catch (e) {
  geoip = null;
}

const FETCH_TIMEOUT_MS = 30000;
// SPEC-SOURCES §1.3: пул загрузки источников (concurrency ~6).
const SOURCE_FETCH_CONCURRENCY = 6;

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

/**
 * SPEC-GROWTH2 §C.2: опциональный хук, вызываемый ПОСЛЕ каждого успешного refresh каталога.
 * index.js вешает на него обновление закреплённой статистики канала (updateStats). Инвентарь НЕ
 * зависит от него жёстко: хук опционален, любые ошибки (в т.ч. отклонённый промис) глотаются —
 * канал/статистика не влияют на обновление каталога. Читаем из module.exports (index.js его туда пишет).
 */
function fireRefreshDone(info) {
  const hook = module.exports && module.exports.onRefreshDone;
  if (typeof hook !== 'function') return;
  try {
    const p = hook(info);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* хук опционален — ошибки глотаем */
  }
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

/**
 * SPEC-STABILITY2 §4: одна TLS-проверка живости host:port через node:tls. Успех = событие
 * 'secureConnect' (сервер РЕАЛЬНО завершил TLS-хендшейк) → true; ошибка/таймаут → false. Точнее
 * TCP: ловит «порт открыт, но TLS битый/не отвечает» — прямой кейс «работает-перестаёт». Для
 * reality/tls-vless это валидная проверка (сервер обязан говорить TLS, чтобы клиент подключился).
 * rejectUnauthorized:false — важен сам факт живого TLS, не валидность cert. SNI ставим для доменов
 * (не для IP). Никогда не бросает, не оставляет висящих сокетов/таймеров.
 */
function tlsAlive(host, port, timeoutMs) {
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
    const h = String(host);
    const opts = {
      host: h,
      port: Number(port) || 0,
      rejectUnauthorized: false,
      // SNI только для hostname (для IP — не ставим: некоторые стеки на IP+SNI рвут соединение)
      servername: net.isIP(h) ? undefined : h,
    };
    try {
      socket = tls.connect(opts);
    } catch (e) {
      resolve(false);
      return;
    }
    timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 4000));
    if (timer && typeof timer.unref === 'function') timer.unref();
    socket.once('secureConnect', () => finish(true));
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

    // 2) TCP-живость (SPEC-SOURCES §5.2: ротационный батч — самые давно проверенные первыми;
    //    при масштабе ~56k хостов полный свип набирается за несколько циклов. На малом источнике
    //    (<HEALTHCHECK_BATCH хостов) берётся всё разом — как раньше.)
    if (config.HEALTHCHECK_ENABLED) {
      let hosts = [];
      try {
        hosts = db.hostsToCheck(config.HEALTHCHECK_BATCH);
      } catch (e) {
        hosts = [];
      }
      if (hosts.length) {
        const timeoutMs = config.HEALTHCHECK_TIMEOUT_MS;
        // SPEC-STABILITY2 §4: TLS-хендшейк дороже TCP — конкурентность ≤64 (лимит FD/эфемерных
        // портов на VDS, ulimit ~1024). При HEALTH_TLS=0 (только TCP) держим настроенную.
        const useTls = !!config.HEALTH_TLS;
        const conc = useTls
          ? Math.min(Math.max(1, Number(config.HEALTHCHECK_CONCURRENCY) || 64), 64)
          : Math.max(1, Number(config.HEALTHCHECK_CONCURRENCY) || 64);
        // tls/reality-конфиги (h.tls=1) проверяем TLS-хендшейком, остальные — TCP (SPEC-STABILITY2 §4).
        const probe = (h) =>
          useTls && h.tls ? tlsAlive(h.host, h.port, timeoutMs) : tcpAlive(h.host, h.port, timeoutMs);
        const results = await runPool(hosts, conc, probe);
        const checked = hosts.length;
        let up = 0;
        for (let i = 0; i < checked; i++) if (results[i] === true) up++;
        const down = checked - up;
        const deadFraction = checked > 0 ? down / checked : 0;

        // Высокая доля недоступных бывает по двум причинам: (а) реальный сетевой сбой на
        // VDS/резолвере — тогда alive трогать нельзя; (б) у скрап-источников батч честно может
        // быть на >85% мёртвым — тогда мёртвых НАДО пометить. Различаем канарейками: пробуем
        // заведомо живые публичные хосты. Живы канарейки → сеть в порядке → смертность реальна →
        // применяем. Канарейки тоже недоступны → сеть лежит → сейфгард (не трогаем alive).
        let networkDown = false;
        if (deadFraction > HEALTHCHECK_MAX_DEAD_FRACTION) {
          const canaries = [
            ['1.1.1.1', 443],
            ['8.8.8.8', 443],
            ['9.9.9.9', 443],
            ['github.com', 443],
          ];
          // Канарейку проверяем ТЕМ ЖЕ методом, что и батч (SPEC-STABILITY2 §4): если включён TLS —
          // публичные 443 говорят TLS, поэтому провал канареек = наш TLS-путь/сеть сломан → сейфгард
          // (не применяем массовую смерть от TLS-false-negative). TCP-режим — как раньше.
          const cprobe = (c) =>
            useTls ? tlsAlive(c[0], c[1], timeoutMs) : tcpAlive(c[0], c[1], timeoutMs);
          let canaryUp = 0;
          try {
            const cr = await runPool(canaries, canaries.length, cprobe);
            canaryUp = cr.filter((x) => x === true).length;
          } catch (e) {
            canaryUp = 0;
          }
          networkDown = canaryUp === 0; // все канарейки мертвы → это сеть/резолвер, а не серверы
        }

        if (networkDown) {
          // сейфгард: подтверждённый сетевой сбой — не трогаем alive, только блэклист остаётся
          try {
            db.logEvent('healthcheck_skip', {
              checked,
              up,
              down,
              deadFraction: Number(deadFraction.toFixed(3)),
              reason: 'network_down',
            });
          } catch (e) {
            // журнал не критичен
          }
          console.error(
            `[${new Date().toISOString()}] inventory: healthcheck пропущен (сейфгард, сеть недоступна): ` +
              `${down}/${checked} недоступны (${Math.round(deadFraction * 100)}%) — TCP не применён`
          );
        } else {
          // SPEC-STABILITY2 §3: результаты применяем через setHealthResult (GRACE) — одиночный
          // провал НЕ убивает сервер, только alive_fails++; alive=0 лишь после HEALTH_GRACE_FAILS
          // подряд. Успех — мгновенно alive=1, alive_fails=0.
          for (let i = 0; i < checked; i++) {
            const h = hosts[i];
            try {
              db.setHealthResult(h.host, h.port, results[i] === true);
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

/* ─────────────── SPEC-SOURCES §6: гео-обогащение по IP ─────────────── */

let geoInflight = false;

/** host → ISO страны через geoip. Домен резолвим (dns), IP — напрямую. null если не вышло. */
async function geoLookupHost(host) {
  if (!geoip) return null;
  let ip = null;
  if (net.isIP(host)) {
    ip = host;
  } else {
    try {
      const a = await dns.resolve4(host);
      if (a && a.length) ip = a[0];
    } catch (e) {
      // нет A-записи — попробуем AAAA
    }
    if (!ip) {
      try {
        const a6 = await dns.resolve6(host);
        if (a6 && a6.length) ip = a6[0];
      } catch (e) {
        // нет AAAA — гео не выйдет
      }
    }
  }
  if (!ip) return null;
  try {
    const g = geoip.lookup(ip);
    return g && g.country ? String(g.country).toUpperCase() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Отдельный enrich-пасс (SPEC-SOURCES §6.2): заполняет страну только у XX-хостов, пулом
 * DNS-резолва. НЕ блокирует upsert, ошибки глотает. No-op при GEO_ENABLED=0 или отсутствии geoip.
 */
async function runGeoEnrich() {
  if (!config.GEO_ENABLED || !geoip) return;
  let hosts = [];
  try {
    hosts = db.hostsForGeo(config.GEO_BATCH);
  } catch (e) {
    hosts = [];
  }
  if (!hosts.length) return;
  const conc = Math.max(1, Number(config.GEO_CONCURRENCY) || 32);
  await runPool(hosts, conc, async (h) => {
    let iso = null;
    try {
      iso = await geoLookupHost(h);
    } catch (e) {
      iso = null;
    }
    try {
      db.setGeo(h, iso); // iso null → только отметка geo_checked_at (не долбим DNS повторно)
    } catch (e) {
      // одна запись не роняет пасс
    }
    return true;
  });
  try {
    db.logEvent('geo_enrich', { checked: hosts.length });
  } catch (e) {
    // журнал не критичен
  }
}

/** Single-flight обёртка гео-пасса (не накладывается сам на себя). Ошибки уже проглочены. */
async function runGeoEnrichGuarded() {
  if (geoInflight) return false;
  geoInflight = true;
  try {
    await runGeoEnrich();
    return true;
  } finally {
    geoInflight = false;
  }
}

/* ─────────────── SPEC-SOURCES §1: мультиисточниковая загрузка ─────────────── */

/** Каталог per-source last-good кэша (data/cache/). */
function cacheDir() {
  return path.join(path.dirname(path.resolve(config.DB_PATH)), 'cache');
}
/** Путь кэша источника (id может содержать '/', поэтому encodeURIComponent). */
function cachePath(id) {
  return path.join(cacheDir(), encodeURIComponent(String(id)) + '.txt');
}
function readCache(id) {
  try {
    return fs.readFileSync(cachePath(id), 'utf8');
  } catch (e) {
    return null;
  }
}
function writeCache(id, text) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(id), text);
  } catch (e) {
    // кэш best-effort — не критично
  }
}

/**
 * Один заход за источником с conditional GET (ETag/Last-Modified из settings, ключи etag:<id>/
 * lastmod:<id>). 304 → {ok, status:304} (тело берём из кэша выше). file: → чтение с диска.
 */
async function fetchSourceOnce(s) {
  if (String(s.url).startsWith('file:')) {
    try {
      return { ok: true, status: 200, text: fs.readFileSync(filePathFromUrl(s.url), 'utf8') };
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) };
    }
  }
  const etag = db.getSetting('etag:' + s.id, '') || '';
  const lastmod = db.getSetting('lastmod:' + s.id, '') || '';
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const headers = { 'user-agent': 'famas-shop/1.0' };
  if (etag) headers['if-none-match'] = etag;
  if (lastmod) headers['if-modified-since'] = lastmod;
  try {
    const res = await fetch(s.url, { signal: ctrl.signal, redirect: 'follow', headers });
    if (res.status === 304) return { ok: true, status: 304 };
    if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };
    const text = await res.text();
    const ne = res.headers.get('etag');
    const nl = res.headers.get('last-modified');
    if (ne) db.setSetting('etag:' + s.id, ne);
    if (nl) db.setSetting('lastmod:' + s.id, nl);
    return { ok: true, status: 200, text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(to);
  }
}

/** fetchSourceOnce + 1 ретрай (SPEC-SOURCES §1.3). 304 не ретраим (это успех). */
async function fetchSource(s) {
  let r = await fetchSourceOnce(s);
  if (!r.ok && r.status !== 304) r = await fetchSourceOnce(s);
  return r;
}

/**
 * SPEC-SOURCES §1: мультиисточниковый refresh. Тянем все enabled-источники пулом (conditional GET),
 * стриминговым merge (util.mergeInto) собираем ОДИН Map<hash,best> → один upsertConfigs(map.values()).
 * КРИТИЧНО (§7 риск#1): реконсиляцию (деактивацию отсутствующих) выполняем ТОЛЬКО если ВСЕ источники
 * отдали 200/304; при сбое любого — reconcile:false + берём last-good кэш (каталог не обнуляем).
 */
async function doRefreshMulti() {
  try {
    const sources = (config.SOURCES || []).filter((s) => s && s.enabled !== false && s.url);
    if (!sources.length) throw new Error('нет включённых источников (SOURCES пуст)');

    const results = await runPool(sources, SOURCE_FETCH_CONCURRENCY, (s) => fetchSource(s));

    const map = new Map();
    let allOk = true;
    let ok200 = 0;
    let ok304 = 0;
    let failed = 0;
    let usedCache = 0;
    let dropped = 0;

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const r = results[i] || { ok: false, status: 0 };
      let text = null;
      if (r.ok && r.status === 200 && typeof r.text === 'string') {
        text = r.text;
        writeCache(s.id, text); // обновляем last-good
        ok200++;
      } else if (r.ok && r.status === 304) {
        text = readCache(s.id); // не изменилось — берём last-good
        if (text != null) usedCache++;
        ok304++;
      } else {
        // сбой источника: НЕ реконсилируем этот цикл + мержим last-good (каталог не обнуляем)
        allOk = false;
        failed++;
        text = readCache(s.id);
        if (text != null) usedCache++;
        try {
          db.logEvent('source_fail', { id: s.id, status: r.status, error: r.error || null });
        } catch (e) {
          // журнал не критичен
        }
      }
      if (text != null && text !== '') {
        const st = util.mergeInto(map, text, {
          category: s.category === 'white' ? 'white' : 'black',
          includeUuid: config.DEDUP_INCLUDE_UUID,
          allow: config.ALLOWED_PROTOCOLS,
        });
        dropped += st.dropped;
      }
    }

    const merged = [...map.values()];
    map.clear();
    if (!merged.length) throw new Error('мультиисточник: 0 конфигов после merge');

    // Реконсиляция ТОЛЬКО при полном успехе всех источников (SPEC-SOURCES §7 риск#1).
    const r = db.upsertConfigs(merged, { reconcile: allOk });

    // Обрезка каталога до проверяемого размера (лимит серверов на регион) — чтобы healthcheck
    // успевал отсеивать мёртвые на слабом VDS и не грузил процесс.
    try {
      const pr = db.pruneRegions();
      db.logEvent('prune', pr);
    } catch (e) {
      /* prune не критичен */
    }

    await runHealthcheckGuarded();
    await runGeoEnrichGuarded();

    let alive = 0;
    try {
      alive = db.aliveStats().alive;
    } catch (e) {
      alive = 0;
    }
    const regions = db.regionsSummary().length;

    lastRefresh.at = nowSec();
    lastRefresh.ok = true;
    lastRefresh.total = r.total;
    lastRefresh.alive = alive;
    lastRefresh.error = null;

    const out = {
      ok: true,
      total: r.total,
      alive,
      added: r.added,
      revived: r.revived,
      deactivated: r.deactivated,
      regions,
      sources: sources.length,
      ok200,
      ok304,
      failed,
      usedCache,
      dropped,
      unique: merged.length,
      reconciled: allOk,
    };
    db.logEvent('refresh', out);
    // SPEC-GROWTH2 §C.2: успешный refresh → дёрнуть хук (обновить закреп статистики канала). Опц., ошибки глотаются.
    fireRefreshDone(out);
    return out;
  } catch (e) {
    const msg = String((e && e.message) || e);
    lastRefresh.at = nowSec();
    lastRefresh.ok = false;
    lastRefresh.error = msg;
    // total не трогаем — оставляем последнее удачное
    try {
      db.logEvent('refresh', { ok: false, error: msg, multi: true });
    } catch (e2) {
      // журнал не критичен
    }
    console.error(`[${new Date().toISOString()}] inventory: ошибка мультиобновления: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Диспетчер обновления (SPEC-SOURCES §1.2): MULTI_SOURCE=1 → мультиисточник; иначе (дефолт) —
 * старый одиночный путь от SOURCE_URL (обратная совместимость: поведение ровно как раньше).
 */
async function doRefresh() {
  if (config.MULTI_SOURCE) return doRefreshMulti();
  return doRefreshSingle();
}

async function doRefreshSingle() {
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
      // Одиночный источник — чёрный vless-список. parseSource с новым host:port-дедупом
      // (SPEC-SOURCES §3.2) и фильтром протоколов; флаги по дефолту эквивалентны прежнему поведению.
      const { configs } = util.parseSource(text, {
        category: 'black',
        includeUuid: config.DEDUP_INCLUDE_UUID,
        allow: config.ALLOWED_PROTOCOLS,
      });
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
    // SPEC-SOURCES §6: гео-обогащение. No-op при GEO_ENABLED=0 (дефолт) — одиночный путь без изменений.
    await runGeoEnrichGuarded();

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
    // SPEC-GROWTH2 §C.2: успешный refresh → дёрнуть хук (обновить закреп статистики канала). Опц., ошибки глотаются.
    fireRefreshDone({ ...out, skipped });
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

module.exports = {
  start,
  refreshNow,
  runHealthcheck: runHealthcheckGuarded,
  lastRefresh,
  // SPEC-STABILITY2 §4: экспортируем пробы для тестов (TLS-живой→ok; TCP-открыт-но-не-TLS→мёртв).
  tlsAlive,
  tcpAlive,
  // SPEC-GROWTH2 §C.2: опциональный хук «после успешного refresh». index.js присваивает функцию
  // (updateStats канала). null = нет хука (инвентарь работает как раньше). fireRefreshDone читает отсюда.
  onRefreshDone: null,
};
