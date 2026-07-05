'use strict';
/**
 * scripts/gift.js — ручная выдача заказа (SPEC §13).
 * Запуск: node scripts/gift.js <tgId> <ISO,ISO|all> [days]
 * Пример: node scripts/gift.js 927937870 DE,NL 30
 */
const db = require('../src/db');
const subscription = require('../src/subscription');

function usage(msg) {
  if (msg) console.error('Ошибка: ' + msg);
  console.log('Использование: node scripts/gift.js <tgId> <ISO,ISO|all> [дней]');
  console.log('Примеры:');
  console.log('  node scripts/gift.js 927937870 DE,NL 30');
  console.log('  node scripts/gift.js 927937870 all');
  process.exit(1);
}

const [, , tgIdRaw, regionsRaw, daysRaw] = process.argv;
if (!tgIdRaw || !regionsRaw) usage();

const tgId = Number(tgIdRaw);
if (!Number.isFinite(tgId) || tgId <= 0) usage(`некорректный tgId: '${tgIdRaw}'`);

let days;
if (daysRaw !== undefined) {
  days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) usage(`некорректное число дней: '${daysRaw}'`);
}

db.init();

const summary = db.regionsSummary();
let regions;
if (regionsRaw.trim().toLowerCase() === 'all') {
  regions = summary.map((r) => r.iso);
  if (!regions.length) {
    console.error('В базе нет активных регионов. Сначала обнови инвентарь (запусти сервис или /admin → «Обновить базу»).');
    process.exit(1);
  }
} else {
  regions = regionsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!regions.length) usage('пустой список регионов');
  const bad = regions.filter((iso) => !/^[A-Z]{2}$/.test(iso));
  if (bad.length) usage(`не ISO-коды: ${bad.join(', ')}`);
  const have = new Set(summary.map((r) => r.iso));
  const missing = regions.filter((iso) => !have.has(iso));
  if (missing.length) {
    console.warn(
      `Предупреждение: сейчас нет активных серверов для: ${missing.join(', ')} ` +
        '(в подписку попадёт fallback, если такой регион когда-либо был в базе).'
    );
  }
}

const effectiveDays = days || db.subDays();
const order = db.createOrder({ userId: tgId, regions, stars: 0, status: 'gift', days });
db.logEvent('gift', { orderId: order.id, tgId, regions, days: effectiveDays, via: 'scripts/gift.js' });

console.log('');
console.log(`Заказ-подарок #${order.id} создан.`);
console.log(`Пользователь:   ${tgId}`);
console.log(`Регионы (${regions.length}):   ${regions.join(', ')}`);
console.log(`Срок:           ${effectiveDays} дн.`);
console.log(`Страница ключа: ${subscription.pageUrl(order.token)}`);
console.log(`Подписка:       ${subscription.subUrl(order.token)}`);

try {
  if (db.db) db.db.close();
} catch (e) {
  // уже закрыта
}
