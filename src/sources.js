'use strict';
/**
 * src/sources.js — реестр источников каталога (SPEC-SOURCES §1.1).
 *
 * Чистый модуль-данные: НИКАКИХ require (ни сторонних либ, ни других src-модулей),
 * чтобы его можно было require из config.js без циклов и побочек. Коммитится и редактируется
 * вручную. Оверрайд из окружения — через config.SOURCES_JSON (см. config.js §1.2).
 *
 * Каждый элемент: { id, url, category, type, enabled, heavy }
 *   id       — стабильный идентификатор (ключ кэша data/cache/<id>.txt, etag:<id>, lastmod:<id>);
 *   url      — raw-ссылка мирора AvenCores/goida-vpn-configs (уже нормализован/раскодирован);
 *   category — 'black' (файлы 1–25) | 'white' (файл 26 — чистый РФ-whitelist, побеждает при дедупе);
 *   type     — 'mixed' (внутри файла разные протоколы; при парсинге оставляем только vless);
 *   enabled  — участвует ли в рефреше (можно выключить тяжёлый/битый источник без удаления);
 *   heavy    — «тяжёлый» источник (#2 ≈ 63 MB / 257k строк): тянем через conditional GET и
 *              стриминговый merge (SPEC-SOURCES §2.6/§7); при проблемах владелец ставит enabled:false.
 *
 * URL-шаблон (обе формы эквивалентны, берём raw): githubmirror/N.txt, N = 1..26.
 */

// База raw-мирора. N подставляется в 1..26.
const MIRROR_BASE = 'https://raw.githubusercontent.com/AvenCores/goida-vpn-configs/main/githubmirror';

/** Собрать один источник по номеру файла мирора. */
function mirrorSource(n, extra) {
  return Object.assign(
    {
      id: 'githubmirror/' + n + '.txt',
      url: MIRROR_BASE + '/' + n + '.txt',
      category: 'black',
      type: 'mixed',
      enabled: true,
      heavy: false,
    },
    extra || {}
  );
}

const SOURCES = [];
for (let n = 1; n <= 25; n++) {
  // Файл #2 — тяжёлый (≈63 MB): помечаем heavy, но НЕ выключаем (основной прирост объёма).
  SOURCES.push(mirrorSource(n, n === 2 ? { heavy: true } : null));
}
// Файл #26 — «белые списки» (уже чистый и дедуплицированный РФ-whitelist).
SOURCES.push(mirrorSource(26, { category: 'white' }));

module.exports = SOURCES;
