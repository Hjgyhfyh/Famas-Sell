'use strict';
/**
 * scripts/parse-check.js — чистый тест парсера (SPEC §13).
 * Без npm-зависимостей: только node:fs/path и src/util.js.
 * Запуск: node scripts/parse-check.js
 */
const fs = require('node:fs');
const path = require('node:path');
const util = require('../src/util');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  [ok] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const file = path.join(__dirname, '..', 'fixtures', 'sample-source.txt');
let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error(`Не удалось прочитать фикстуру: ${file}`);
  console.error(String((e && e.message) || e));
  process.exit(1);
}

const { meta, configs } = util.parseSource(text);

console.log('parse-check: ' + file);
console.log(`meta.title:    ${meta.title}`);
console.log(`meta.count:    ${meta.count}`);
console.log(`meta.dateLine: ${meta.dateLine}`);
console.log(`configs:       ${configs.length}`);
console.log('');

check('configs.length >= 100', configs.length >= 100, `получено ${configs.length}`);

const known = configs.filter((c) => c.countryIso !== 'XX').length;
check(
  ">= 90% строк с countryIso != 'XX'",
  configs.length > 0 && known >= configs.length * 0.9,
  `определено ${known} из ${configs.length}`
);

const uniq = new Set(configs.map((c) => c.hash));
check('уникальных hash == configs.length', uniq.size === configs.length, `uniq=${uniq.size}`);

check("flagToIso('🇩🇪') === 'DE'", util.flagToIso('🇩🇪') === 'DE', `получено '${util.flagToIso('🇩🇪')}'`);
check("isoToFlag('NL') === '🇳🇱'", util.isoToFlag('NL') === '🇳🇱', `получено '${util.isoToFlag('NL')}'`);

// таблица регионов: iso, nameRu, count
const byIso = new Map();
for (const c of configs) {
  let row = byIso.get(c.countryIso);
  if (!row) {
    row = {
      iso: c.countryIso,
      nameRu: util.nameRuOf(c.countryIso, c.countryName),
      count: 0,
    };
    byIso.set(c.countryIso, row);
  }
  row.count++;
}
const rows = [...byIso.values()].sort((a, b) =>
  String(a.nameRu).localeCompare(String(b.nameRu), 'ru')
);

console.log('');
console.log('РЕГИОНЫ (' + rows.length + '):');
console.log('ISO  НАЗВАНИЕ                    СЕРВЕРОВ');
console.log('---  --------------------------  --------');
for (const r of rows) {
  console.log(`${String(r.iso).padEnd(4)} ${String(r.nameRu).padEnd(27)} ${r.count}`);
}

/* ─────────── SPEC-SOURCES §2/§3: мультиформатный парсинг и дедуп по host:port ───────────
 * Самодостаточные семплы (репрезентативные строки из gm/1..26.txt + samples.txt): парсер должен
 * извлекать только vless, отбрасывать не-vless, декодировать base64-подписку, разбивать склеенные
 * строки, схлопывать host:port-дубли и помечать whitelist. Внешние файлы не требуются (портируемо). */
console.log('');
console.log('SPEC-SOURCES: мультиформат + дедуп по host:port');

// 1) Смешанные протоколы (trojan/ss/hysteria2/vmess) → остаётся только vless; не-vless в dropped.
const mixed = [
  'trojan://humanity@104.16.71.213:443?security=tls&sni=x#T', // из gm/16
  'hysteria2://03e7f55f-22f8-4564-880f-b86c8cdbf140@45.196.182.131:8449?security=tls#H',
  'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpi@104.156.233.234:27116#S',
  'vmess://eyJhZGQiOiAiaGwxMTIuY293anVtcC5zaXRlIn0=',
  'vless://9480871a-3843-441c-9b83-aa8c5c96b209@155.117.137.239:443?security=reality&sni=x#🇩🇪 Germany',
].join('\n');
const rm = util.parseSource(mixed);
check('mixed: остаётся только 1 vless', rm.configs.length === 1, `configs=${rm.configs.length}`);
check('mixed: 4 не-vless в meta.dropped', rm.meta.dropped === 4, `dropped=${rm.meta.dropped}`);
check('mixed: извлечён iso=DE', rm.configs[0] && rm.configs[0].countryIso === 'DE', rm.configs[0] && rm.configs[0].countryIso);

// 2) Склеенные vless:// в одной строке → разбиваются на два конфига.
const glued =
  'vless://11111111-1111-1111-1111-111111111111@10.0.0.1:443?security=tls#🇳🇱 NL' +
  'vless://22222222-2222-2222-2222-222222222222@10.0.0.2:443?security=reality#🇫🇮 FI';
const rg = util.parseSource(glued);
check('glued: разбит на 2 конфига', rg.configs.length === 2, `configs=${rg.configs.length}`);

// 3) base64-подписка (тело без ://) декодируется перед разбором.
const b64sub = Buffer.from(
  'vless://33333333-3333-3333-3333-333333333333@10.0.0.3:8443?security=tls#🇩🇪 DE',
  'utf8'
).toString('base64');
const rb = util.parseSource(b64sub);
check('base64-подписка декодируется', rb.configs.length === 1, `configs=${rb.configs.length}`);

// 4) Дедуп по host:port: разные uri (uuid/security) с одинаковым host:port → один конфиг.
const dupHost = [
  'vless://aaaaaaaa-1111-1111-1111-111111111111@9.9.9.9:443?security=none#a',
  'vless://bbbbbbbb-2222-2222-2222-222222222222@9.9.9.9:443?security=reality#b',
].join('\n');
const rd = util.parseSource(dupHost);
check('host:port-дедуп: 2 строки → 1 конфиг', rd.configs.length === 1, `configs=${rd.configs.length}`);
check(
  'configHash стабилен для одного host:port (разные uri)',
  util.configHash(dupHost.split('\n')[0], false) === util.configHash(dupHost.split('\n')[1], false)
);
check(
  'DEDUP_INCLUDE_UUID различает разные uuid',
  util.configHash(dupHost.split('\n')[0], true) !== util.configHash(dupHost.split('\n')[1], true)
);

// 5) Whitelist (файл 26): mergeInto — при коллизии host:port категория black побеждает white
//    (f0d42f3: основной каталог 1-25 большой, white — только эксклюзивные whitelist-серверы файла 26).
//    Представителя uri/меток при этом всё равно выбирает pickBest (reality>tls>none) — отдельно от категории.
const wmap = new Map();
util.mergeInto(wmap, 'vless://cccccccc-3333-3333-3333-333333333333@8.8.4.4:443?security=none#black', {
  category: 'black',
});
util.mergeInto(wmap, 'vless://dddddddd-4444-4444-4444-444444444444@8.8.4.4:443?security=reality#white', {
  category: 'white',
});
const wone = [...wmap.values()][0];
check('mergeInto: коллизия схлопнута в 1', wmap.size === 1, `size=${wmap.size}`);
check('mergeInto: black побеждает white', wone && wone.category === 'black', wone && wone.category);
check('mergeInto: pickBest сохранил reality-представителя', wone && wone._sec === 3, wone && String(wone._sec));

// 6) Одиночный источник с category:'white' → все конфиги помечены white (для list_type).
const rw = util.parseSource('vless://eeeeeeee-5555-5555-5555-555555555555@1.1.1.1:443#🇸🇪 SE', {
  category: 'white',
});
check('parseSource(category:white): конфиг помечен white', rw.configs[0] && rw.configs[0].category === 'white');

console.log('');
if (failed) {
  console.error(`FAIL: провалено проверок: ${failed}`);
  process.exit(1);
}
console.log('OK');
