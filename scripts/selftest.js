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

    // 7.6 buildSub: новый заказ (qty) ограничивает; старый (qty NULL) — все серверы
    const oNew = db.createOrder({ userId: U, regions: [rBig.iso], status: 'gift', days: 30, qty: { [rBig.iso]: 2 } });
    const subNew = subscription.buildSub(db.getOrderByToken(oNew.token));
    check('buildSub нового заказа {X:2} → ровно 2 строки', subNew.lines.length === 2, `lines=${subNew.lines.length}`);
    check('buildSub нового заказа: все vless:// + FAMAS', subNew.lines.length === 2 && subNew.lines.every((l) => {
      if (!l.startsWith('vless://')) return false;
      try { return decodeURIComponent(l.split('#')[1] || '').includes('FAMAS'); } catch (e) { return false; }
    }));
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
