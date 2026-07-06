/* ═══════════════════════════════════════════════════════════════════
   FAMAS STORE ⁂ — mini app · ванильный JS, без зависимостей
   API: /famas/api (§9 SPEC) · дизайн v2 «FAMAS ROUNDED» (SPEC-V2)
   SPEC-QTY: количество серверов на регион + 3 сортировки витрины
   SPEC-REFERRAL: вкладка «Друзья» (реф-ссылка) + бонус-звёзды в оплате
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Telegram WebApp ─────────────────────────────────────────── */
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  if (tg) {
    try { tg.ready(); } catch (e) { /* noop */ }
    try { tg.expand(); } catch (e) { /* noop */ }
    try { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch (e) { /* noop */ }
  }
  var initData = (tg && tg.initData) || '';

  var API = '/famas/api';
  var BOT_URL = 'https://t.me/FamasSellerBot';
  var SUPPORT_URL = 'https://t.me/sigmatik323';
  var THEME_KEY = 'famas_theme';
  var GLASS_KEY = 'famas_glass';
  var SORT_KEY = 'famas_sort';   // SPEC-QTY: выбранная сортировка витрины
  var THEME_BG = { bw: '#000000', dracula: '#191A21' };
  /* SPEC-REFERRAL: текст к share-ссылке (t.me/share/url?url=...&text=...) */
  var REF_SHARE_TEXT = '⁂ FAMAS STORE — магазин VPN-ключей: моментальная выдача, оплата звёздами Telegram. Заходи по моей ссылке!';

  /* ── состояние ───────────────────────────────────────────────── */
  var S = {
    regions: [],
    regionsSig: '',     // подпись данных: тихий рефреш не трогает DOM без изменений
    price: 20,          // base: 1-й сервер региона (из /api/regions, не хардкод)
    extra: 10,          // SPEC-QTY: каждый доп. сервер того же региона (из /api/regions)
    subDays: 30,
    total: 0,
    updatedAt: 0,
    sel: {},            // iso -> qty (1..count региона)
    selCount: 0,
    sort: 'pop',        // SPEC-QTY: 'pop' | 'az' | 'count' (localStorage famas_sort)
    query: '',
    staggered: false,   // stagger-анимация только при первом рендере
    orders: null,
    free: 0,            // SPEC-FREE: баланс бесплатных регионов (поле free из /api/me)
    bonus: 0,           // SPEC-REFERRAL: бонус-звёзды-скидка (поле bonus из /api/me)
    ref: { count: 0, link: '' }, // SPEC-REFERRAL: приглашено + личная реф-ссылка (ref из /api/me)
    tab: 'shop',
    payBusy: false,
    successPage: '',
    pollTimer: null,
    prevSum: 0,
    sheetOpen: false,
    ovlOpen: false
  };

  /* ── dom ─────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  var elGrid = $('regionGrid');
  var elNote = $('gridNote');
  var elNoteText = $('gridNoteText');
  var elRetry = $('btnRetry');
  var elTrustText = $('trustText');
  var elPaybar = $('paybar');
  var elPayLine = $('payLine');
  var elPaySum = $('paySum');
  var elPayBtn = $('payBtn');
  var elPayLabel = elPayBtn.querySelector('.pb-label');
  var elPayBonus = $('payBonus');
  var elFreeBadge = $('freeBadge');
  var elBonusBadge = $('bonusBadge');
  var elRefWrap = $('refWrap');
  var elRefEmpty = $('refEmpty');
  var elKeys = $('keysList');
  var elToast = $('toast');
  var elErrbar = $('errbar');
  var elErrText = $('errbarText');
  var elOvl = $('ovl');
  var elSheet = $('sheet');
  var elSheetBack = $('sheetBack');
  var elSeg = $('segTheme');
  var elSwGlass = $('swGlass');
  var elSearchWrap = $('searchWrap');
  var elSearchInput = $('searchInput');
  var elSortRow = $('sortRow');
  var elTabInd = $('tabInd');

  /* ── утилиты ─────────────────────────────────────────────────── */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toUnixMs(u) { u = Number(u) || 0; return u > 1e12 ? u : u * 1000; }
  function fmtDate(u) {
    if (!u) return '—';
    var d = new Date(toUnixMs(u));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
  }
  function fmtTime(u) {
    if (!u) return '—';
    var d = new Date(toUnixMs(u));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function plural(n, one, few, many) {
    n = Math.abs(Number(n) || 0) % 100;
    var d = n % 10;
    if (n > 10 && n < 20) return many;
    if (d > 1 && d < 5) return few;
    if (d === 1) return one;
    return many;
  }
  /* 1120 → «1 120» (тонкий пробел между разрядами) */
  function fmtNum(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* нормализация для поиска: регистр + ё→е */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е');
  }
  function isoFlag(iso) {
    try {
      iso = String(iso || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso) || iso === 'XX') return '⁂';
      return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
    } catch (e) { return '⁂'; }
  }
  function flagChipHtml(iso, flag, small) {
    var lo = String(iso || 'xx').toLowerCase();
    var fb = flag || isoFlag(iso);
    var w = small ? 27 : 34;
    var h = small ? 21 : 26;
    return '<span class="flagchip' + (small ? ' sm' : '') + '">' +
      '<img src="/famas/flags/' + esc(lo) + '.svg" alt="" width="' + w + '" height="' + h + '" loading="lazy" decoding="async" draggable="false">' +
      '<i class="flag-fb" hidden>' + esc(fb) + '</i></span>';
  }
  function haptic(kind) {
    try {
      if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.impactOccurred === 'function') {
        tg.HapticFeedback.impactOccurred(kind || 'light');
      }
    } catch (e) { /* noop */ }
  }
  function hapticNotify(kind) {
    try {
      if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.notificationOccurred === 'function') {
        tg.HapticFeedback.notificationOccurred(kind || 'success');
      }
    } catch (e) { /* noop */ }
  }
  function openExternal(url) {
    if (!url) return;
    try { if (tg && typeof tg.openLink === 'function') { tg.openLink(url); return; } } catch (e) { /* noop */ }
    window.open(url, '_blank', 'noopener');
  }
  function openTgLink(url) {
    try { if (tg && typeof tg.openTelegramLink === 'function') { tg.openTelegramLink(url); return; } } catch (e) { /* noop */ }
    window.open(url, '_blank', 'noopener');
  }
  /* SPEC-V2: все анимации — с фолбэком prefers-reduced-motion (FLIP, каунт-ап) */
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* фолбэк SVG-флагов: error не всплывает, ловим на capture-фазе */
  document.addEventListener('error', function (ev) {
    var img = ev.target;
    if (img && img.tagName === 'IMG' && img.parentNode &&
        img.parentNode.classList && img.parentNode.classList.contains('flagchip')) {
      img.hidden = true;
      var fb = img.parentNode.querySelector('.flag-fb');
      if (fb) fb.hidden = false;
    }
  }, true);

  /* ── тосты и плашка ошибок ───────────────────────────────────── */
  var toastTimer = null;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    requestAnimationFrame(function () { elToast.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      elToast.classList.remove('show');
      setTimeout(function () { elToast.hidden = true; }, 240);
    }, 1900);
  }
  var errTimer = null;
  function showErr(msg) {
    elErrText.textContent = msg;
    elErrbar.classList.add('show');
    clearTimeout(errTimer);
    errTimer = setTimeout(function () { elErrbar.classList.remove('show'); }, 4200);
  }

  /* ── копирование с фолбэком ──────────────────────────────────── */
  function copyText(text) {
    function done() { toast('скопировано'); haptic('light'); }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.fontSize = '16px'; /* iOS: <16px на фокусе зумит вьюпорт */
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done(); else showErr('не удалось скопировать');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else legacy();
  }

  /* ── темы и жидкое стекло (SPEC-V2) ──────────────────────────── */
  function getTheme() { return document.documentElement.getAttribute('data-theme') === 'dracula' ? 'dracula' : 'bw'; }
  function getGlass() { return document.documentElement.getAttribute('data-glass') === '1'; }

  function savePref(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* noop */ }
    try {
      if (tg && tg.CloudStorage && typeof tg.CloudStorage.setItem === 'function') {
        tg.CloudStorage.setItem(key, val, function () { /* fire-and-forget */ });
      }
    } catch (e) { /* noop */ }
  }

  function applyChrome() {
    var bg = THEME_BG[getTheme()];
    var meta = $('metaTheme');
    if (meta) meta.setAttribute('content', bg);
    if (tg) {
      try { tg.setHeaderColor(bg); } catch (e) { /* noop */ }
      try { tg.setBackgroundColor(bg); } catch (e) { /* noop */ }
    }
  }

  var themingTimer = null;
  function crossfade() {
    document.body.classList.add('theming');
    clearTimeout(themingTimer);
    themingTimer = setTimeout(function () { document.body.classList.remove('theming'); }, 280);
  }

  function setTheme(theme, save, animate) {
    if (theme !== 'bw' && theme !== 'dracula') theme = 'bw';
    if (animate) crossfade();
    document.documentElement.setAttribute('data-theme', theme);
    applyChrome();
    syncPrefControls();
    if (save) savePref(THEME_KEY, theme);
  }
  function setGlass(on, save, animate) {
    if (animate) crossfade();
    if (on) document.documentElement.setAttribute('data-glass', '1');
    else document.documentElement.removeAttribute('data-glass');
    syncPrefControls();
    if (save) savePref(GLASS_KEY, on ? '1' : '0');
  }

  function syncPrefControls() {
    var th = getTheme();
    var glass = getGlass();
    elSeg.classList.toggle('dr', th === 'dracula');
    var btns = elSeg.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-th') === th;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    elSwGlass.classList.toggle('on', glass);
    elSwGlass.setAttribute('aria-checked', glass ? 'true' : 'false');
  }

  /* при старте: если в localStorage пусто — подтянуть из CloudStorage */
  function loadPrefsFromCloud() {
    var hasLocalTheme = false, hasLocalGlass = false;
    try {
      hasLocalTheme = localStorage.getItem(THEME_KEY) !== null;
      hasLocalGlass = localStorage.getItem(GLASS_KEY) !== null;
    } catch (e) { /* noop */ }
    if (hasLocalTheme && hasLocalGlass) return;
    try {
      if (tg && tg.CloudStorage && typeof tg.CloudStorage.getItems === 'function') {
        tg.CloudStorage.getItems([THEME_KEY, GLASS_KEY], function (err, vals) {
          if (err || !vals) return;
          try {
            if (!hasLocalTheme && (vals[THEME_KEY] === 'bw' || vals[THEME_KEY] === 'dracula')) {
              setTheme(vals[THEME_KEY], false, true);
              try { localStorage.setItem(THEME_KEY, vals[THEME_KEY]); } catch (e2) { /* noop */ }
            }
            if (!hasLocalGlass && (vals[GLASS_KEY] === '1' || vals[GLASS_KEY] === '0')) {
              setGlass(vals[GLASS_KEY] === '1', false, true);
              try { localStorage.setItem(GLASS_KEY, vals[GLASS_KEY]); } catch (e3) { /* noop */ }
            }
          } catch (e4) { /* noop */ }
        });
      }
    } catch (e) { /* noop */ }
  }

  /* ── кнопка «назад» Telegram + Escape: закрывают верхний слой ── */
  function updateBackBtn() {
    var need = S.sheetOpen || S.ovlOpen;
    try {
      if (tg && tg.BackButton) { if (need) tg.BackButton.show(); else tg.BackButton.hide(); }
    } catch (e) { /* noop */ }
  }
  function closeTopLayer() {
    if (S.sheetOpen) { closeSheet(); return true; }
    if (S.ovlOpen) { hideSuccess(); return true; }
    return false;
  }

  /* ── bottom-sheet настроек ───────────────────────────────────── */
  function openSheet() {
    S.sheetOpen = true;
    elSheetBack.hidden = false;
    elSheet.hidden = false;
    requestAnimationFrame(function () {
      elSheetBack.classList.add('in');
      elSheet.classList.add('in');
    });
    haptic('light');
    updateBackBtn();
  }
  function closeSheet() {
    S.sheetOpen = false;
    elSheetBack.classList.remove('in');
    elSheet.classList.remove('in');
    setTimeout(function () { elSheetBack.hidden = true; elSheet.hidden = true; }, 320);
    updateBackBtn();
  }

  /* драг шита за ручку/свободную зону: тянется за пальцем, дальше 84px — закрытие */
  var drag = { on: false, y0: 0, dy: 0 };
  function sheetDragMove(ev) {
    if (!drag.on) return;
    drag.dy = Math.max(0, ev.clientY - drag.y0);
    elSheet.style.transform = 'translateY(' + drag.dy + 'px)';
    elSheetBack.style.opacity = String(Math.max(0, 1 - drag.dy / 260));
  }
  function sheetDragEnd() {
    if (!drag.on) return;
    drag.on = false;
    var dy = drag.dy;
    elSheet.classList.remove('drag');
    if (dy > 84) {
      requestAnimationFrame(function () {
        elSheet.style.transform = '';
        elSheetBack.style.opacity = '';
        closeSheet();
        haptic('light');
      });
    } else {
      elSheet.style.transform = '';
      elSheetBack.style.opacity = '';
    }
  }
  function bindSheetDrag() {
    if (!window.PointerEvent) return;
    elSheet.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('button, input')) return;
      drag.on = true;
      drag.y0 = ev.clientY;
      drag.dy = 0;
      elSheet.classList.add('drag');
      try { elSheet.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
    });
    elSheet.addEventListener('pointermove', sheetDragMove);
    elSheet.addEventListener('pointerup', sheetDragEnd);
    elSheet.addEventListener('pointercancel', sheetDragEnd);
  }

  /* ── регионы ─────────────────────────────────────────────────── */
  function jsonOrThrow(r) {
    if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  /* fetch с таймаутом: зависший запрос не оставит скелетоны навсегда */
  function fetchJson(url, opts, ms) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) { /* noop */ } }, ms || 12000) : null;
    var o = opts || {};
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (r) {
      if (t) clearTimeout(t);
      return jsonOrThrow(r);
    }, function (e) {
      if (t) clearTimeout(t);
      throw e;
    });
  }

  function setTrust() {
    var n = S.total;
    var m = S.regions.length;
    elTrustText.textContent =
      n + ' ' + plural(n, 'сервер', 'сервера', 'серверов') + ' · ' +
      m + ' ' + plural(m, 'страна', 'страны', 'стран') + ' · обновлено ' + fmtTime(S.updatedAt);
  }

  function showNote(text, retry) {
    elNote.hidden = false;
    elNoteText.textContent = text;
    elRetry.hidden = !retry;
  }
  function hideNote() { elNote.hidden = true; }

  function skeletons() {
    var h = '';
    for (var i = 0; i < 9; i++) h += '<div class="skel gl"></div>';
    elGrid.innerHTML = h;
  }

  /* SPEC-QTY: три клиентские сортировки витрины (данные — из /api/regions) */
  function sortRegions(list) {
    var arr = list.slice();
    var byName = function (a, b) {
      return String(a.nameRu || a.name || a.iso).localeCompare(String(b.nameRu || b.name || b.iso), 'ru');
    };
    if (S.sort === 'az') arr.sort(byName);
    else if (S.sort === 'count') {
      arr.sort(function (a, b) {
        return (Number(b.count) || 0) - (Number(a.count) || 0) || byName(a, b);
      });
    } else { /* 'pop' — популярные: popularity desc, тай-брейк count desc */
      arr.sort(function (a, b) {
        return (Number(b.popularity) || 0) - (Number(a.popularity) || 0) ||
               (Number(b.count) || 0) - (Number(a.count) || 0) ||
               byName(a, b);
      });
    }
    return arr;
  }

  function visibleRegions() {
    var list = sortRegions(S.regions);
    if (!S.query) return list;
    var q = norm(S.query);
    return list.filter(function (r) {
      return norm(r.nameRu).indexOf(q) !== -1 ||
             norm(r.name).indexOf(q) !== -1 ||
             norm(r.iso).indexOf(q) !== -1;
    });
  }

  function regionByIso(iso) {
    for (var i = 0; i < S.regions.length; i++) {
      if (S.regions[i].iso === iso) return S.regions[i];
    }
    return null;
  }

  /* SPEC-QTY: низ карточки — цена-подсказка (не выбран) либо степпер + живая цена.
     Цена региона: base + extra*(q-1); максимум q = count («＋» дизейблится). */
  function footInner(r, qty) {
    var count = Number(r.count) || 0;
    if (qty > 0) {
      return '<span class="qty" role="group" aria-label="Количество серверов">' +
          '<button type="button" class="qbtn minus" data-q="-1" aria-label="Убрать сервер"' + (qty <= 1 ? ' disabled' : '') + '>−</button>' +
          '<b class="q-val mono">' + qty + '</b>' +
          '<button type="button" class="qbtn plus" data-q="1" aria-label="Добавить сервер"' + (qty >= count ? ' disabled' : '') + '>＋</button>' +
        '</span>' +
        '<b class="r-price mono">' + fmtNum(S.price + S.extra * (qty - 1)) + ' ⭐</b>';
    }
    return '<span class="r-hint mono">' + fmtNum(S.price) + ' ⭐</span>';
  }

  function cardInner(r, qty) {
    var count = Number(r.count) || 0;
    return flagChipHtml(r.iso, r.flag, false) +
      '<span class="r-name">' + esc(r.nameRu || r.name || r.iso) + '</span>' +
      '<span class="r-count mono">' + count + ' ' + plural(count, 'сервер', 'сервера', 'серверов') + '</span>' +
      '<span class="r-foot">' + footInner(r, qty) + '</span>' +
      '<span class="r-check"><svg viewBox="0 0 12 12"><path d="M2.5 6.5 5 9 9.5 3.5"></path></svg></span>';
  }

  function renderRegions() {
    var list = visibleRegions();
    if (!S.regions.length) {
      elGrid.innerHTML = '';
      showNote('база обновляется — загляни через минуту', true);
      return;
    }
    hideNote();
    if (!list.length) {
      elGrid.innerHTML = '';
      showNote('ничего не нашлось по запросу «' + S.query + '»', false);
      return;
    }
    var doStagger = !S.staggered;
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var q = S.sel[r.iso] || 0;
      var st = doStagger ? (' in" style="animation-delay:' + Math.min(i * 40, 640) + 'ms') : '';
      /* карточка — div[role=button]: внутри живут кнопки степпера (кнопку в кнопку нельзя) */
      html +=
        '<div class="region gl' + (q > 0 ? ' on' : '') + st + '" data-iso="' + esc(r.iso) + '" role="button" tabindex="0" aria-pressed="' + (q > 0 ? 'true' : 'false') + '">' +
          cardInner(r, q) +
        '</div>';
    }
    elGrid.innerHTML = html;
    if (doStagger) S.staggered = true;
  }

  /* ── SPEC-QTY: сортировка — чипы + плавная FLIP-перестановка ──── */
  function syncSortChips() {
    if (!elSortRow) return;
    var btns = elSortRow.querySelectorAll('.sortchip');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-sort') === S.sort;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function setSort(mode, animate) {
    if (mode !== 'pop' && mode !== 'az' && mode !== 'count') mode = 'pop';
    S.sort = mode;
    try { localStorage.setItem(SORT_KEY, mode); } catch (e) { /* noop */ }
    syncSortChips();
    if (!S.regions.length) return; /* витрина ещё грузится — порядок применится при рендере */
    if (animate) flipReorder(); else renderRegions();
  }

  /* FLIP: снять старые позиции → переставить существующие узлы (без пересборки,
     флаги не мигают) → обратный transform → плавный уход в ноль */
  var flipTimer = null;
  function flipReorder() {
    var cards = elGrid.querySelectorAll('.region[data-iso]');
    if (!cards.length) { renderRegions(); return; }
    /* прошлый прогон мог не доиграть: снять его таймер и классы,
       иначе он снимет .flip посреди новой анимации и карточки прыгнут */
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
    for (var c = 0; c < cards.length; c++) cards[c].classList.remove('flip');
    var reduce = reducedMotion();
    var byIso = {};
    var first = {};
    for (var i = 0; i < cards.length; i++) {
      var iso = cards[i].getAttribute('data-iso');
      byIso[iso] = cards[i];
      if (!reduce) first[iso] = cards[i].getBoundingClientRect();
    }
    var list = visibleRegions();
    var frag = document.createDocumentFragment();
    for (var j = 0; j < list.length; j++) {
      if (byIso[list[j].iso]) frag.appendChild(byIso[list[j].iso]);
    }
    elGrid.appendChild(frag);
    if (reduce) return;
    var anim = [];
    for (var k = 0; k < list.length; k++) {
      var el = byIso[list[k].iso];
      var f = first[list[k].iso];
      if (!el || !f) continue;
      var last = el.getBoundingClientRect();
      var dx = f.left - last.left;
      var dy = f.top - last.top;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      el.classList.remove('flip');
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      anim.push(el);
    }
    if (!anim.length) return;
    void elGrid.offsetWidth; /* зафиксировать стартовые transform до анимации */
    requestAnimationFrame(function () {
      for (var m = 0; m < anim.length; m++) {
        anim[m].classList.add('flip');
        anim[m].style.transition = '';
        anim[m].style.transform = '';
      }
      flipTimer = setTimeout(function () {
        flipTimer = null;
        for (var m2 = 0; m2 < anim.length; m2++) anim[m2].classList.remove('flip');
      }, 480);
    });
  }

  /* silent=true — тихий рефреш: без скелетонов, без плашек, DOM трогаем
     только если данные реально изменились. Возвращает Promise<boolean>. */
  function loadRegions(silent) {
    if (!silent) {
      skeletons();
      hideNote();
      elTrustText.textContent = 'загрузка…';
    }
    return fetchJson(API + '/regions')
      .then(function (d) {
        if (!d.ok) throw new Error('bad payload');
        S.regions = d.regions || [];
        S.price = Number(d.price) || S.price;
        /* SPEC-QTY: цена доп. сервера из API (extra=0 — легальное значение) */
        S.extra = (d.extra === undefined || d.extra === null) ? S.extra : (Number(d.extra) || 0);
        S.subDays = Number(d.subDays) || S.subDays;
        S.total = Number(d.total) || 0;
        S.updatedAt = d.updatedAt || 0;
        /* в подписи и цены: их смена тоже требует перерисовки карточек */
        var sig = JSON.stringify([S.regions, S.price, S.extra]);
        var changed = sig !== S.regionsSig;
        S.regionsSig = sig;
        // выброс исчезнувших регионов из выбора + кламп qty к доступному количеству
        var live = {};
        S.regions.forEach(function (r) { live[r.iso] = Number(r.count) || 0; });
        Object.keys(S.sel).forEach(function (iso) {
          var c = live[iso] || 0;
          if (c < 1) delete S.sel[iso];
          else if (S.sel[iso] > c) S.sel[iso] = c;
        });
        S.selCount = Object.keys(S.sel).length;
        // факты и помощь
        $('factPrice').textContent = S.price + ' ★';
        $('factExtra').textContent = '+' + S.extra + ' ★';
        $('factDays').textContent = S.subDays + ' ' + plural(S.subDays, 'ДЕНЬ', 'ДНЯ', 'ДНЕЙ');
        $('helpPrice').textContent = S.price;
        $('helpExtra').textContent = S.extra;
        $('helpDays').textContent = S.subDays;
        // фильтр при >12 регионов
        var needSearch = S.regions.length > 12;
        elSearchWrap.hidden = !needSearch;
        if (!needSearch && S.query) { S.query = ''; elSearchInput.value = ''; }
        setTrust();
        if (!silent || changed) renderRegions();
        updatePaybar(true);
        return true;
      })
      .catch(function () {
        elTrustText.textContent = 'нет связи';
        if (!silent) {
          elGrid.innerHTML = '';
          showNote('сеть недоступна — не удалось загрузить регионы', true);
          showErr('ошибка сети — проверь соединение');
        }
        return false;
      });
  }

  /* ── бесплатные регионы (SPEC-FREE) ──────────────────────────── */
  /* free — только для отображения и предрасчёта в UI: итоговую цену
     ВСЕГДА считает сервер (db.quoteOrder), локальному числу не доверяем. */
  function setFreeBalance(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n === S.free) { renderFree(); return; }
    S.free = n;
    renderFree();
    updatePaybar(false);
  }
  function renderFree() {
    if (!elFreeBadge) return;
    if (S.free > 0) {
      elFreeBadge.textContent = '🎁 ' + S.free + ' ' +
        plural(S.free, 'бесплатный регион', 'бесплатных региона', 'бесплатных регионов');
      elFreeBadge.hidden = false;
    } else {
      elFreeBadge.hidden = true;
    }
  }

  /* ── реферальная программа (SPEC-REFERRAL) ───────────────────── */
  /* bonus — только отображение и предрасчёт: итог ВСЕГДА считает сервер
     (quoteOrder/reserveOrder), локальному числу не доверяем. */
  function setBonusBalance(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n === S.bonus) { renderBonusBadge(); return; }
    S.bonus = n;
    renderBonusBadge();
    renderFriends();
    updatePaybar(false);
  }
  function renderBonusBadge() {
    if (!elBonusBadge) return;
    if (S.bonus > 0) {
      elBonusBadge.textContent = '⭐ бонус: ' + fmtNum(S.bonus) + ' — скидка на покупку';
      elBonusBadge.hidden = false;
    } else {
      elBonusBadge.hidden = true;
    }
  }
  /* личная реф-ссылка: приоритет — ref.link из /api/me; фолбэк — сборка
     из id юзера Telegram (тот же формат t.me/<bot>?start=ref<id>, §5 SPEC-REFERRAL) */
  function refLink() {
    if (S.ref.link) return S.ref.link;
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.id) return BOT_URL + '?start=ref' + u.id;
    } catch (e) { /* noop */ }
    return '';
  }
  /* вкладка «Друзья»: статы + ссылка; без initData — пустое состояние.
     Все данные вставляются через textContent — XSS-safe. */
  function renderFriends() {
    if (!elRefWrap || !elRefEmpty) return;
    var authed = !!initData;
    elRefWrap.hidden = !authed;
    elRefEmpty.hidden = authed;
    if (!authed) return;
    var elCount = $('refCount');
    var elBonus = $('refBonus');
    var elLink = $('refLinkText');
    if (elCount) elCount.textContent = fmtNum(S.ref.count);
    if (elBonus) elBonus.textContent = fmtNum(S.bonus) + ' ⭐';
    var link = refLink();
    if (elLink) elLink.textContent = link || 'загрузка…';
  }
  function copyRefLink() {
    var link = refLink();
    if (link) copyText(link);
    else showErr('ссылка ещё загружается — попробуй через секунду');
  }
  function shareRefLink() {
    var link = refLink();
    if (!link) { showErr('ссылка ещё загружается — попробуй через секунду'); return; }
    haptic('medium');
    openTgLink('https://t.me/share/url?url=' + encodeURIComponent(link) +
      '&text=' + encodeURIComponent(REF_SHARE_TEXT));
  }

  /* ── выбор, количество и панель оплаты (SPEC-QTY) ────────────── */
  /* синхронизация карточки без пересборки флага (img не мигает):
     класс/aria + только низ (.r-foot: подсказка ↔ степпер) */
  function updateCard(card, r) {
    var q = S.sel[r.iso] || 0;
    card.classList.toggle('on', q > 0);
    card.setAttribute('aria-pressed', q > 0 ? 'true' : 'false');
    var foot = card.querySelector('.r-foot');
    if (foot) foot.innerHTML = footInner(r, q);
  }

  /* клик по карточке = выбрать q=1; повторный — снять выбор */
  function toggleRegion(iso) {
    var r = regionByIso(iso);
    if (!r) return;
    if (S.sel[iso]) delete S.sel[iso];
    else S.sel[iso] = 1;
    S.selCount = Object.keys(S.sel).length;
    var card = elGrid.querySelector('.region[data-iso="' + iso + '"]');
    if (card) updateCard(card, r);
    haptic('light');
    updatePaybar(false);
  }

  /* шаг степпера [−]/[＋]: q в 1..count; точечное обновление без ререндера */
  function bumpQty(iso, delta) {
    var r = regionByIso(iso);
    if (!r || !S.sel[iso]) return;
    var count = Math.max(1, Number(r.count) || 1);
    var q = Math.min(count, Math.max(1, S.sel[iso] + (delta > 0 ? 1 : -1)));
    if (q === S.sel[iso]) return;
    S.sel[iso] = q;
    var card = elGrid.querySelector('.region[data-iso="' + iso + '"]');
    if (card) {
      var v = card.querySelector('.q-val');
      if (v) v.textContent = q;
      var mi = card.querySelector('.qbtn.minus');
      if (mi) mi.disabled = q <= 1;
      var pl = card.querySelector('.qbtn.plus');
      if (pl) pl.disabled = q >= count;
      var pr = card.querySelector('.r-price');
      if (pr) pr.textContent = fmtNum(S.price + S.extra * (q - 1)) + ' ⭐'; /* цена региона на лету */
    }
    haptic('light');
    updatePaybar(false);
  }

  function refreshGridSel() {
    var cards = elGrid.querySelectorAll('.region[data-iso]');
    for (var i = 0; i < cards.length; i++) {
      var r = regionByIso(cards[i].getAttribute('data-iso'));
      if (r) updateCard(cards[i], r);
    }
  }

  function selectAll() {
    S.regions.forEach(function (r) { if (!S.sel[r.iso]) S.sel[r.iso] = 1; }); /* qty уже выбранных не сбрасываем */
    S.selCount = Object.keys(S.sel).length;
    refreshGridSel();
    haptic('medium');
    updatePaybar(false);
  }
  function clearSel() {
    S.sel = {};
    S.selCount = 0;
    refreshGridSel();
    haptic('light');
    updatePaybar(false);
  }

  /* стран/серверов в текущем выборе */
  function selStats() {
    var isos = Object.keys(S.sel);
    var servers = 0;
    for (var i = 0; i < isos.length; i++) servers += S.sel[isos[i]];
    return { countries: isos.length, servers: servers };
  }

  var sumAnim = null;
  function animateSum(to) {
    var from = S.prevSum;
    S.prevSum = to;
    /* prefers-reduced-motion: каунт-ап заменяется мгновенным значением (SPEC-V2) */
    if (from === to || reducedMotion()) {
      if (sumAnim) { cancelAnimationFrame(sumAnim); sumAnim = null; }
      elPaySum.textContent = fmtNum(to) + ' ⭐';
      return;
    }
    var t0 = null;
    var dur = 320;
    if (sumAnim) cancelAnimationFrame(sumAnim);
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min((ts - t0) / dur, 1);
      k = 1 - Math.pow(1 - k, 3); /* easeOutCubic */
      elPaySum.textContent = fmtNum(from + (to - from) * k) + ' ⭐';
      if (k < 1) sumAnim = requestAnimationFrame(step);
    }
    sumAnim = requestAnimationFrame(step);
  }

  function updatePaybar(instant) {
    var st = selStats();
    var n = st.countries;
    /* SPEC-QTY §1 (предрасчёт UI — истину считает сервер в quoteOrder/reserveOrder):
       totalCost = Σ(base + extra*(q-1)) = n*base + (servers-n)*extra;
       SPEC-FREE: free гасит base у первых min(free, стран) регионов, extra остаётся платным;
       SPEC-REFERRAL §4: бонус-звёзды добивают остаток ПОСЛЕ free —
       payable = max(0, totalCost − freeUsed*base − bonusUsed) */
    var totalCost = n * S.price + Math.max(0, st.servers - n) * S.extra;
    var freeUsed = Math.min(S.free, n);
    var afterFree = Math.max(0, totalCost - freeUsed * S.price);
    var bonusUsed = Math.min(S.bonus, afterFree);
    var total = afterFree - bonusUsed;
    var line = 'СТРАН: ' + n + ' · СЕРВЕРОВ: ' + st.servers;
    if (freeUsed > 0 && n > 0) line += ' · ' + freeUsed + ' БЕСПЛАТНО';
    elPayLine.textContent = line;
    /* строка бонуса: баланс + фактически применённая скидка */
    if (elPayBonus) {
      if (S.bonus > 0 && n > 0) {
        elPayBonus.textContent = 'БОНУС: ' + fmtNum(S.bonus) + ' ⭐' +
          (bonusUsed > 0 ? ' · ПРИМЕНЕНО −' + fmtNum(bonusUsed) + ' ⭐' : '');
        elPayBonus.hidden = false;
      } else {
        elPayBonus.hidden = true;
      }
    }
    if (instant) {
      /* мгновенное обновление гасит бегущий каунт-ап, иначе его хвост
         перезапишет только что выставленную сумму устаревшим значением */
      if (sumAnim) { cancelAnimationFrame(sumAnim); sumAnim = null; }
      S.prevSum = total;
      elPaySum.textContent = fmtNum(total) + ' ⭐';
    } else animateSum(total);
    elPayLabel.textContent = (n > 0 && total === 0)
      ? '🎁 ПОЛУЧИТЬ БЕСПЛАТНО'
      : 'ОПЛАТИТЬ ' + fmtNum(total) + ' ⭐';
    elPayBtn.disabled = n === 0 || S.payBusy;
    var show = n > 0 && S.tab === 'shop';
    elPaybar.classList.toggle('show', show);
    document.body.classList.toggle('has-pay', show);
    /* выбор не потеряется от случайного свайпа вниз */
    try {
      if (tg && n > 0 && typeof tg.enableClosingConfirmation === 'function') tg.enableClosingConfirmation();
      else if (tg && n === 0 && typeof tg.disableClosingConfirmation === 'function') tg.disableClosingConfirmation();
    } catch (e) { /* noop */ }
  }

  /* ── оплата ──────────────────────────────────────────────────── */
  function setPayBusy(b) {
    S.payBusy = b;
    elPayBtn.classList.toggle('busy', b);
    elPayBtn.disabled = b || S.selCount === 0;
  }

  function pay() {
    if (S.payBusy || !S.selCount) return;
    if (!tg || !initData) { showErr('открой мини-апп внутри Telegram, чтобы оплатить'); return; }
    /* SPEC-QTY: новый формат тела — items:[{iso,qty}]; итог всегда считает сервер */
    var items = [];
    Object.keys(S.sel).forEach(function (iso) {
      items.push({ iso: iso, qty: Math.max(1, Math.floor(Number(S.sel[iso]) || 1)) });
    });
    setPayBusy(true);
    haptic('medium');
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) { /* noop */ } }, 15000) : null;
    fetch(API + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, items: items }),
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) {
        if (t) clearTimeout(t);
        return r.json().catch(function () { return {}; }).then(function (d) {
          /* валидны два ответа: {invoiceLink,...} либо {free:true,...} (SPEC-FREE) */
          if (!r.ok || !d.ok || (!d.invoiceLink && d.free !== true)) throw new Error((d && d.error) || ('HTTP ' + r.status));
          return d;
        });
      })
      .then(function (d) {
        setPayBusy(false);
        if (d.free === true) {
          /* SPEC-FREE: заказ полностью бесплатный — сервер уже выдал ключ,
             счёт не создаётся (инвойс XTR на 0 невозможен), openInvoice не зовём */
          hapticNotify('success');
          clearSel();
          S.orders = null;
          showSuccess({ free: true, page: d.page || '' });
          return;
        }
        if (typeof tg.openInvoice === 'function') {
          tg.openInvoice(d.invoiceLink, function (status) {
            if (status === 'paid') {
              hapticNotify('success');
              clearSel();
              S.orders = null;
              showSuccess();
            } else if (status === 'cancelled') {
              toast('оплата отменена');
              refreshBalances(); /* §7b: free/bonus зарезервированы при создании — бейджи и предпросчёт освежить */
            } else if (status === 'failed') {
              hapticNotify('error');
              showErr('оплата не прошла — попробуй ещё раз');
              refreshBalances();
            } else {
              toast('платёж обрабатывается…');
              refreshBalances();
            }
          });
        } else {
          openTgLink(d.invoiceLink);
          toast('счёт открыт в Telegram');
        }
      })
      .catch(function (e) {
        if (t) clearTimeout(t);
        setPayBusy(false);
        /* понятная ошибка сервера (напр., «в регионе осталось меньше серверов»)
           показывается как есть; сетевые/HTTP — общий текст */
        var msg = '';
        if (e && e.message && e.name !== 'AbortError' && e.name !== 'TypeError' &&
            !/^HTTP \d+$/.test(e.message) && !/^bad payload$/.test(e.message)) {
          msg = e.message;
        }
        showErr(msg || 'не удалось создать счёт — попробуй ещё раз');
        loadRegions(true); /* освежить счётчики доступного — вдруг выбор устарел */
      });
  }

  /* ── экран успеха ────────────────────────────────────────────── */
  function fetchMe() {
    return fetchJson(API + '/me?initData=' + encodeURIComponent(initData))
      .then(function (d) {
        if (!d.ok) throw new Error('bad payload');
        if (typeof d.free !== 'undefined') setFreeBalance(d.free); /* SPEC-FREE: свежий баланс */
        /* SPEC-REFERRAL: бонус-звёзды + реф-статистика (bonus, ref{count,link}) */
        var ref = (d.ref && typeof d.ref === 'object') ? d.ref : null;
        if (ref) {
          S.ref.count = Math.max(0, Math.floor(Number(ref.count) || 0));
          if (typeof ref.link === 'string' && ref.link) S.ref.link = ref.link;
        }
        var bonus = (typeof d.bonus !== 'undefined') ? d.bonus : (ref ? ref.bonus : undefined);
        if (typeof bonus !== 'undefined') setBonusBalance(bonus);
        renderFriends();
        return d.orders || [];
      });
  }
  /* тихая пересинхронизация балансов (free/bonus/реф) и кэша заказов с сервером.
     Важно после ЗАКРЫТОГО инвойса: §7b — скидки списываются при СОЗДАНИИ заказа,
     то есть после «отмены» балансы уже другие, и предпросчёт не должен врать. */
  function refreshBalances() {
    if (!initData) return;
    fetchMe().then(function (orders) { S.orders = orders; }).catch(function () { /* noop: не критично */ });
  }

  /* opts.free=true — бесплатная выдача (SPEC-FREE): страница ключа уже
     известна из ответа /api/order, опрос не нужен; баланс перезапрашиваем. */
  function showSuccess(opts) {
    opts = opts || {};
    var isFree = !!opts.free;
    S.successPage = typeof opts.page === 'string' ? opts.page : '';
    S.ovlOpen = true;
    var title = $('ovlTitle');
    var sub = $('ovlSub');
    if (title) title.textContent = isFree ? 'ПОЛУЧЕНО' : 'ОПЛАЧЕНО';
    if (sub) sub.textContent = isFree ? 'бесплатная выдача — ключ уже активен' : 'ключ уже в чате с ботом';
    try { elOvl.setAttribute('aria-label', isFree ? 'Ключ получен' : 'Оплата прошла'); } catch (e) { /* noop */ }
    if (S.successPage) {
      readySuccessBtn();
    } else {
      var btn = $('btnOpenKey');
      btn.disabled = true;
      btn.textContent = 'ПОЛУЧАЕМ ССЫЛКУ…';
    }
    elOvl.hidden = false;
    requestAnimationFrame(function () { elOvl.classList.add('in'); });
    updateBackBtn();
    loadRegions(true); /* SPEC-QTY: тихо обновить витрину (популярность/счётчики) после сделки */
    if (S.successPage) {
      /* ссылка уже есть — /api/me дёргаем только ради обновления балансов и списка */
      refreshBalances();
    } else {
      pollSuccessPage(0);
    }
  }
  function hideSuccess() {
    S.ovlOpen = false;
    elOvl.classList.remove('in');
    setTimeout(function () { elOvl.hidden = true; }, 260);
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
    updateBackBtn();
  }
  function pollSuccessPage(attempt) {
    if (!initData) { readySuccessBtn(); return; }
    fetchMe().then(function (orders) {
      var act = null;
      for (var i = 0; i < orders.length; i++) {
        if (orders[i].active) { act = orders[i]; break; } /* новые сверху → первый активный */
      }
      if (act && act.page) {
        S.successPage = act.page;
        S.orders = orders;
        readySuccessBtn();
      } else if (attempt < 6) {
        S.pollTimer = setTimeout(function () { pollSuccessPage(attempt + 1); }, 1000);
      } else readySuccessBtn();
    }).catch(function () {
      if (attempt < 6) S.pollTimer = setTimeout(function () { pollSuccessPage(attempt + 1); }, 1200);
      else readySuccessBtn();
    });
  }
  function readySuccessBtn() {
    var btn = $('btnOpenKey');
    btn.disabled = false;
    btn.textContent = 'ОТКРЫТЬ СТРАНИЦУ КЛЮЧА';
  }

  /* ── мои ключи ───────────────────────────────────────────────── */
  function emptyKeysHtml(text, withBtn) {
    return '<div class="empty">' +
      '<div class="empty-mark">⁂</div>' +
      '<p class="e-big serif">пока пусто</p>' +
      '<p class="e-sub mono">' + esc(text) + '</p>' +
      (withBtn ? '<button type="button" class="btn secondary" data-act="goshop">В МАГАЗИН</button>' : '') +
      '</div>';
  }

  function renderKeys() {
    var orders = S.orders || [];
    if (!orders.length) {
      elKeys.innerHTML = emptyKeysHtml('выбери регионы во вкладке «МАГАЗИН» — ключ появится здесь', true);
      return;
    }
    var html = '';
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var chips = '';
      var isos = o.regions || [];
      for (var j = 0; j < isos.length; j++) chips += flagChipHtml(isos[j], isoFlag(isos[j]), true);
      var n = Number(o.servers) || 0;
      var meta = n + ' ' + plural(n, 'сервер', 'сервера', 'серверов') + ' · до ' + fmtDate(o.expiresAt) +
        (o.status === 'gift' ? ' · подарок' : '');
      html +=
        '<article class="keycard gl" style="animation-delay:' + Math.min(i * 40, 400) + 'ms" data-page="' + esc(o.page || '') + '" data-sub="' + esc(o.sub || '') + '">' +
          '<div class="k-top"><span class="k-id">#' + esc(o.id) + '</span>' +
            (o.active ? '<span class="k-status">● АКТИВЕН</span>' : '<span class="k-status off">○ ИСТЁК</span>') +
          '</div>' +
          '<div class="k-rule"></div>' +
          '<div class="k-flags">' + chips + '</div>' +
          '<div class="k-meta">' + esc(meta) + '</div>' +
          '<div class="k-actions">' +
            '<button type="button" class="btn accent" data-act="open">ОТКРЫТЬ</button>' +
            '<button type="button" class="btn secondary" data-act="copy">КОПИРОВАТЬ ССЫЛКУ</button>' +
          '</div>' +
        '</article>';
    }
    elKeys.innerHTML = html;
  }

  function loadKeys() {
    if (!initData) {
      elKeys.innerHTML = emptyKeysHtml('открой мини-апп из Telegram, чтобы видеть свои ключи', false);
      return;
    }
    elKeys.innerHTML = '<div class="skel skel-key gl"></div><div class="skel skel-key gl"></div>';
    fetchMe()
      .then(function (orders) { S.orders = orders; renderKeys(); })
      .catch(function () {
        elKeys.innerHTML = emptyKeysHtml('не удалось загрузить — потяни «⟳» ещё раз', false);
        showErr('ошибка сети — не удалось загрузить ключи');
      });
  }

  /* ── вкладки ─────────────────────────────────────────────────── */
  var TAB_IDX = { shop: 0, keys: 1, friends: 2, help: 3 }; /* SPEC-REFERRAL: + «Друзья» */
  function switchTab(name) {
    if (!TAB_IDX.hasOwnProperty(name) || S.tab === name) return;
    var panes = { shop: $('tab-shop'), keys: $('tab-keys'), friends: $('tab-friends'), help: $('tab-help') };
    var pane = panes[name];
    if (!pane) return; /* null-гард: при кэше старого index.html вкладки «Друзья» может ещё не быть */
    S.tab = name;
    Object.keys(panes).forEach(function (k) { if (panes[k]) panes[k].hidden = k !== name; });
    pane.classList.remove('enter');
    void pane.offsetWidth; /* перезапуск анимации входа */
    pane.classList.add('enter');
    var btns = document.querySelectorAll('.tabbtn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === name);
    elTabInd.style.transform = 'translateX(' + (TAB_IDX[name] * 100) + '%)';
    window.scrollTo(0, 0);
    if (name === 'keys') loadKeys();
    if (name === 'friends') {
      /* SPEC-REFERRAL: рисуем из кэша сразу, счётчики тихо освежаем из /api/me */
      renderFriends();
      refreshBalances();
    }
    updatePaybar(true);
    haptic('light');
  }

  /* ── аккордеон: высота меряется в px — изинг честный, без прыжка ── */
  var ACC_MS = 320;
  function setAcc(item, open) {
    var p = item.querySelector('.acc-panel');
    var btn = item.querySelector('.acc-btn');
    if (!p) return;
    if (open) {
      item.classList.add('open');
      p.style.maxHeight = p.scrollHeight + 'px';
      setTimeout(function () {
        if (item.classList.contains('open')) p.style.maxHeight = 'none';
      }, ACC_MS);
    } else {
      p.style.maxHeight = p.scrollHeight + 'px';
      void p.offsetHeight; /* фиксируем стартовую высоту перед схлопыванием */
      item.classList.remove('open');
      p.style.maxHeight = '0px';
    }
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ── обработчики ─────────────────────────────────────────────── */
  function bind() {
    /* вкладки */
    $('tabbar').addEventListener('click', function (ev) {
      var b = ev.target.closest('.tabbtn');
      if (b) switchTab(b.getAttribute('data-tab'));
    });

    /* сетка регионов: карточка целиком = выбрать/снять, [−][＋] = количество */
    elGrid.addEventListener('click', function (ev) {
      var qb = ev.target.closest('.qbtn');
      if (qb) {
        var qc = qb.closest('.region');
        if (qc && !qb.disabled) bumpQty(qc.getAttribute('data-iso'), Number(qb.getAttribute('data-q')) || 0);
        return;
      }
      if (ev.target.closest('.qty')) return; /* тап по цифре степпера — не переключение карточки */
      var card = ev.target.closest('.region');
      if (card && card.hasAttribute('data-iso')) toggleRegion(card.getAttribute('data-iso'));
    });
    /* карточки — div[role=button]: Enter/Space работают как клик */
    elGrid.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      var t = ev.target;
      if (t && t.classList && t.classList.contains('region') && t.hasAttribute('data-iso')) {
        ev.preventDefault();
        toggleRegion(t.getAttribute('data-iso'));
      }
    });
    /* SPEC-QTY: переключение сортировки витрины */
    elSortRow.addEventListener('click', function (ev) {
      var b = ev.target.closest('.sortchip');
      if (!b) return;
      var mode = b.getAttribute('data-sort');
      if (mode === S.sort) return;
      haptic('light');
      setSort(mode, true);
    });
    /* stagger — только один раз: после проигрыша снимаем класс и delay,
       иначе display-переключение вкладок перезапускало бы анимацию */
    elGrid.addEventListener('animationend', function (ev) {
      var t = ev.target;
      if (t.classList && t.classList.contains('region')) {
        t.classList.remove('in');
        t.style.animationDelay = '';
      }
    });
    $('btnAll').addEventListener('click', selectAll);
    $('btnClr').addEventListener('click', clearSel);
    elRetry.addEventListener('click', function () { loadRegions(false); });
    function trustRefresh() {
      haptic('light');
      loadRegions(true).then(function (ok) {
        if (ok) toast('обновлено');
        else showErr('ошибка сети — проверь соединение');
      });
    }
    $('trustLine').addEventListener('click', trustRefresh);
    $('trustLine').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); trustRefresh(); }
    });

    /* поиск (input + нативный крестик type=search) */
    function onQuery() {
      S.query = elSearchInput.value.trim();
      renderRegions();
    }
    elSearchInput.addEventListener('input', onQuery);
    elSearchInput.addEventListener('search', onQuery);
    elSearchInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') elSearchInput.blur();
    });

    /* оплата */
    elPayBtn.addEventListener('click', pay);

    /* мои ключи: делегирование */
    elKeys.addEventListener('click', function (ev) {
      var act = ev.target.closest('[data-act]');
      if (!act) return;
      var kind = act.getAttribute('data-act');
      if (kind === 'goshop') { switchTab('shop'); return; }
      var card = act.closest('.keycard');
      if (!card) return;
      if (kind === 'open') openExternal(card.getAttribute('data-page'));
      if (kind === 'copy') {
        var sub = card.getAttribute('data-sub');
        if (sub) copyText(sub); else showErr('ссылка недоступна');
      }
    });
    $('btnReloadKeys').addEventListener('click', function () {
      var b = this;
      b.classList.remove('spin');
      void b.offsetWidth; /* перезапуск оборота иконки */
      b.classList.add('spin');
      haptic('light');
      loadKeys();
    });

    /* успех */
    $('btnOpenKey').addEventListener('click', function () {
      if (S.successPage) openExternal(S.successPage);
      else openTgLink(BOT_URL);
    });
    $('btnMyKeys').addEventListener('click', function () { hideSuccess(); switchTab('keys'); });
    $('btnCloseApp').addEventListener('click', function () {
      if (tg && typeof tg.close === 'function') { try { tg.close(); return; } catch (e) { /* noop */ } }
      hideSuccess();
    });

    /* помощь */
    $('acc').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.acc-btn');
      if (!btn) return;
      var item = btn.parentNode;
      setAcc(item, !item.classList.contains('open'));
      haptic('light');
    });
    $('btnSupport').addEventListener('click', function () { openTgLink(SUPPORT_URL); });

    /* SPEC-REFERRAL: «Друзья» — поделиться/копировать; бокс ссылки = тоже копия.
       Новые узлы под null-гардом: пока живёт кэш старого index.html (static 10 мин),
       их может не быть — падать всем bind() из-за этого нельзя. */
    var btnRefShare = $('btnRefShare');
    if (btnRefShare) btnRefShare.addEventListener('click', shareRefLink);
    var btnRefCopy = $('btnRefCopy');
    if (btnRefCopy) btnRefCopy.addEventListener('click', copyRefLink);
    var refBox = $('refLinkBox');
    if (refBox) {
      refBox.addEventListener('click', copyRefLink);
      refBox.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); copyRefLink(); }
      });
    }
    /* бейдж бонуса на витрине → вкладка «Друзья» (пригласи ещё) */
    if (elBonusBadge) {
      elBonusBadge.addEventListener('click', function () { switchTab('friends'); });
      elBonusBadge.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); switchTab('friends'); }
      });
    }

    /* настройки */
    $('btnSettings').addEventListener('click', openSheet);
    $('btnSettings2').addEventListener('click', openSheet);
    elSheetBack.addEventListener('click', closeSheet);
    elSheet.querySelector('.sheet-handle').addEventListener('click', closeSheet);
    elSeg.addEventListener('click', function (ev) {
      var b = ev.target.closest('.seg-btn');
      if (b) { setTheme(b.getAttribute('data-th'), true, true); haptic('light'); }
    });
    elSwGlass.addEventListener('click', function () {
      setGlass(!getGlass(), true, true);
      haptic('light');
    });
    bindSheetDrag();

    /* «назад» Telegram и Escape закрывают верхний слой (шит/успех) */
    try {
      if (tg && tg.BackButton && typeof tg.BackButton.onClick === 'function') {
        tg.BackButton.onClick(closeTopLayer);
      }
    } catch (e) { /* noop */ }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeTopLayer();
    });
  }

  /* ── старт ───────────────────────────────────────────────────── */
  function init() {
    applyChrome();
    syncPrefControls();
    loadPrefsFromCloud();
    /* SPEC-QTY: сохранённая сортировка (дефолт «Популярные») — до первого рендера */
    try {
      var sv = localStorage.getItem(SORT_KEY);
      if (sv === 'pop' || sv === 'az' || sv === 'count') S.sort = sv;
    } catch (e) { /* noop */ }
    syncSortChips();
    bind();
    /* открытый по умолчанию пункт аккордеона — без ограничения высоты */
    var openPanels = document.querySelectorAll('.acc-item.open .acc-panel');
    for (var i = 0; i < openPanels.length; i++) openPanels[i].style.maxHeight = 'none';
    loadRegions(false);
    updatePaybar(true);
    /* SPEC-REFERRAL: первичный рендер «Друзей» (пустое состояние/фолбэк-ссылка до ответа API) */
    renderFriends();
    /* SPEC-FREE + SPEC-REFERRAL: при старте берём балансы (free, bonus, ref) из /api/me */
    refreshBalances();
    /* живая строка доверия: тихий рефреш раз в 2 минуты + при возврате в апп */
    setInterval(function () {
      if (document.visibilityState === 'visible') loadRegions(true);
    }, 120000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') loadRegions(true);
    });
  }

  init();
})();
