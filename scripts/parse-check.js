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
      nameRu: util.COUNTRY_RU[c.countryName] || c.countryName || c.countryIso,
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

console.log('');
if (failed) {
  console.error(`FAIL: провалено проверок: ${failed}`);
  process.exit(1);
}
console.log('OK');
