'use strict';
/**
 * scripts/selftest.js — полный self-test: db + inventory + subscription (SPEC §13).
 * Требует установленных npm-зависимостей (better-sqlite3, dotenv).
 * Запуск: node scripts/selftest.js
 */

// Окружение теста задаём ДО require конфига.
process.env.DB_PATH = './data/test.db';
process.env.SOURCE_URL = 'file:fixtures/sample-source.txt';
process.env.SKIP_BOT = '1';
// SPEC-QUALITY: на file-фикстуре реальные IP недоступны из теста — TCP-проверку выключаем,
// чтобы она не помечала серверы мёртвыми (проверки подписки должны работать на живых).
// Блэклист (railway и т.п.) при этом всё равно отрабатывает в refreshNow — его и проверяем.
process.env.HEALTHCHECK_ENABLED = '0';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const db = require('../src/db');
const util = require('../src/util');
const inventory = require('../src/inventory');
const subscription = require('../src/subscription');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  [ok] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function removeTestDb() {
  const base = path.resolve(config.DB_PATH);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(base + suffix);
    } catch (e) {
      // файла нет — и хорошо
    }
  }
}

async function main() {
  console.log('selftest: db + inventory + subscription');
  console.log(`DB_PATH=${config.DB_PATH}  SOURCE_URL=${config.SOURCE_URL}`);
  console.log('');

  // чистый старт
  removeTestDb();
  db.init();

  // 1. Инвентарь из локального файла
  const r = await inventory.refreshNow();
  check('refreshNow: ok===true', r && r.ok === true, r && r.error);
  check('refreshNow: total > 0', !!(r && r.ok && r.total > 0), `total=${r && r.total}`);
  check(
    'lastRefresh обновлён',
    inventory.lastRefresh.at > 0 && inventory.lastRefresh.ok === true,
    JSON.stringify(inventory.lastRefresh)
  );

  // 2. Регионы
  const regions = db.regionsSummary();
  check('regionsSummary непусто', regions.length > 0, `regions=${regions.length}`);
  check(
    'у регионов есть iso/nameRu/flag/count',
    regions.every((x) => x.iso && x.nameRu && typeof x.count === 'number'),
    JSON.stringify(regions[0] || null)
  );

  // 3. Gift-заказ на 2 региона
  const pick = regions.slice(0, 2).map((x) => x.iso);
  check('нашлись 2 региона для теста', pick.length === 2, `pick=${JSON.stringify(pick)}`);

  const created = db.createOrder({ userId: 1, regions: pick, stars: 0, status: 'gift', days: 30 });
  check('createOrder вернул {id, token}', !!(created && created.id && created.token));

  const order = db.getOrderByToken(created.token);
  check('getOrderByToken нашёл заказ', !!order && order.id === created.id);
  check('gift: status = gift', !!order && order.status === 'gift');
  check(
    'gift: expires_at в будущем',
    !!order && Number(order.expires_at) > Math.floor(Date.now() / 1000),
    order && String(order.expires_at)
  );

  // 4. Подписка
  const sub = subscription.buildSub(order);
  check('buildSub: не expired', sub.expired === false);
  check('buildSub: regions совпали', JSON.stringify(sub.regions) === JSON.stringify(pick));
  check('buildSub: lines непусто', sub.lines.length > 0, `lines=${sub.lines.length}`);

  const decoded = Buffer.from(sub.b64, 'base64').toString('utf8');
  const lines = decoded.split('\n').filter(Boolean);
  check('b64 декодируется в те же строки', lines.length === sub.lines.length, `decoded=${lines.length}`);
  check(
    "каждая строка начинается с 'vless://'",
    lines.length > 0 && lines.every((l) => l.startsWith('vless://'))
  );
  check(
    "фрагмент каждой строки содержит 'FAMAS'",
    lines.length > 0 &&
      lines.every((l) => {
        const frag = l.split('#')[1] || '';
        try {
          return decodeURIComponent(frag).includes('FAMAS');
        } catch (e) {
          return false;
        }
      })
  );

  // 5. Заголовки подписки
  check(
    'headers: profile-title в base64',
    typeof sub.headers['profile-title'] === 'string' && sub.headers['profile-title'].startsWith('base64:')
  );
  check(
    'headers: subscription-userinfo с expire',
    String(sub.headers['subscription-userinfo']).includes(`expire=${order.expires_at}`)
  );
  check(
    'headers: profile-web-page-url = pageUrl',
    sub.headers['profile-web-page-url'] === subscription.pageUrl(order.token)
  );

  // 6. Диплинки
  const su = subscription.subUrl(order.token);
  const links = subscription.deepLinks(su);
  check('deepLinks: happ', links.happ === 'happ://add/' + su);
  check('deepLinks: v2raytun', links.v2raytun === 'v2raytun://import/' + su);
  check(
    'deepLinks: v2rayng',
    links.v2rayng === 'v2rayng://install-sub?url=' + encodeURIComponent(su) + '&name=FAMAS%20STORE'
  );

  // 7. SPEC-QTY — количество серверов на регион, цена, выдача, популярность
  const base = db.priceStars();
  const extra = db.extraStars();
  const rBig = regions.find((x) => x.count >= 2); // регион с ≥2 активными серверами
  const rOther = regions.find((x) => rBig && x.iso !== rBig.iso); // любой другой (≥1)
  check('SPEC-QTY: нашёлся регион с ≥2 серверами', !!rBig, JSON.stringify(regions.map((x) => x.iso)));

  if (rBig && rOther) {
    const U = 90210; // тестовый userId, не пересекается с section 3 (userId:1)
    // 7.1 цена: base / base+extra / 2*base+extra
    const q1 = db.quoteOrder(U, { [rBig.iso]: 1 });
    check('quoteOrder({X:1}).totalCost === base', q1.totalCost === base, `${q1.totalCost} vs ${base}`);
    check('quoteOrder({X:1}).servers=1 regionsCount=1', q1.servers === 1 && q1.regionsCount === 1);
    const q2 = db.quoteOrder(U, { [rBig.iso]: 2 });
    check('quoteOrder({X:2}).totalCost === base+extra', q2.totalCost === base + extra, `${q2.totalCost} vs ${base + extra}`);
    check('quoteOrder({X:2}).servers=2', q2.servers === 2);
    const q3 = db.quoteOrder(U, { [rBig.iso]: 2, [rOther.iso]: 1 });
    check('quoteOrder({X:2,Y:1}) === 2*base+extra', q3.totalCost === 2 * base + extra, `${q3.totalCost} vs ${2 * base + extra}`);
    check('quoteOrder({X:2,Y:1}).servers=3 regionsCount=2', q3.servers === 3 && q3.regionsCount === 2);

    // 7.2 валидация: qty>available / qty<1 / пустой / неактивный регион
    const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
    check('quote: qty>available → Error', throws(() => db.quoteOrder(U, { [rBig.iso]: rBig.count + 1000 })));
    check('quote: qty<1 → Error', throws(() => db.quoteOrder(U, { [rBig.iso]: 0 })));
    check('quote: пустой map → Error', throws(() => db.quoteOrder(U, {})));
    check('quote: неактивный регион → Error', throws(() => db.quoteOrder(U, { ZZ: 1 })));

    // 7.3 reserveOrder (§7b): атомарно списывает free; freeUsed = реально списанное
    db.setFree(U, 1);
    const rr = db.reserveOrder(U, { [rOther.iso]: 1 }); // 1 регион × 1 → покрыт free
    check('reserveOrder fully-free: stars=0, fullyFree, freeUsed=1', rr.stars === 0 && rr.fullyFree === true && rr.freeUsed === 1);
    check('reserveOrder списал free → getFree=0', db.getFree(U) === 0, `getFree=${db.getFree(U)}`);
    db.setFree(U, 3);
    check('reserveOrder invalid → free НЕ списан', throws(() => db.reserveOrder(U, { [rBig.iso]: rBig.count + 999 })) && db.getFree(U) === 3);

    // 7.4 configsForRegionsQty: РОВНО count, СТАБИЛЬНО (два вызова — тот же набор)
    const cq1 = db.configsForRegionsQty({ [rBig.iso]: 2 });
    check('configsForRegionsQty({X:2}) → ровно 2', cq1.length === 2, `len=${cq1.length}`);
    check('configsForRegionsQty({X:2}) все того же региона', cq1.every((c) => c.country_iso === rBig.iso));
    const cq2 = db.configsForRegionsQty({ [rBig.iso]: 2 });
    check(
      'configsForRegionsQty стабильно (тот же набор по hash)',
      cq1.length === cq2.length && cq1.every((c, i) => c.hash === cq2[i].hash)
    );
    check('configsForRegionsQty(пусто) → []', db.configsForRegionsQty({}).length === 0);

    // 7.5 популярность: поле есть; растёт после paid-заказа с регионом
    check('regionsSummary: у каждого региона popularity:number', regions.every((x) => typeof x.popularity === 'number'));
    const popBefore = db.regionPopularity().get(rBig.iso) || 0;
    db.createOrder({ userId: U, regions: [rBig.iso], stars: base, status: 'paid', days: 30, qty: { [rBig.iso]: 1 } });
    const popAfter = db.regionPopularity().get(rBig.iso) || 0;
    check('regionPopularity растёт после paid-заказа', popAfter > popBefore, `${popBefore} → ${popAfter}`);

    // 7.6 buildSub: новый заказ (qty) ограничивает купленным + РЕЗЕРВ (SPEC-STABILITY2 §3); старый
    //     (qty NULL) — все серверы. buildSub передаёт reserve=SUB_RESERVE_PER_REGION → в подписке
    //     min(qty+reserve, aliveCount) на регион (резервные живые для мгновенного failover).
    const reserve = config.SUB_RESERVE_PER_REGION;
    const oNew = db.createOrder({ userId: U, regions: [rBig.iso], status: 'gift', days: 30, qty: { [rBig.iso]: 2 } });
    const subNew = subscription.buildSub(db.getOrderByToken(oNew.token));
    const wantNew = db.configsForRegionsQty({ [rBig.iso]: 2 }, 'black', { reserve }).length; // min(2+reserve, alive)
    check('buildSub нового заказа {X:2} → min(2+reserve, alive) строк', subNew.lines.length === wantNew, `lines=${subNew.lines.length} want=${wantNew}`);
    check('buildSub нового заказа: все vless:// + FAMAS', subNew.lines.length === wantNew && subNew.lines.length > 0 && subNew.lines.every((l) => {
      if (!l.startsWith('vless://')) return false;
      try { return decodeURIComponent(l.split('#')[1] || '').includes('FAMAS'); } catch (e) { return false; }
    }));
    // резерв реально добавляет живые сверх купленного, если их достаточно в регионе
    if (rBig.count >= 2 + reserve && reserve > 0) {
      check('резерв: buildSub {X:2} отдал 2+reserve живых', subNew.lines.length === 2 + reserve, `lines=${subNew.lines.length} vs ${2 + reserve}`);
    }
    const oOld = db.createOrder({ userId: U, regions: [rBig.iso], status: 'gift', days: 30 }); // без qty → NULL
    const oOldRow = db.getOrderByToken(oOld.token);
    check('старый заказ: orders.qty IS NULL', oOldRow.qty == null, `qty=${oOldRow.qty}`);
    const subOld = subscription.buildSub(oOldRow);
    check('buildSub старого заказа (qty NULL) → все серверы региона', subOld.lines.length === rBig.count, `lines=${subOld.lines.length} vs count=${rBig.count}`);
  }

  // 8. SPEC-QUALITY — блэклист/живость (детерминированно, без сети)
  const stats0 = db.aliveStats();
  check(
    'aliveStats: active/alive/deadBlacklist/deadUnreachable — числа',
    ['active', 'alive', 'deadBlacklist', 'deadUnreachable'].every((k) => typeof stats0[k] === 'number'),
    JSON.stringify(stats0)
  );
  check('aliveStats: alive <= active', stats0.alive <= stats0.active, JSON.stringify(stats0));
  // блэклист отработал в refreshNow: railway-хосты фикстуры (US) помечены мёртвыми
  check('aliveStats: deadBlacklist >= 1 (блэклист сработал)', stats0.deadBlacklist >= 1, JSON.stringify(stats0));
  // TCP выключен (HEALTHCHECK_ENABLED=0) → недоступных быть не должно
  check('aliveStats: deadUnreachable === 0 (TCP выключен)', stats0.deadUnreachable === 0, JSON.stringify(stats0));

  const hc = db.hostsToCheck();
  check('hostsToCheck: непусто и пары {host,port}', hc.length > 0 && hc.every((h) => h.host && typeof h.port === 'number'), `len=${hc.length}`);
  check('hostsToCheck: исключает railway-хосты (блэклист)', hc.every((h) => !/railway\.app/i.test(h.host)));

  // setAliveByHostPort: круговой рейс — «убить» один host:port и вернуть
  const liveRegion = db.regionsSummary()[0];
  if (liveRegion) {
    const cfgs = db.configsForRegions([liveRegion.iso]);
    const before = cfgs.length;
    if (before > 0) {
      const one = cfgs[0];
      const changed = db.setAliveByHostPort(one.host, one.port, 0);
      check('setAliveByHostPort: >=1 строка изменена', changed >= 1, `changed=${changed}`);
      const after = db.configsForRegions([liveRegion.iso]);
      check('setAliveByHostPort(0): мёртвый host исчез из живой выдачи', after.every((c) => !(c.host === one.host && c.port === one.port)));
      db.setAliveByHostPort(one.host, one.port, 1);
      const restored = db.configsForRegions([liveRegion.iso]);
      check('setAliveByHostPort(1): регион восстановлен', restored.length === before, `${restored.length} vs ${before}`);
    }
  }

  // setAliveByHostPattern: живой регион, у которого «убили» все host по паттерну, исчезает
  const patVictim = db.regionsSummary().find((r) => {
    const rows = db.configsForRegions([r.iso]);
    return rows.length > 0 && rows.every((c) => c.host);
  });
  if (patVictim) {
    const rows = db.configsForRegions([patVictim.iso]);
    const hosts = Array.from(new Set(rows.map((c) => c.host)));
    for (const h of hosts) db.setAliveByHostPattern(h, 0);
    const gone = db.regionsSummary().some((r) => r.iso === patVictim.iso);
    check('setAliveByHostPattern(0): регион без живых исчезает из regionsSummary', gone === false, `iso=${patVictim.iso}`);
    check('configsForRegionsQty мёртвого региона → пусто (нет живых)', db.configsForRegionsQty({ [patVictim.iso]: 5 }).length === 0);
    // вернуть живость
    for (const h of hosts) db.setAliveByHostPattern(h, 1);
    check('setAliveByHostPattern(1): регион вернулся', db.regionsSummary().some((r) => r.iso === patVictim.iso));
  }

  // 9. SPEC-STABILITY2 — grace, резерв, MIN_ALIVE, COUNTRY_BLACKLIST, TLS-проба, «ключ не пропадает»
  console.log('');
  const raw = db.db;
  const insCfg = (iso, host, port, uri, alive) => {
    const hash = util.configHash(uri, false);
    raw.prepare(
      `INSERT OR REPLACE INTO configs(hash,uri,host,port,flag,country_iso,country_name,city,label,list_type,active,alive,alive_fails,first_seen,last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,1,?,0,?,?)`
    ).run(hash, uri, host, port, '', iso, iso, '', '', 'black', alive == null ? 1 : alive, 1000, 2000 + port);
  };

  // 9.0 миграция alive_fails идемпотентна и по умолчанию 0 (новая строка стартует без штрафа)
  check('миграция alive_fails: колонка есть, дефолт 0',
    (() => { insCfg('DE', 'af-default.example', 9440, 'vless://u@af-default.example:9440?security=tls#DE', 1);
      const r = raw.prepare("SELECT alive_fails FROM configs WHERE host='af-default.example'").get();
      return r && Number(r.alive_fails) === 0; })());

  // 9.1 GRACE (HEALTH_GRACE_FAILS=2): 1-й провал — жив (fails=1); 2-й — мёртв (fails=2); успех — жив/0
  insCfg('DE', 'grace.example', 9441, 'vless://u@grace.example:9441?security=tls#DE', 1);
  const graceRow = () => raw.prepare("SELECT alive, alive_fails FROM configs WHERE host='grace.example'").get();
  db.setHealthResult('grace.example', 9441, false);
  let g = graceRow();
  check('grace: 1-й провал — alive=1, alive_fails=1 (блип не убивает)', g.alive === 1 && g.alive_fails === 1, JSON.stringify(g));
  db.setHealthResult('grace.example', 9441, false);
  g = graceRow();
  check('grace: 2-й провал (>=GRACE) — alive=0, alive_fails=2', g.alive === 0 && g.alive_fails === 2, JSON.stringify(g));
  db.setHealthResult('grace.example', 9441, true);
  g = graceRow();
  check('grace: успех — alive=1, alive_fails=0', g.alive === 1 && g.alive_fails === 0, JSON.stringify(g));

  // 9.2 РЕЗЕРВ: min(qty+reserve, aliveCount); без reserve → ровно qty (обратная совместимость)
  const rRich = db.regionsSummary().find((r) => r.count >= 3);
  if (rRich) {
    check('резерв: без reserve = qty(1)', db.configsForRegionsQty({ [rRich.iso]: 1 }).length === 1);
    check('резерв: reserve=2 → min(1+2, alive)=3', db.configsForRegionsQty({ [rRich.iso]: 1 }, 'black', { reserve: 2 }).length === Math.min(3, rRich.count));
  }
  // регион с 1 живым: reserve не превышает aliveCount, И регион скрыт из каталога (MIN_ALIVE), НО выдаётся
  insCfg('AD', 'solo-ad.example', 9442, 'vless://u@solo-ad.example:9442?security=tls#AD', 1);
  check('резерв: регион с 1 живым → отдаёт 1 (min(1+5,1))', db.configsForRegionsQty({ AD: 1 }, 'black', { reserve: 5 }).length === 1);
  check('MIN_ALIVE: регион с 1 живым скрыт из regionsSummary', !db.regionsSummary().some((r) => r.iso === 'AD'));
  check('MIN_ALIVE: регион с 1 живым нет в availabilityMap (не продаётся)', !db.availabilityMap().has('AD'));
  check('MIN_ALIVE: но заказ на скрытый регион всё равно отдаёт свой сервер', db.configsForRegionsQty({ AD: 1 }).length === 1);

  // 9.3 COUNTRY_BLACKLIST=KP: нигде в каталоге/выдаче; заказ на KP не крашит
  insCfg('KP', 'kp1.example', 9443, 'vless://u@kp1.example:9443?security=tls#KP', 1);
  insCfg('KP', 'kp2.example', 9444, 'vless://u@kp2.example:9444?security=tls#KP', 1);
  insCfg('KP', 'kp3.example', 9445, 'vless://u@kp3.example:9445?security=tls#KP', 1);
  check('COUNTRY_BLACKLIST: KP нет в regionsSummary', !db.regionsSummary().some((r) => r.iso === 'KP'));
  check('COUNTRY_BLACKLIST: KP нет в availabilityMap', !db.availabilityMap().has('KP'));
  check('COUNTRY_BLACKLIST: configsForRegions(KP)=0', db.configsForRegions(['KP']).length === 0);
  check('COUNTRY_BLACKLIST: configsForRegionsQty(KP, reserve)=0 (не выдаётся)', db.configsForRegionsQty({ KP: 2 }, 'black', { reserve: 2 }).length === 0);
  check('COUNTRY_BLACKLIST: aliveCountForRegions(KP) пусто', !db.aliveCountForRegions(['KP']).has('KP'));
  const kpOk = (() => { try { const o = db.createOrder({ userId: 55, regions: ['KP'], status: 'gift', days: 30, qty: { KP: 2 } }); const s = subscription.buildSub(db.getOrderByToken(o.token)); return Array.isArray(s.lines); } catch (e) { return false; } })();
  check('COUNTRY_BLACKLIST: заказ на KP не крашит buildSub (0 строк ок)', kpOk === true);

  // 9.4 ПРИОРИТЕТ ПРОДАННЫХ: host:port из активных заказов идут первыми в hostsToCheck
  db.createOrder({ userId: 77, regions: ['AD'], status: 'gift', days: 30, qty: { AD: 1 } });
  const nowS = Math.floor(Date.now() / 1000);
  const allActive = raw.prepare(`SELECT * FROM orders WHERE status IN ('paid','gift') AND expires_at IS NOT NULL AND expires_at >= ?`).all(nowS);
  const soldSet = new Set();
  for (const o of allActive) {
    for (const r of db.liveRowsForOrder(o, { reserve: config.SUB_RESERVE_PER_REGION })) {
      if (r.host && r.port) soldSet.add(r.host + ':' + r.port);
    }
  }
  const hcAll = db.hostsToCheck();
  check('приоритет проданных: набор проданных непуст', soldSet.size > 0, `sold=${soldSet.size}`);
  check('приоритет проданных: hostsToCheck отдаёт {host,port,tls}', hcAll.every((h) => h.host && typeof h.port === 'number' && (h.tls === 0 || h.tls === 1)));
  let lastSold = -1, firstNonSold = -1;
  for (let i = 0; i < hcAll.length; i++) {
    const key = hcAll[i].host + ':' + hcAll[i].port;
    if (soldSet.has(key)) lastSold = i;
    else if (firstNonSold === -1) firstNonSold = i;
  }
  check('приоритет проданных: все проданные раньше первого непроданного', firstNonSold === -1 || lastSold < firstNonSold, `lastSold=${lastSold} firstNonSold=${firstNonSold}`);

  // 9.5 TLS-ПРОБА: живой TLS-сервер → alive; TCP-открыт-но-не-TLS → мёртв (ловим «битый»)
  const tlsMod = require('node:tls');
  const netMod = require('node:net');
  const TEST_KEY = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDl85ZQYzgQ8yGL',
    'saTmpP/XzLQU+cLTIrnKp/IhEXwWQWqsFWsV/iUSQwvbPtwpX1OCSb54pRXzvcke',
    'KXReT8ArEDxjCyZHtRlCxeloNZ3nGMp2/Mu3WGYWoMzaBugrjNYPrHieTYrYjlT6',
    'auVNHqY9c+Vcj1z7ccK8ZoiL1nUQ4tOp8HydkwGIdP95Z6joQWu5fh0IgtGsKqqK',
    '2KzTi5zW8BNL+kwuyF17dCWfVxUZscPGC5eFybhB+qANhJXgEzLyj3/glSAIcEjt',
    't1geF3wILuu7L5hvLUvCBJLzp9uAcRpRi1UtdiNA2dlMxLGZSP7flVe6LZqQsP5r',
    'G3PK4eJNAgMBAAECggEABxg63QQSqMM3l73FXrBcjGXucG88SZNatBv2ZnrJn04p',
    'YmHOygDrV+LlrMAFvukIBI8N518AjGKgn+ObiYVgYnO/yTaA2dmGi/7bMrHky0qC',
    'hKVMC74YeD5B08A+zYks2ZLyrb+qtv+9M3S02mpFqsO2oeJydfeOkI2BTP8y4XBv',
    'J/XxehYInidwC7XhRCgn0nCUr2+gBDNcjQnoi+T10ZwPkRp4PwoyutNrJ0ip6tQv',
    'fb8KEQVlZL/NaZ4pGyNcfppdglq2U0shFxr6mrxhekiI8eeUCXfcr714ok998ZgA',
    'SXmfFJRMPDzgpQrK4X3TVwhYcpvwRkUP/RfSngT2wQKBgQD73pJGiZOjfMnoEk98',
    '/d2ar1HAsQQlGTOBxNiNHuX5FOcJ6uQSLtoaZM3dT5z7AqvZjV7MXO5IUBIZNsgm',
    'b1NRyQMYAsbds3dWA0HbIahsehFd69dbW6BwFykdzgWcU7LkQ6lVF6wEzj+eb8Z6',
    'jBaPr7pFQEcEi4UZX4B9DebcpQKBgQDpuP9Ts1TdY4bbPte7OvxBI3GZXUeK6ym1',
    'APD7xi5pckm17Jp8qEMePiHalJ/eZUDfmFKsQn/5bA8/gXTv6LbPcRlunLOV5Fxp',
    '5aOcKuaNEMXJQn24xA25iKc/fj4x3sKH6Kv+yyuA4V6c3hO/f4+DFQ4Iu7AIcmQT',
    'XSoRF682iQKBgEdiBzbymuNE5LxfJCQalwnWEmd4Q+J3x/9JWM52KVt0rx5Cci0t',
    'FidQ1n+YprcFRMs9o9ZrqCTafKakvgkWmBifzb6qWs5OpM290pZWbbOAzRc/ViPQ',
    'TiI2jjKiRzjNB/BltMInGVurUKCIsUneFi7W8QXbd8Uz/Z75UCMhI4L5AoGBALX6',
    'yTMOqsFGQTZsk+TAZLEDO+xB6PaNbAf3F6ux/2kzB5mTBCaTjM77abibiG7NP9nY',
    '7GYb0TEPpj+4OKij9dNHKJorgNjw2dPKbb2m2aR0rsup7eHzJQyVDkQts5d47taL',
    'n3/gCZtr3xMdBxtP4xoZRrgeC05IYwuAusRcQJyhAoGBAJOMiRnrg256BI4NIrV5',
    'd8GxKDr86FKpHOIvsWSPIM56XOJWUdyCPLi88/4mUbuA/O2O+NoqIFOWq+p10rPg',
    'p3guX2r0T+v0iLLRzGIuiaE6+CXPu4muwNQ4icaJ1btCqkrxR9gnT565Or37vhfi',
    'BW0xE1R4n+l9Q6uekW2b4Ii/',
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n');
  const TEST_CERT = [
    '-----BEGIN CERTIFICATE-----',
    'MIIDCzCCAfOgAwIBAgIUeU0ONW8fWQXQLri8Gt/V/LV7iqYwDQYJKoZIhvcNAQEL',
    'BQAwFTETMBEGA1UEAwwKZmFtYXMtdGVzdDAeFw0yNjA3MDYxNjQxMzlaFw0zNjA3',
    'MDMxNjQxMzlaMBUxEzARBgNVBAMMCmZhbWFzLXRlc3QwggEiMA0GCSqGSIb3DQEB',
    'AQUAA4IBDwAwggEKAoIBAQDl85ZQYzgQ8yGLsaTmpP/XzLQU+cLTIrnKp/IhEXwW',
    'QWqsFWsV/iUSQwvbPtwpX1OCSb54pRXzvckeKXReT8ArEDxjCyZHtRlCxeloNZ3n',
    'GMp2/Mu3WGYWoMzaBugrjNYPrHieTYrYjlT6auVNHqY9c+Vcj1z7ccK8ZoiL1nUQ',
    '4tOp8HydkwGIdP95Z6joQWu5fh0IgtGsKqqK2KzTi5zW8BNL+kwuyF17dCWfVxUZ',
    'scPGC5eFybhB+qANhJXgEzLyj3/glSAIcEjtt1geF3wILuu7L5hvLUvCBJLzp9uA',
    'cRpRi1UtdiNA2dlMxLGZSP7flVe6LZqQsP5rG3PK4eJNAgMBAAGjUzBRMB0GA1Ud',
    'DgQWBBQSB9MS+ulYl9a2FSio3CwrRpNEtjAfBgNVHSMEGDAWgBQSB9MS+ulYl9a2',
    'FSio3CwrRpNEtjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA6',
    'oecH/c6b3v/jusxF/OdgIAAJIWXLsL9X2pfHSDGpM3FMaNcHgDnOc0/uWLAN8i77',
    'uSYuxYMklqMohv9F0oclWeISg9m4TC+fX20qA+ZrNpr9QarqMdazEwLZKIwZLlMg',
    'X4L248Ia2/ITxKenmii8tlH72pb0JPtekJkfenG7iE8at9QqXZrJqROpLHrTeCRj',
    '3p1x9edVtkXTHgQQbrx0uCkLS2qT0hx2YbHfWO9zWLnXf40WDQdaSSCdxjlFX/b/',
    'k/95/SSGoCwPepmOf2uKP+AsNRCMMjaPTkFLWENL6xGKQOnemB8b83LSYawRMLJ4',
    'Ugf23IAm8WTMBNU1+yIV',
    '-----END CERTIFICATE-----',
    '',
  ].join('\n');
  const tlsSrv = tlsMod.createServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => { s.on('error', () => {}); s.end(); });
  tlsSrv.on('error', () => {});
  tlsSrv.unref();
  await new Promise((res, rej) => { tlsSrv.once('error', rej); tlsSrv.listen(0, '127.0.0.1', res); });
  const tport = tlsSrv.address().port;
  const tlsGood = await inventory.tlsAlive('127.0.0.1', tport, 3000);
  check('TLS-проба: живой TLS-сервер → alive', tlsGood === true, `tport=${tport}`);
  try { tlsSrv.close(); } catch (e) { /* fire-and-forget: process.exit в конце уберёт хендлы */ }

  const plainSrv = netMod.createServer((s) => { s.on('error', () => {}); });
  plainSrv.on('error', () => {});
  plainSrv.unref();
  await new Promise((res, rej) => { plainSrv.once('error', rej); plainSrv.listen(0, '127.0.0.1', res); });
  const pport = plainSrv.address().port;
  const tcpOpen = await inventory.tcpAlive('127.0.0.1', pport, 3000);
  const tlsBad = await inventory.tlsAlive('127.0.0.1', pport, 3000);
  check('TLS-проба: TCP-открыт-но-не-TLS → TCP видит alive', tcpOpen === true);
  check('TLS-проба: TCP-открыт-но-не-TLS → TLS мёртв (ловим «битый»)', tlsBad === false);
  try { plainSrv.close(); } catch (e) { /* fire-and-forget */ }

  // 9.6 КЛЮЧ НЕ ПРОПАДАЕТ: заказ на регион, у которого стало 0 живых, остаётся видимым
  insCfg('AL', 'solo-al.example', 9446, 'vless://u@solo-al.example:9446?security=tls#AL', 1);
  const keep = db.createOrder({ userId: 88, regions: ['AL'], status: 'gift', days: 30, qty: { AL: 1 } });
  db.setAliveByHostPort('solo-al.example', 9446, 0); // регион обнулился
  check('ключ не пропадает: заказ остаётся в ordersOfUser при 0 живых', db.ordersOfUser(88).some((o) => o.id === keep.id));
  const keepRow = db.getOrder(keep.id);
  check('ключ не пропадает: active по сроку (не по живости)', Number(keepRow.expires_at) > Math.floor(Date.now() / 1000));
  check('ключ не пропадает: aliveCountForRegions(AL)=0', (db.aliveCountForRegions(['AL']).get('AL') || 0) === 0);
  const keepSub = subscription.buildSub(keepRow);
  check('ключ не пропадает: buildSub не бросает (0 строк допустимо)', Array.isArray(keepSub.lines));

  // 9.7 refresh (upsertConfigs) НЕ сбрасывает alive/alive_fails проданного сервера (SPEC-STABILITY2 §4)
  insCfg('DE', 'sold-keep.example', 9447, 'vless://u@sold-keep.example:9447?security=tls#DE', 1);
  db.setHealthResult('sold-keep.example', 9447, false); // grace: alive_fails=1, alive остаётся 1
  const beforeR = raw.prepare("SELECT alive, alive_fails FROM configs WHERE host='sold-keep.example'").get();
  const reparse = util.parseSource('vless://u@sold-keep.example:9447?security=tls#DE', { category: 'black' }).configs[0];
  db.upsertConfigs([reparse], { reconcile: false }); // как повторный refresh увидел тот же сервер
  const afterR = raw.prepare("SELECT alive, alive_fails FROM configs WHERE host='sold-keep.example'").get();
  check('refresh (upsertConfigs) НЕ сбрасывает alive/alive_fails проданного',
    afterR && Number(afterR.alive) === Number(beforeR.alive) && Number(afterR.alive_fails) === Number(beforeR.alive_fails),
    `before=${JSON.stringify(beforeR)} after=${JSON.stringify(afterR)}`);
}

main()
  .then(() => {
    try {
      if (db.db) db.db.close();
    } catch (e) {
      // уже закрыта
    }
    removeTestDb();
    console.log('');
    if (failed) {
      console.error(`FAIL: провалено проверок: ${failed}`);
      process.exit(1);
    }
    console.log('OK');
    process.exit(0);
  })
  .catch((e) => {
    try {
      if (db.db) db.db.close();
    } catch (e2) {
      // уже закрыта
    }
    removeTestDb();
    console.error('FAIL:', (e && e.stack) || e);
    process.exit(1);
  });
