/* ═══════════════════════════════════════════════════════════════════
   FAMAS STORE ⁂ — mini app · ванильный JS, без зависимостей
   API: /famas/api (§9 SPEC) · дизайн v2 «FAMAS ROUNDED» (SPEC-V2)
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
  var THEME_BG = { bw: '#000000', dracula: '#191A21' };

  /* ── состояние ───────────────────────────────────────────────── */
  var S = {
    regions: [],
    regionsSig: '',     // подпись данных: тихий рефреш не трогает DOM без изменений
    price: 20,
    subDays: 30,
    total: 0,
    updatedAt: 0,
    sel: {},            // iso -> true
    selCount: 0,
    query: '',
    staggered: false,   // stagger-анимация только при первом рендере
    orders: null,
    free: 0,            // SPEC-FREE: баланс бесплатных регионов (поле free из /api/me)
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
  var elFreeBadge = $('freeBadge');
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

  function visibleRegions() {
    if (!S.query) return S.regions;
    var q = norm(S.query);
    return S.regions.filter(function (r) {
      return norm(r.nameRu).indexOf(q) !== -1 ||
             norm(r.name).indexOf(q) !== -1 ||
             norm(r.iso).indexOf(q) !== -1;
    });
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
      var on = !!S.sel[r.iso];
      var st = doStagger ? (' in" style="animation-delay:' + Math.min(i * 40, 640) + 'ms') : '';
      html +=
        '<button type="button" class="region gl' + (on ? ' on' : '') + st + '" data-iso="' + esc(r.iso) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
          flagChipHtml(r.iso, r.flag, false) +
          '<span class="r-name">' + esc(r.nameRu || r.name || r.iso) + '</span>' +
          '<span class="r-count mono">' + (Number(r.count) || 0) + ' серв.</span>' +
          '<span class="r-check"><svg viewBox="0 0 12 12"><path d="M2.5 6.5 5 9 9.5 3.5"></path></svg></span>' +
        '</button>';
    }
    elGrid.innerHTML = html;
    if (doStagger) S.staggered = true;
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
        S.subDays = Number(d.subDays) || S.subDays;
        S.total = Number(d.total) || 0;
        S.updatedAt = d.updatedAt || 0;
        var sig = JSON.stringify(S.regions);
        var changed = sig !== S.regionsSig;
        S.regionsSig = sig;
        // выброс исчезнувших регионов из выбора
        var live = {};
        S.regions.forEach(function (r) { live[r.iso] = true; });
        Object.keys(S.sel).forEach(function (iso) { if (!live[iso]) { delete S.sel[iso]; } });
        S.selCount = Object.keys(S.sel).length;
        // факты и помощь
        $('factPrice').textContent = S.price + ' ★';
        $('factDays').textContent = S.subDays + ' ' + plural(S.subDays, 'ДЕНЬ', 'ДНЯ', 'ДНЕЙ');
        $('helpPrice').textContent = S.price;
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

  /* ── выбор и панель оплаты ───────────────────────────────────── */
  function toggleRegion(iso) {
    if (S.sel[iso]) delete S.sel[iso];
    else S.sel[iso] = true;
    S.selCount = Object.keys(S.sel).length;
    var card = elGrid.querySelector('[data-iso="' + iso + '"]');
    if (card) {
      card.classList.toggle('on', !!S.sel[iso]);
      card.setAttribute('aria-pressed', S.sel[iso] ? 'true' : 'false');
    }
    haptic('light');
    updatePaybar(false);
  }

  /* синхронизация классов выбора без пересборки DOM (не сбрасывает hover/анимации) */
  function refreshGridSel() {
    var cards = elGrid.querySelectorAll('.region[data-iso]');
    for (var i = 0; i < cards.length; i++) {
      var on = !!S.sel[cards[i].getAttribute('data-iso')];
      cards[i].classList.toggle('on', on);
      cards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function selectAll() {
    S.regions.forEach(function (r) { S.sel[r.iso] = true; });
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

  var sumAnim = null;
  function animateSum(to) {
    var from = S.prevSum;
    S.prevSum = to;
    if (from === to) { elPaySum.textContent = fmtNum(to) + ' ⭐'; return; }
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
    var n = S.selCount;
    /* SPEC-FREE: первые min(free, выбрано) регионов бесплатны (предрасчёт UI,
       истина — quoteOrder на сервере) */
    var freeUsed = Math.min(S.free, n);
    var payable = Math.max(0, n - S.free);
    var total = payable * S.price;
    var line = 'ВЫБРАНО ' + n;
    if (freeUsed > 0) line += ' · ' + freeUsed + ' БЕСПЛАТНО';
    line += ' · ИТОГО ' + payable + '×' + S.price + ' ⭐';
    elPayLine.textContent = line;
    if (instant) { S.prevSum = total; elPaySum.textContent = fmtNum(total) + ' ⭐'; }
    else animateSum(total);
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
    var regions = Object.keys(S.sel);
    setPayBusy(true);
    haptic('medium');
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) { /* noop */ } }, 15000) : null;
    fetch(API + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, regions: regions }),
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
            } else if (status === 'failed') {
              hapticNotify('error');
              showErr('оплата не прошла — попробуй ещё раз');
            } else {
              toast('платёж обрабатывается…');
            }
          });
        } else {
          openTgLink(d.invoiceLink);
          toast('счёт открыт в Telegram');
        }
      })
      .catch(function () {
        if (t) clearTimeout(t);
        setPayBusy(false);
        showErr('не удалось создать счёт — попробуй ещё раз');
      });
  }

  /* ── экран успеха ────────────────────────────────────────────── */
  function fetchMe() {
    return fetchJson(API + '/me?initData=' + encodeURIComponent(initData))
      .then(function (d) {
        if (!d.ok) throw new Error('bad payload');
        if (typeof d.free !== 'undefined') setFreeBalance(d.free); /* SPEC-FREE: свежий баланс */
        return d.orders || [];
      });
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
    if (S.successPage) {
      /* ссылка уже есть — /api/me дёргаем только ради обновления free-баланса и списка */
      fetchMe().then(function (orders) { S.orders = orders; }).catch(function () { /* noop */ });
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
  var TAB_IDX = { shop: 0, keys: 1, help: 2 };
  function switchTab(name) {
    if (!TAB_IDX.hasOwnProperty(name) || S.tab === name) return;
    S.tab = name;
    var panes = { shop: $('tab-shop'), keys: $('tab-keys'), help: $('tab-help') };
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
    var pane = panes[name];
    pane.classList.remove('enter');
    void pane.offsetWidth; /* перезапуск анимации входа */
    pane.classList.add('enter');
    var btns = document.querySelectorAll('.tabbtn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === name);
    elTabInd.style.transform = 'translateX(' + (TAB_IDX[name] * 100) + '%)';
    window.scrollTo(0, 0);
    if (name === 'keys') loadKeys();
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

    /* сетка регионов */
    elGrid.addEventListener('click', function (ev) {
      var card = ev.target.closest('.region');
      if (card && card.hasAttribute('data-iso')) toggleRegion(card.getAttribute('data-iso'));
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
    bind();
    /* открытый по умолчанию пункт аккордеона — без ограничения высоты */
    var openPanels = document.querySelectorAll('.acc-item.open .acc-panel');
    for (var i = 0; i < openPanels.length; i++) openPanels[i].style.maxHeight = 'none';
    loadRegions(false);
    updatePaybar(true);
    /* SPEC-FREE: при старте берём free-баланс из /api/me (бейдж + пересчёт панели) */
    if (initData) {
      fetchMe().then(function (orders) { S.orders = orders; }).catch(function () { /* noop: бейдж не критичен */ });
    }
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
