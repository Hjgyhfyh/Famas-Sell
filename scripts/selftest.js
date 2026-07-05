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
