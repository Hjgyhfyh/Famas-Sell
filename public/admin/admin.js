/* ═══════════════════════════════════════════════════════════════════
   FAMAS STORE ⁂ — админка «кто что купил» · ванильный JS, без зависимостей
   API: /famas/admin/api (SPEC-ADMIN §2) · доступ: initData + ADMIN_IDS
   Все данные из API вставляются безопасно (esc/textContent).
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
  var INIT_Q = encodeURIComponent(initData);

  var API = '/famas/admin/api';
  var AVA_URL = '/famas/admin/avatar/';
  var THEME_KEY = 'famas_theme';
  var GLASS_KEY = 'famas_glass';
  var THEME_BG = { bw: '#000000', dracula: '#191A21' };
  var LIMIT = 50;          // limit по SPEC-ADMIN §2 (дефолт 50, макс 200)
  var CHIP_MAX = 8;        // регионов в карточке до «+N ещё»

  /* ── состояние ───────────────────────────────────────────────── */
  var S = {
    sort: 'new',           // 'new' (дефолт) | 'price'
    q: '',                 // поиск по @username/id (дебаунс)
    offset: 0,
    total: -1,             // всего подходящих заказов (из API)
    count: 0,              // уже показано карточек
    busy: false,
    gate: false,           // показан экран «только для администратора»
    sheetOpen: false
  };

  /* ── dom ─────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  var elApp = $('app');
  var elGate = $('gate');
  var elGateSub = $('gateSub');
  var elTrustText = $('trustText');
  var elFeed = $('feed');
  var elFeedTotal = $('feedTotal');
  var elNote = $('feedNote');
  var elNoteTitle = $('feedNoteTitle');
  var elNoteText = $('feedNoteText');
  var elRetry = $('btnRetry');
  var elMoreWrap = $('moreWrap');
  var elMore = $('btnMore');
  var elFeedEnd = $('feedEnd');
  var elSentinel = $('sentinel');
  var elSortWrap = $('sortWrap');
  var elSearch = $('searchInput');
  var elToast = $('toast');
  var elErrbar = $('errbar');
  var elErrText = $('errbarText');
  var elSheet = $('sheet');
  var elSheetBack = $('sheetBack');
  var elSeg = $('segTheme');
  var elSwGlass = $('swGlass');

  /* ── утилиты ─────────────────────────────────────────────────── */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toUnixMs(u) { u = Number(u) || 0; return u > 1e12 ? u : u * 1000; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(u) {
    if (!u) return '—';
    var d = new Date(toUnixMs(u));
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }
  function fmtDateTime(u) {
    if (!u) return '—';
    var d = new Date(toUnixMs(u));
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() +
      ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtTime(u) {
    if (!u) return '—';
    var d = new Date(toUnixMs(u));
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function plural(n, one, few, many) {
    n = Math.abs(Number(n) || 0) % 100;
    var d = n % 10;
    if (n > 10 && n < 20) return many;
    if (d > 1 && d < 5) return few;
    if (d === 1) return one;
    return many;
  }
  /* 1120 → «1 120» */
  function fmtNum(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function isoFlag(iso) {
    try {
      iso = String(iso || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso) || iso === 'XX') return '⁂';
      return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
    } catch (e) { return '⁂'; }
  }
  /* SVG-флаг /famas/flags/<iso>.svg + эмодзи-фолбэк (onerror ловится capture-фазой) */
  function flagChipHtml(iso, flag) {
    var lo = String(iso || 'xx').toLowerCase();
    if (!/^[a-z]{2}$/.test(lo)) lo = 'xx';
    var fb = flag || isoFlag(iso);
    return '<span class="flagchip">' +
      '<img src="/famas/flags/' + esc(lo) + '.svg" alt="" width="24" height="18" loading="lazy" decoding="async" draggable="false">' +
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

  /* фолбэки картинок: error не всплывает — ловим на capture-фазе.
     флаг → показать эмодзи; аватар → остаётся инициал-заглушка под фото */
  document.addEventListener('error', function (ev) {
    var img = ev.target;
    if (!img || img.tagName !== 'IMG' || !img.parentNode || !img.parentNode.classList) return;
    var p = img.parentNode;
    if (p.classList.contains('flagchip')) {
      img.hidden = true;
      var fb = p.querySelector('.flag-fb');
      if (fb) fb.hidden = false;
    } else if (p.classList.contains('ava')) {
      img.hidden = true; /* монограмма под фото уже видна */
    }
  }, true);
  /* фото загрузилось — мягко проявить поверх монограммы */
  document.addEventListener('load', function (ev) {
    var img = ev.target;
    if (img && img.tagName === 'IMG' && img.parentNode && img.parentNode.classList &&
        img.parentNode.classList.contains('ava')) {
      img.classList.add('ld');
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
  function copyText(text, okMsg) {
    function done() { toast(okMsg || 'скопировано'); haptic('light'); }
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

  /* ── темы и жидкое стекло (localStorage famas_theme / famas_glass) ── */
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

  /* ── кнопка «назад» Telegram + Escape ────────────────────────── */
  function updateBackBtn() {
    try {
      if (tg && tg.BackButton) { if (S.sheetOpen) tg.BackButton.show(); else tg.BackButton.hide(); }
    } catch (e) { /* noop */ }
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

  /* драг шита за ручку/свободную зону: дальше 84px — закрытие */
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

  /* ── сеть ────────────────────────────────────────────────────── */
  /* fetch с таймаутом; 401/403 помечаются e.forbidden → экран-заглушка */
  function fetchJson(url, ms) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) { /* noop */ } }, ms || 15000) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (t) clearTimeout(t);
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 || r.status === 403) {
          var ef = new Error((d && d.error) || 'Доступ только для администратора');
          ef.forbidden = true;
          throw ef;
        }
        if (!r.ok || !d || d.ok !== true) {
          var e2 = new Error((d && d.error) || ('HTTP ' + r.status));
          e2.status = r.status;
          throw e2;
        }
        return d;
      });
    }, function (e) {
      if (t) clearTimeout(t);
      throw e;
    });
  }

  /* ── экран «только для администратора» ───────────────────────── */
  function showGate(reason) {
    S.gate = true;
    elApp.hidden = true;
    elGate.hidden = false;
    if (elGateSub) {
      elGateSub.textContent = reason === 'noauth'
        ? 'панель открывается из бота: /admin → «📊 открыть админку»'
        : 'этот аккаунт не входит в список администраторов магазина';
    }
    try { if (tg && tg.BackButton) tg.BackButton.hide(); } catch (e) { /* noop */ }
  }

  /* ── сводка (каунт-ап плиток) ────────────────────────────────── */
  function animNum(el, to) {
    if (!el) return;
    to = Math.max(0, Math.round(Number(to) || 0));
    var from = Number(el.getAttribute('data-v')) || 0;
    el.setAttribute('data-v', String(to));
    if (reducedMotion() || from === to) {
      if (el.__raf) { cancelAnimationFrame(el.__raf); el.__raf = null; }
      el.textContent = fmtNum(to);
      return;
    }
    var t0 = null;
    var dur = 700;
    if (el.__raf) cancelAnimationFrame(el.__raf);
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min((ts - t0) / dur, 1);
      k = 1 - Math.pow(1 - k, 3); /* easeOutCubic */
      el.textContent = fmtNum(from + (to - from) * k);
      if (k < 1) el.__raf = requestAnimationFrame(step);
      else el.__raf = null;
    }
    el.__raf = requestAnimationFrame(step);
  }

  /* имя владельца — только для строки доверия (initDataUnsafe, отображение) */
  var adminName = '';
  try {
    var tu = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (tu) adminName = String(tu.first_name || tu.username || '').trim();
  } catch (e) { /* noop */ }

  function setTrust() {
    elTrustText.textContent = (adminName ? 'владелец: ' + adminName + ' · ' : '') +
      'сводка ' + fmtTime(Date.now() / 1000);
  }

  /* GET /famas/admin/api/summary — поля строго по SPEC-ADMIN §2 */
  function loadSummary(silent) {
    return fetchJson(API + '/summary?initData=' + INIT_Q)
      .then(function (d) {
        var st = d.stats || {};
        animNum($('stOrders'), st.ordersPaid);
        animNum($('stRevenue'), st.revenueStars);
        animNum($('stBuyers'), st.uniqueBuyers);
        animNum($('stToday'), st.salesToday);
        $('stTotal').textContent = fmtNum(st.ordersTotal);
        $('stConfigs').textContent = fmtNum(st.activeConfigs);
        $('stRegions').textContent = fmtNum(st.regionsCount);
        $('stFree').textContent = fmtNum(st.freeActive);
        setTrust();
        return true;
      })
      .catch(function (e) {
        if (e && e.forbidden) { showGate('forbidden'); return false; }
        elTrustText.textContent = 'нет связи';
        if (!silent) showErr('не удалось загрузить сводку — проверь сеть');
        return false;
      });
  }

  /* ── лента покупок ───────────────────────────────────────────── */
  function skeletons() {
    var h = '';
    for (var i = 0; i < 4; i++) h += '<div class="skel-card gl"></div>';
    elFeed.innerHTML = h;
  }
  function hideNote() { elNote.hidden = true; }
  function showNote(title, text, retry) {
    elNote.hidden = false;
    elNoteTitle.textContent = title;
    elNoteText.textContent = text;
    elRetry.hidden = !retry;
  }

  /* бейдж вида выдачи: kind из API ('paid' | 'free' | 'gift') */
  function badgeHtml(kind) {
    if (kind === 'gift') return '<span class="badge gift">🛠 Выдача</span>';
    if (kind === 'free') return '<span class="badge free">🎁 Промо</span>';
    return '<span class="badge paid">💰 Оплата</span>';
  }

  /* круглый аватар: фото через админ-прокси поверх инициал-заглушки;
     буква — из firstName/username, цвет детерминирован от userId */
  function avatarHtml(o) {
    var uid = String(o.userId === null || o.userId === undefined ? '' : o.userId);
    var name = String(o.firstName || o.username || '').trim();
    var letter = '⁂';
    if (name) {
      try { letter = Array.from(name)[0].toUpperCase(); }
      catch (e) { letter = name.charAt(0).toUpperCase(); }
    }
    var hue = Math.abs(Math.round(Number(o.userId) || 0)) % 8;
    var img = '';
    if (initData && /^\d+$/.test(uid)) {
      img = '<img src="' + AVA_URL + esc(uid) + '?initData=' + INIT_Q + '" alt="" loading="lazy" decoding="async" draggable="false">';
    }
    return '<span class="ava c' + hue + '"><i class="ava-fb serif">' + esc(letter) + '</i>' + img + '</span>';
  }

  /* карточка покупки — поля строго по SPEC-ADMIN §2;
     username/firstName — только через esc (XSS) */
  function orderCardHtml(o, delayMs) {
    var uid = String(o.userId === null || o.userId === undefined ? '' : o.userId);
    var hasNick = !!o.username;
    var uname = hasNick ? '@' + String(o.username) : 'без ника';
    if (!hasNick && o.firstName) uname = String(o.firstName);
    var stars = Number(o.stars) || 0;
    var sum = stars > 0
      ? '<span class="o-sum mono">+' + fmtNum(stars) + ' ⭐</span>'
      : '<span class="o-sum mono zero">бесплатно</span>';

    /* чипы регионов: SVG-флаг + имя + ×qty (у старых заказов qty нет — без ×N) */
    var regions = o.regions || [];
    var chips = '';
    for (var i = 0; i < regions.length; i++) {
      var rg = regions[i] || {};
      var qty = (rg.qty === null || rg.qty === undefined) ? 0 : Math.round(Number(rg.qty) || 0);
      chips += '<span class="rchip' + (i >= CHIP_MAX ? ' hid' : '') + '">' +
        flagChipHtml(rg.iso, rg.flag) +
        '<span class="rc-name">' + esc(rg.nameRu || rg.iso || '') + '</span>' +
        (qty > 0 ? '<b class="rc-q mono">×' + qty + '</b>' : '') +
        '</span>';
    }
    if (regions.length > CHIP_MAX) {
      chips += '<button type="button" class="rchip more" data-act="more">+' + (regions.length - CHIP_MAX) + ' ещё</button>';
    }
    var servers = Number(o.servers) || 0;
    chips += '<span class="rmeta">' + servers + ' ' + plural(servers, 'сервер', 'сервера', 'серверов') + '</span>';

    var status = o.active
      ? '<span class="ost on">● активен до ' + esc(fmtDate(o.expiresAt)) + '</span>'
      : '<span class="ost off">○ истёк</span>';
    var when = fmtDateTime(o.paidAt || o.createdAt);

    return '<article class="ocard gl in" style="animation-delay:' + delayMs + 'ms" data-page="' + esc(o.page || '') + '">' +
      '<div class="o-top">' +
        avatarHtml(o) +
        '<div class="o-user">' +
          '<div class="o-name">' +
            '<span class="o-uname' + (hasNick ? '' : ' noun') + '">' + esc(uname) + '</span>' +
            badgeHtml(o.kind) +
          '</div>' +
          '<button type="button" class="o-id" data-id="' + esc(uid) + '" aria-label="Скопировать id покупателя">id ' + esc(uid) + ' <span class="cp" aria-hidden="true">⧉</span></button>' +
        '</div>' +
        '<div class="o-right">' + sum + '</div>' +
      '</div>' +
      '<div class="o-rule"></div>' +
      '<div class="o-regions">' + chips + '</div>' +
      '<div class="o-foot">' +
        '<span class="o-meta">#' + esc(o.id) + ' · ' + esc(when) + ' · ' + status + '</span>' +
        (o.page ? '<button type="button" class="kbtn" data-act="key">Ключ ↗</button>' : '') +
      '</div>' +
    '</article>';
  }

  function setMoreBusy(b) {
    elMore.classList.toggle('busy', b);
    elMore.disabled = b;
  }

  function updateFeedMeta() {
    elFeedTotal.textContent = S.total >= 0 ? '· ' + fmtNum(S.total) : '';
    var done = S.total >= 0 && S.count >= S.total;
    elMoreWrap.hidden = done || S.count === 0;
    var showEnd = done && S.count > 0 && S.total > LIMIT;
    elFeedEnd.hidden = !showEnd;
    if (showEnd) {
      elFeedEnd.textContent = '⁂ показано всё · ' + fmtNum(S.total) + ' ' +
        plural(S.total, 'покупка', 'покупки', 'покупок');
    }
  }

  /* GET /famas/admin/api/orders — sort/q/limit/offset по SPEC-ADMIN §2 */
  function loadOrders(reset) {
    if (S.busy) return;
    S.busy = true;
    setMoreBusy(true);
    if (reset) {
      S.offset = 0;
      S.count = 0;
      S.total = -1;
      hideNote();
      elMoreWrap.hidden = true;
      elFeedEnd.hidden = true;
      skeletons();
      updateFeedMeta();
    }
    var url = API + '/orders?initData=' + INIT_Q +
      '&sort=' + encodeURIComponent(S.sort) +
      '&limit=' + LIMIT + '&offset=' + S.offset;
    if (S.q) url += '&q=' + encodeURIComponent(S.q);
    fetchJson(url)
      .then(function (d) {
        S.busy = false;
        setMoreBusy(false);
        S.total = Math.max(0, Number(d.total) || 0);
        var orders = d.orders || [];
        if (reset) elFeed.innerHTML = '';
        if (!orders.length && S.count === 0) {
          if (S.q) showNote('ничего не нашлось', 'по запросу «' + S.q + '» — попробуй другой ник или id', false);
          else showNote('покупок пока нет', 'продажи появятся здесь сразу после первой оплаты', false);
          updateFeedMeta();
          return;
        }
        var html = '';
        for (var i = 0; i < orders.length; i++) {
          html += orderCardHtml(orders[i], Math.min(i * 40, 480));
        }
        elFeed.insertAdjacentHTML('beforeend', html);
        S.offset += orders.length;
        S.count += orders.length;
        if (!orders.length) S.total = S.count; /* сервер отдал пусто — дальше не листаем */
        updateFeedMeta();
      })
      .catch(function (e) {
        S.busy = false;
        setMoreBusy(false);
        if (e && e.forbidden) { showGate('forbidden'); return; }
        if (reset) {
          elFeed.innerHTML = '';
          showNote('нет связи', 'не удалось загрузить покупки — проверь сеть и повтори', true);
        } else {
          showErr('не удалось догрузить — попробуй ещё раз');
        }
      });
  }

  function maybeMore() {
    if (S.busy || S.gate || S.total < 0 || S.count === 0 || S.count >= S.total) return;
    loadOrders(false);
  }

  function refreshAll() {
    if (S.gate) return;
    loadSummary(true).then(function (ok) { if (ok) toast('обновлено'); });
    loadOrders(true);
  }

  /* ── сортировка и поиск ──────────────────────────────────────── */
  function syncSortChips() {
    var btns = elSortWrap.querySelectorAll('.sortchip');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-sort') === S.sort;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /* ── обработчики ─────────────────────────────────────────────── */
  function bind() {
    /* чипы сортировки: 🆕 новые (дефолт) / 💎 дорогие */
    elSortWrap.addEventListener('click', function (ev) {
      var b = ev.target.closest('.sortchip');
      if (!b) return;
      var mode = b.getAttribute('data-sort') === 'price' ? 'price' : 'new';
      if (mode === S.sort) return;
      S.sort = mode;
      syncSortChips();
      haptic('light');
      loadOrders(true);
    });

    /* поиск по @username/id — дебаунс 350мс, ведущие @ срезаем */
    var searchTimer = null;
    function onQuery() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var v = elSearch.value.trim().replace(/^@+/, '');
        if (v === S.q) return;
        S.q = v;
        loadOrders(true);
      }, 350);
    }
    elSearch.addEventListener('input', onQuery);
    elSearch.addEventListener('search', onQuery);
    elSearch.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') elSearch.blur();
    });

    /* лента: копирование id / раскрытие регионов / страница ключа */
    elFeed.addEventListener('click', function (ev) {
      var idBtn = ev.target.closest('.o-id');
      if (idBtn) {
        var id = idBtn.getAttribute('data-id');
        if (id) copyText(id, 'id скопирован');
        return;
      }
      var act = ev.target.closest('[data-act]');
      if (!act) return;
      var kind = act.getAttribute('data-act');
      var card = act.closest('.ocard');
      if (!card) return;
      if (kind === 'more') {
        var hid = card.querySelectorAll('.rchip.hid');
        for (var i = 0; i < hid.length; i++) hid[i].classList.remove('hid');
        act.hidden = true;
        haptic('light');
        return;
      }
      if (kind === 'key') {
        haptic('light');
        openExternal(card.getAttribute('data-page'));
      }
    });

    /* «показать ещё» + бесконечный скролл */
    elMore.addEventListener('click', function () { haptic('light'); maybeMore(); });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { maybeMore(); break; }
        }
      }, { rootMargin: '600px 0px' });
      io.observe(elSentinel);
    }

    elRetry.addEventListener('click', function () {
      haptic('light');
      loadSummary(true);
      loadOrders(true);
    });

    /* обновить всё (спин иконки) */
    $('btnRefresh').addEventListener('click', function () {
      var b = this;
      b.classList.remove('spin');
      void b.offsetWidth; /* перезапуск оборота иконки */
      b.classList.add('spin');
      haptic('light');
      refreshAll();
    });

    /* настройки */
    $('btnSettings').addEventListener('click', openSheet);
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

    /* «назад» Telegram и Escape закрывают шит */
    try {
      if (tg && tg.BackButton && typeof tg.BackButton.onClick === 'function') {
        tg.BackButton.onClick(function () { if (S.sheetOpen) closeSheet(); });
      }
    } catch (e) { /* noop */ }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && S.sheetOpen) closeSheet();
    });
  }

  /* ── старт ───────────────────────────────────────────────────── */
  function init() {
    applyChrome();
    syncPrefControls();
    loadPrefsFromCloud();
    bind();
    /* нет initData (открыто вне Telegram) → «⛔ доступ только для администратора» */
    if (!initData) { showGate('noauth'); return; }
    loadSummary(false);
    loadOrders(true);
    /* живая сводка: тихий рефреш раз в 90 сек + при возврате в апп */
    setInterval(function () {
      if (!S.gate && document.visibilityState === 'visible') loadSummary(true);
    }, 90000);
    document.addEventListener('visibilitychange', function () {
      if (!S.gate && document.visibilityState === 'visible') loadSummary(true);
    });
  }

  init();
})();
