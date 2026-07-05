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
    price: 20,
    subDays: 30,
    total: 0,
    updatedAt: 0,
    sel: {},            // iso -> true
    selCount: 0,
    query: '',
    staggered: false,   // stagger-анимация только при первом рендере
    orders: null,
    tab: 'shop',
    payBusy: false,
    successPage: '',
    pollTimer: null,
    prevSum: 0
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
  function isoFlag(iso) {
    try {
      iso = String(iso || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso)) return '⁂';
      return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
    } catch (e) { return '⁂'; }
  }
  function flagChipHtml(iso, flag, small) {
    var lo = String(iso || 'xx').toLowerCase();
    var fb = flag || isoFlag(iso);
    return '<span class="flagchip' + (small ? ' sm' : '') + '">' +
      '<img src="/famas/flags/' + esc(lo) + '.svg" alt="" loading="lazy">' +
      '<i class="flag-fb" hidden>' + esc(fb) + '</i></span>';
  }
  function haptic(kind) {
    try {
      if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.impactOccurred === 'function') {
        tg.HapticFeedback.impactOccurred(kind || 'light');
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
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-th') === th);
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

  /* ── bottom-sheet настроек ───────────────────────────────────── */
  function openSheet() {
    elSheetBack.hidden = false;
    elSheet.hidden = false;
    requestAnimationFrame(function () {
      elSheetBack.classList.add('in');
      elSheet.classList.add('in');
    });
    haptic('light');
  }
  function closeSheet() {
    elSheetBack.classList.remove('in');
    elSheet.classList.remove('in');
    setTimeout(function () { elSheetBack.hidden = true; elSheet.hidden = true; }, 320);
  }

  /* ── регионы ─────────────────────────────────────────────────── */
  function jsonOrThrow(r) {
    if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
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
    for (var i = 0; i < 8; i++) h += '<div class="skel"></div>';
    elGrid.innerHTML = h;
  }

  function visibleRegions() {
    if (!S.query) return S.regions;
    var q = S.query.toLowerCase();
    return S.regions.filter(function (r) {
      return (r.nameRu || '').toLowerCase().indexOf(q) !== -1 ||
             (r.name || '').toLowerCase().indexOf(q) !== -1 ||
             (r.iso || '').toLowerCase().indexOf(q) !== -1;
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

  function loadRegions(silent) {
    if (!silent) { skeletons(); hideNote(); }
    elTrustText.textContent = 'загрузка…';
    return fetch(API + '/regions')
      .then(jsonOrThrow)
      .then(function (d) {
        if (!d.ok) throw new Error('bad payload');
        S.regions = d.regions || [];
        S.price = Number(d.price) || S.price;
        S.subDays = Number(d.subDays) || S.subDays;
        S.total = Number(d.total) || 0;
        S.updatedAt = d.updatedAt || 0;
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
        elSearchWrap.hidden = S.regions.length <= 12;
        setTrust();
        renderRegions();
        updatePaybar(true);
      })
      .catch(function () {
        elTrustText.textContent = 'нет связи';
        if (!silent) {
          elGrid.innerHTML = '';
          showNote('сеть недоступна — не удалось загрузить регионы', true);
        }
        showErr('ошибка сети — проверь соединение');
      });
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

  function selectAll() {
    S.regions.forEach(function (r) { S.sel[r.iso] = true; });
    S.selCount = Object.keys(S.sel).length;
    renderRegions();
    haptic('medium');
    updatePaybar(false);
  }
  function clearSel() {
    S.sel = {};
    S.selCount = 0;
    renderRegions();
    haptic('light');
    updatePaybar(false);
  }

  var sumAnim = null;
  function animateSum(to) {
    var from = S.prevSum;
    S.prevSum = to;
    if (from === to) { elPaySum.textContent = to + ' ⭐'; return; }
    var t0 = null;
    var dur = 300;
    if (sumAnim) cancelAnimationFrame(sumAnim);
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min((ts - t0) / dur, 1);
      k = 1 - Math.pow(1 - k, 3); /* easeOutCubic */
      elPaySum.textContent = Math.round(from + (to - from) * k) + ' ⭐';
      if (k < 1) sumAnim = requestAnimationFrame(step);
    }
    sumAnim = requestAnimationFrame(step);
  }

  function updatePaybar(instant) {
    var n = S.selCount;
    var total = n * S.price;
    elPayLine.textContent = 'ВЫБРАНО ' + n + ' · ИТОГО ' + n + '×' + S.price + ' ⭐';
    if (instant) { S.prevSum = total; elPaySum.textContent = total + ' ⭐'; }
    else animateSum(total);
    elPayBtn.disabled = n === 0 || S.payBusy;
    var show = n > 0 && S.tab === 'shop';
    elPaybar.classList.toggle('show', show);
    document.body.classList.toggle('has-pay', show);
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
    fetch(API + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, regions: regions })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || !d.ok || !d.invoiceLink) throw new Error((d && d.error) || ('HTTP ' + r.status));
          return d;
        });
      })
      .then(function (d) {
        setPayBusy(false);
        if (typeof tg.openInvoice === 'function') {
          tg.openInvoice(d.invoiceLink, function (status) {
            if (status === 'paid') {
              haptic('heavy');
              clearSel();
              S.orders = null;
              showSuccess();
            } else if (status === 'cancelled') {
              toast('оплата отменена');
            } else if (status === 'failed') {
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
        setPayBusy(false);
        showErr('не удалось создать счёт — попробуй ещё раз');
      });
  }

  /* ── экран успеха ────────────────────────────────────────────── */
  function fetchMe() {
    return fetch(API + '/me?initData=' + encodeURIComponent(initData))
      .then(jsonOrThrow)
      .then(function (d) {
        if (!d.ok) throw new Error('bad payload');
        return d.orders || [];
      });
  }

  function showSuccess() {
    S.successPage = '';
    var btn = $('btnOpenKey');
    btn.disabled = true;
    btn.textContent = 'ПОЛУЧАЕМ ССЫЛКУ…';
    elOvl.hidden = false;
    requestAnimationFrame(function () { elOvl.classList.add('in'); });
    pollSuccessPage(0);
  }
  function hideSuccess() {
    elOvl.classList.remove('in');
    setTimeout(function () { elOvl.hidden = true; }, 260);
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
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
    elKeys.innerHTML = '<div class="skel" style="margin-bottom:12px"></div><div class="skel"></div>';
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
    if (!TAB_IDX.hasOwnProperty(name)) return;
    S.tab = name;
    var panes = { shop: $('tab-shop'), keys: $('tab-keys'), help: $('tab-help') };
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
    var btns = document.querySelectorAll('.tabbtn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === name);
    elTabInd.style.transform = 'translateX(' + (TAB_IDX[name] * 100) + '%)';
    window.scrollTo(0, 0);
    if (name === 'keys') loadKeys();
    updatePaybar(true);
    haptic('light');
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
    $('btnAll').addEventListener('click', selectAll);
    $('btnClr').addEventListener('click', clearSel);
    elRetry.addEventListener('click', function () { loadRegions(false); });
    $('trustLine').addEventListener('click', function () {
      loadRegions(true).then(function () { toast('обновлено'); });
    });

    /* поиск */
    elSearchInput.addEventListener('input', function () {
      S.query = elSearchInput.value.trim();
      renderRegions();
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
    $('btnReloadKeys').addEventListener('click', function () { haptic('light'); loadKeys(); });

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
      var open = item.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
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
  }

  /* ── старт ───────────────────────────────────────────────────── */
  function init() {
    applyChrome();
    syncPrefControls();
    loadPrefsFromCloud();
    bind();
    loadRegions(false);
    updatePaybar(true);
  }

  init();
})();
