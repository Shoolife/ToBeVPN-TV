(function () {
  'use strict';

  var API = 'http://127.0.0.1:18765';
  var screenIds = ['loadingScreen', 'errorScreen', 'onboardingScreen', 'installScreen', 'pairScreen', 'homeScreen', 'serversScreen', 'statsScreen', 'speedScreen', 'speedHistoryScreen', 'subscriptionScreen', 'settingsScreen', 'devicesScreen', 'promocodesScreen', 'supportScreen', 'referralsScreen', 'appFilterScreen'];
  var selectedIndex = null;
  var automaticSelection = true;
  var currentStatus = null;
  var currentScreen = 'loading';
  var busy = false;
  var pings = [];
  var pingsMeasured = false;
  var pingInFlight = false;
  var purchasePlans = null;
  var plansError = '';
  var selectedTariffKey = null;
  var selectedPlanKey = 'month';
  var pingTimeoutSeconds = 7;
  var FLAG_SET = {};
  var EMOJI_SET = {};
  var countryCodes = {
    'нидерланды':'NL','netherlands':'NL','швеция':'SE','sweden':'SE','финляндия':'FI','finland':'FI',
    'германия':'DE','germany':'DE','франция':'FR','france':'FR','великобритания':'GB','англия':'GB','uk':'GB',
    'сша':'US','usa':'US','польша':'PL','poland':'PL','литва':'LT','lithuania':'LT','латвия':'LV','latvia':'LV',
    'эстония':'EE','estonia':'EE','испания':'ES','spain':'ES','италия':'IT','italy':'IT','турция':'TR','turkey':'TR',
    'россия':'RU','russia':'RU','ru':'RU','япония':'JP','japan':'JP','сингапур':'SG','singapore':'SG',
    'украина':'UA','ukraine':'UA','казахстан':'KZ','kazakhstan':'KZ','беларусь':'BY','belarus':'BY'
  };
  var countryNames = { NL:'Нидерланды', DE:'Германия', US:'США', GB:'Великобритания', FI:'Финляндия', SE:'Швеция', FR:'Франция', JP:'Япония', SG:'Сингапур', CA:'Канада', AU:'Австралия', TR:'Турция', RU:'Россия' };

  (function () {
    var i; var list = String(window.TOBE_FLAGS || '').split(' ');
    for (i = 0; i < list.length; i += 1) { if (list[i]) { FLAG_SET[list[i]] = true; } }
    list = String(window.TOBE_EMOJI || '').split(' ');
    for (i = 0; i < list.length; i += 1) { if (list[i]) { EMOJI_SET[list[i]] = true; } }
    try { pingTimeoutSeconds = Math.max(5, Math.min(15, Number(window.localStorage.getItem('pingTimeout')) || 7)); } catch (ignore) {}
  }());


  /* Strings: the Android TV resources (strings.js, generated), Android format
     specifiers, Russian/English plural rules, Java date names. */
  var LANG = (function () {
    var saved = null; try { saved = window.localStorage.getItem('language'); } catch (ignore) {}
    if (saved === 'ru' || saved === 'en') { return saved; }
    return /^ru/i.test(navigator.language || '') ? 'ru' : 'en';
  }());
  var STR = (window.TOBE_STRINGS || {})[LANG] || {};
  function fmt(pattern, args) {
    var auto = 0;
    return String(pattern).replace(/%(?:(\d+)\$)?(\.\d+)?([sdf%])/g, function (all, pos, prec, type) {
      if (type === '%') { return '%'; }
      var value = args[pos ? Number(pos) - 1 : auto++];
      if (type === 'd') { return String(Math.round(Number(value) || 0)); }
      if (type === 'f') { return decimal(Number(value) || 0, prec ? Number(prec.slice(1)) : 6); }
      return value == null ? '' : String(value);
    });
  }
  function t(key) { var args = Array.prototype.slice.call(arguments, 1); var s = STR[key]; if (s == null || typeof s !== 'string') { return key; } return args.length ? fmt(s, args) : s; }
  function plural(key, n) {
    var forms = STR[key] || {}; var cat;
    if (LANG === 'ru') { var m10 = n % 10; var m100 = n % 100; cat = m10 === 1 && m100 !== 11 ? 'one' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'few' : 'many'); }
    else { cat = n === 1 ? 'one' : 'other'; }
    return fmt(forms[cat] || forms.other || '', [n]);
  }
  var DATE_NAMES = {
    ru: { weekShort: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], weekLong: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'], monthShort: ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'] },
    en: { weekShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], weekLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] }
  }[LANG];
  function applyStrings(root) {
    var nodes = (root || document).querySelectorAll('[data-i18n]'); var i;
    for (i = 0; i < nodes.length; i += 1) { nodes[i].textContent = t(nodes[i].getAttribute('data-i18n')); }
    document.documentElement.setAttribute('lang', LANG);
  }

  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var el = byId(id); var v = value == null ? '' : String(value); if (el && el.textContent !== v) { el.textContent = v; } }
  function html(id, value) { var el = byId(id); if (el && el.getAttribute('data-html') !== value) { el.innerHTML = value; el.setAttribute('data-html', value); } }
  function addClass(el, name) { if (el && (' ' + el.className + ' ').indexOf(' ' + name + ' ') < 0) { el.className += ' ' + name; } }
  function removeClass(el, name) { if (el) { el.className = el.className.replace(new RegExp('(^|\\s)' + name + '(?=\\s|$)', 'g'), ' ').replace(/^\s+|\s+$/g, ''); } }
  function toggleClass(el, name, yes) { if (yes) { addClass(el, name); } else { removeClass(el, name); } }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function decimal(value, digits) { var s = value.toFixed(digits); return LANG === 'ru' ? s.replace('.', ',') : s; }

  function request(method, path, data, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, API + path, true); xhr.timeout = 30000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () {
      var result;
      if (xhr.readyState !== 4) { return; }
      try { result = JSON.parse(xhr.responseText || '{}'); } catch (ignore) { result = {}; }
      if (xhr.status >= 200 && xhr.status < 300) { done(null, result); }
      else { done(new Error(result.error || t('error_generic'))); }
    };
    xhr.onerror = function () { done(new Error(t('error_generic'))); };
    xhr.ontimeout = function () { done(new Error(t('error_generic'))); };
    xhr.send(data ? JSON.stringify(data) : '{}');
  }

  /* Code points, emoji and flags. The TV has no colour emoji font, so emoji
     are drawn from Noto Color Emoji bitmaps, exactly like the Android build. */
  function codePoints(value) {
    var out = []; var i; var c; var d; value = String(value || '');
    for (i = 0; i < value.length; i += 1) {
      c = value.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < value.length) {
        d = value.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { out.push((c - 0xD800) * 0x400 + d - 0xDC00 + 0x10000); i += 1; continue; }
      }
      out.push(c);
    }
    return out;
  }
  function fromCodePoint(cp) {
    if (cp < 0x10000) { return String.fromCharCode(cp); }
    cp -= 0x10000; return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }
  function isRegional(cp) { return cp >= 0x1F1E6 && cp <= 0x1F1FF; }
  function isDecorative(cp) {
    return cp > 0xFFFF || (cp >= 0x2100 && cp <= 0x2BFF) || (cp >= 0x20A0 && cp <= 0x20CF) || (cp >= 0x2000 && cp <= 0x200F) ||
      (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || cp === 0x20E3 || '+<=>|~^`$'.indexOf(String.fromCharCode(cp)) >= 0;
  }
  function isLetterOrDigit(ch) { return /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ԯ]/.test(ch); }
  function flagUrl(code) { return FLAG_SET[code] ? 'flags/' + code + '.png' : 'flags/globe.png'; }
  function emojiHtml(value) {
    var cps = codePoints(value); var out = ''; var i; var cp; var hex;
    for (i = 0; i < cps.length; i += 1) {
      cp = cps[i];
      if (isRegional(cp) && i + 1 < cps.length && isRegional(cps[i + 1])) {
        hex = String.fromCharCode(cp - 0x1F1E6 + 65) + String.fromCharCode(cps[i + 1] - 0x1F1E6 + 65);
        out += '<span class="emoji" style="background-image:url(\'' + flagUrl(hex) + '\')"></span>'; i += 1; continue;
      }
      if (cp === 0xFE0F || cp === 0x200D || (cp >= 0x1F3FB && cp <= 0x1F3FF)) { continue; }
      hex = cp.toString(16);
      if (EMOJI_SET[hex]) { out += '<span class="emoji" style="background-image:url(\'emoji/' + hex + '.png\')"></span>'; continue; }
      out += escapeHtml(fromCodePoint(cp));
    }
    return out;
  }

  /* ServerDisplayFormatter.kt */
  function leadingPrefix(value) {
    var cps = codePoints(value); var i = 0; var flag = ''; var consumed = 0; var ch;
    while (i < cps.length) {
      ch = fromCodePoint(cps[i]);
      if (isLetterOrDigit(ch)) { break; }
      if (isRegional(cps[i]) && i + 1 < cps.length && isRegional(cps[i + 1])) {
        if (!flag) { flag = String.fromCharCode(cps[i] - 0x1F1E6 + 65) + String.fromCharCode(cps[i + 1] - 0x1F1E6 + 65); }
        consumed += 4; i += 2; continue;
      }
      if (!/\s/.test(ch) && !isDecorative(cps[i])) { break; }
      consumed += ch.length; i += 1;
    }
    return { end: consumed, flag: flag };
  }
  function removeFlags(value) {
    var cps = codePoints(value); var out = ''; var i;
    for (i = 0; i < cps.length; i += 1) {
      if (isRegional(cps[i]) && i + 1 < cps.length && isRegional(cps[i + 1])) { i += 1; continue; }
      out += fromCodePoint(cps[i]);
    }
    return out;
  }
  function trimDecorative(value) { return value.replace(/^\s+|\s+$/g, '').replace(/^[-|/\\:]+|[-|/\\:]+$/g, '').replace(/^\s+|\s+$/g, ''); }
  function serverPresentation(server) {
    var raw = String((server && server.name) || ''); var trimmed = raw.replace(/^\s+|\s+$/g, '');
    var tokens = trimmed.toLowerCase().split(/[^a-zа-яёA-ZА-ЯЁÀ-ɏ]+/); var code = ''; var i;
    var lead = leadingPrefix(trimmed.replace(/^\s+/, ''));
    for (i = 0; i < tokens.length; i += 1) { if (countryCodes[tokens[i]]) { code = countryCodes[tokens[i]]; break; } }
    if (!code) { code = lead.flag; }
    var name = trimDecorative(removeFlags(trimmed.substring(lead.end)));
    return { code: code, name: name || trimmed, country: code ? (STR['country_' + code] ? t('country_' + code) : code) : '' };
  }
  function setStyleAttr(el, value) { if (el.getAttribute('style') !== value) { el.setAttribute('style', value); } }
  function flagStyle(code) { return 'background-image:url(\'' + flagUrl(code) + '\')'; }

  function formatBytesLatin(value) {
    var n = Number(value) || 0;
    if (n < 1024) { return Math.round(n) + ' B'; }
    if (n < 1048576) { return decimal(n / 1024, 1) + ' KB'; }
    if (n < 1073741824) { return decimal(n / 1048576, 1) + ' MB'; }
    return decimal(n / 1073741824, 2) + ' GB';
  }
  function formatBytesStats(value) {
    var n = Number(value) || 0;
    if (n < 1024) { return Math.round(n) + ' B'; }
    var ru = LANG === 'ru';
    if (n < 1048576) { return decimal(n / 1024, 1) + (ru ? ' КБ' : ' KB'); }
    if (n < 1073741824) { return decimal(n / 1048576, 1) + (ru ? ' МБ' : ' MB'); }
    return decimal(n / 1073741824, 2) + (ru ? ' ГБ' : ' GB');
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function formatClock(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0)); var h = Math.floor(total / 3600); var m = Math.floor((total % 3600) / 60); var s = total % 60;
    return h ? h + ':' + two(m) + ':' + two(s) : two(m) + ':' + two(s);
  }
  function formatStatsTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0)); var h = Math.floor(total / 3600); var m = Math.floor((total % 3600) / 60);
    var ru = LANG === 'ru';
    if (h > 0) { return h + (ru ? 'ч ' : 'h ') + m + (ru ? 'м' : 'm'); }
    if (m > 0) { return m + (ru ? 'м' : 'm'); }
    return total + (ru ? 'с' : 's');
  }
  function parseDate(value) {
    if (!value) { return null; } var d = new Date(value);
    if (isNaN(d.getTime()) && /^\d+$/.test(String(value))) { d = new Date(Number(value) * (String(value).length > 11 ? 1 : 1000)); }
    return isNaN(d.getTime()) ? null : d;
  }
  function resetDate(a) {
    var ts = Number(a.traffic_reset_at) || 0; if (!ts) { return null; }
    var d = new Date(ts * (String(ts).length > 11 ? 1 : 1000));
    return d.getTime() > Date.now() ? d : null;
  }
  /* TrafficResetText.kt: today "в HH:mm", tomorrow "завтра", otherwise the date with the year. */
  function resetWhen(d) {
    var today = new Date(); today.setHours(0, 0, 0, 0); var day = new Date(d.getTime()); day.setHours(0, 0, 0, 0);
    var days = Math.round((day.getTime() - today.getTime()) / 86400000);
    if (days <= 0) { return t('traffic_reset_when_today', two(d.getHours()) + ':' + two(d.getMinutes())); }
    if (days === 1) { return t('traffic_reset_when_tomorrow'); }
    return formatDate(d);
  }
  function formatDate(d) { return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); }
  function account() { return (currentStatus && currentStatus.account) || {}; }
  function isAdmin() { return account().is_admin === true; }
  function selectedServer() { return currentStatus && currentStatus.servers ? currentStatus.servers[selectedIndex] : null; }
  function pingColor(ping) { return ping < 100 ? '#4caf50' : (ping < 200 ? '#ff9800' : '#f44336'); }


  /* Compose easing: FastOutSlowInEasing = cubic-bezier(0.4, 0, 0.2, 1). */
  function cubicBezier(x1, y1, x2, y2) {
    function at(a, b, t) { return 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t; }
    return function (x) {
      if (x <= 0) { return 0; } if (x >= 1) { return 1; }
      var lo = 0; var hi = 1; var t = x; var i;
      for (i = 0; i < 30; i += 1) { t = (lo + hi) / 2; if (at(x1, x2, t) < x) { lo = t; } else { hi = t; } }
      return at(y1, y2, t);
    };
  }
  var fastOutSlowIn = cubicBezier(0.4, 0, 0.2, 1);
  function progressOf(elapsed, delay, duration) { return fastOutSlowIn(Math.max(0, Math.min(1, (elapsed - delay) / duration))); }
  function now() { return window.performance && performance.now ? performance.now() : new Date().getTime(); }
  var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame || function (f) { return setTimeout(function () { f(now()); }, 16); };
  var splashFinished = false;
  var dataReady = false;
  function revealApp() { if (splashFinished && dataReady) { addClass(byId('appRoot'), 'ready'); } }


  /* Material3 1.4.0 CircularProgressIndicator (indeterminate): 1080 deg linear
     global rotation per 6 s, +90 deg steps at 0/1500/3000/4500 ms (300 ms each,
     linear between keyframes), sweep 0.1..0.87 linear over 3 s then back with
     EasingStandard; transparent track, round caps. */
  var standardEasing = cubicBezier(0.2, 0, 0, 1);
  function spinnerHtml(sizePx, strokePx, color) {
    return '<svg class="m3-spinner" width="' + sizePx + '" height="' + sizePx + '" viewBox="0 0 ' + sizePx + ' ' + sizePx + '" data-size="' + sizePx + '" data-stroke="' + strokePx + '"><path fill="none" stroke="' + color + '" stroke-width="' + strokePx + '" stroke-linecap="round"/></svg>';
  }
  var spinnerLoop = false;
  function animateSpinners() {
    if (spinnerLoop) { return; } spinnerLoop = true;
    (function frame() {
      var screen = byId(currentScreen + 'Screen'); var list = [];
      var all = document.querySelectorAll('.m3-spinner'); var i;
      for (i = 0; i < all.length; i += 1) { if (all[i].offsetWidth) { list.push(all[i]); } }
      if (!list.length && (!screen || !screen.querySelector('.m3-spinner'))) { spinnerLoop = false; return; }
      var t = now() % 6000; var add = 0; var step = Math.floor(t / 1500); var inStep = t - step * 1500;
      add = step * 90 + (inStep < 300 ? 90 * inStep / 300 : 90);
      var progress = t < 3000 ? 0.1 + 0.77 * (t / 3000) : 0.87 - 0.77 * standardEasing((t - 3000) / 3000);
      var rotation = 1080 * t / 6000 + add; var sweep = progress * 360;
      for (i = 0; i < list.length; i += 1) {
        var size = Number(list[i].getAttribute('data-size')); var stroke = Number(list[i].getAttribute('data-stroke'));
        var r = (size - stroke) / 2; var c = size / 2;
        var a0 = rotation * Math.PI / 180; var a1 = (rotation + sweep) * Math.PI / 180;
        var d = 'M' + (c + r * Math.cos(a0)).toFixed(2) + ' ' + (c + r * Math.sin(a0)).toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + (c + r * Math.cos(a1)).toFixed(2) + ' ' + (c + r * Math.sin(a1)).toFixed(2);
        list[i].firstChild.setAttribute('d', d);
      }
      raf(frame);
    }());
  }

  /* SplashScreen.kt choreography. */
  function runSplash() {
    var start = now(); var shield = byId('splashShield'); var main = byId('splashMain'); var trail = byId('splashTrail');
    var textEl = byId('splashText'); var glow = byId('splashGlow'); var splash = byId('splash');
    function frame() {
      var t = now() - start; var scale = 0.85 + 0.15 * progressOf(t, 0, 850); var shift = 1 - progressOf(t, 450, 750);
      var cycle = (t % 2400) / 1200; var pulse = 0.3 + 0.5 * (cycle <= 1 ? cycle : 2 - cycle); var text = progressOf(t, 900, 700);
      shield.setAttribute('transform', 'translate(1200 1200) scale(' + scale + ') translate(-1200 -1200)');
      shield.setAttribute('opacity', progressOf(t, 0, 600));
      trail.setAttribute('opacity', progressOf(t, 450, 600)); trail.setAttribute('transform', 'translate(' + (-576 * shift) + ' 0)');
      main.setAttribute('opacity', progressOf(t, 450, 600)); main.setAttribute('transform', 'translate(' + (-960 * shift) + ' 0)');
      textEl.style.opacity = text; textEl.style.webkitTransform = 'translateY(' + (40 * (1 - text)) + 'px)'; textEl.style.transform = textEl.style.webkitTransform;
      glow.style.opacity = pulse;
      splash.style.opacity = 1 - progressOf(t, 2400, 450);
      if (t < 2850) { raf(frame); } else { splash.parentNode.removeChild(splash); splashFinished = true; revealApp(); }
    }
    raf(frame);
  }

  /* BrandLoader.kt: 900 ms linear spin, 1200 ms 0.94..1.04 pulse, 200 ms fade-in. */
  function runLoader() {
    var start = now(); var arc = byId('loaderArc'); var shield = byId('loaderShield'); var box = arc.ownerSVGElement.parentNode;
    function frame() {
      if (currentScreen !== 'loading') { return; }
      var t = now() - start; var cycle = (t % 2400) / 1200; var p = fastOutSlowIn(cycle <= 1 ? cycle : 2 - cycle); var s = 0.94 + 0.1 * p;
      arc.setAttribute('transform', 'rotate(' + ((t % 900) / 900 * 360) + ' 42 42)');
      shield.style.webkitTransform = 'scale(' + s + ')'; shield.style.transform = shield.style.webkitTransform;
      box.style.opacity = Math.min(1, t / 200);
      raf(frame);
    }
    raf(frame);
  }

  function focusFirst(id) {
    setTimeout(function () { var s = byId(id); var f = s ? s.querySelector('.focusable:not([disabled])') : null; if (f) { f.focus(); } }, 90);
  }
  var appScreens = { onboarding: 0, install: 1, pair: 2, home: 0, servers: 1, stats: 1, speed: 1, speedHistory: 2, subscription: 1, settings: 1, devices: 2, promocodes: 2, support: 2, referrals: 2, appFilter: 2 };
  var parentScreen = { speedHistory: 'speed', devices: 'settings', promocodes: 'settings', support: 'settings', referrals: 'settings', appFilter: 'settings' };
  var returnFocus = {};
  var navTimer = null;
  function showScreen(name, keepFocus) {
    var id = name + 'Screen'; var previous = currentScreen; var prevEl = byId(previous + 'Screen'); var nextEl = byId(id);
    var animate = previous !== name && appScreens[previous] !== undefined && appScreens[name] !== undefined && prevEl && byId('appRoot').className.indexOf('ready') >= 0;
    for (var i = 0; i < screenIds.length; i += 1) { if (screenIds[i] !== id && !(animate && screenIds[i] === previous + 'Screen')) { toggleClass(byId(screenIds[i]), 'hidden', true); } }
    removeClass(nextEl, 'hidden');
    currentScreen = name;
    if (animate) {
      // Forward slides toward Start, Back (to Home) toward End.
      // Signing in navigates forward to Home, as the Android NavHost does.
      var dir = authScreens[previous] && !authScreens[name] ? 1 : (appScreens[name] < appScreens[previous] ? -1 : 1);
      if (navTimer) { clearTimeout(navTimer); }
      setTransform(nextEl, dir * 100, 0); removeClass(nextEl, 'nav-anim'); removeClass(prevEl, 'nav-anim');
      raf(function () { raf(function () {
        addClass(nextEl, 'nav-anim'); addClass(prevEl, 'nav-anim');
        setTransform(nextEl, 0, 1); setTransform(prevEl, -dir * 100, 0);
      navTimer = setTimeout(function () {
        navTimer = null; addClass(prevEl, 'hidden'); removeClass(prevEl, 'nav-anim'); removeClass(nextEl, 'nav-anim');
        clearTransform(prevEl); clearTransform(nextEl);
      }, 330);
      }); });
    }
    if (name === 'loading') { runLoader(); }
    animateSpinners();
    if (!keepFocus && name !== 'home') { focusFirst(id); }
  }
  /* Heavy re-renders wait for the running slide: it only stays smooth while nothing repaints. */
  function afterNav(fn) { if (navTimer) { setTimeout(function () { afterNav(fn); }, 60); } else { fn(); } }
  function setTransform(el, percent, opacity) { el.style.webkitTransform = 'translateX(' + percent + '%)'; el.style.transform = el.style.webkitTransform; el.style.opacity = opacity; }
  function clearTransform(el) { el.style.webkitTransform = ''; el.style.transform = ''; el.style.opacity = ''; }
  function fail(error) { busy = false; text('errorText', error.message || String(error)); showScreen('error'); }

  /* MainScreen.kt */
  function renderAccount(status) {
    var a = status.account || {}; var plan = a.plan_name || 'XXX'; var expiry = parseDate(a.expires_at);
    html('homePlan', emojiHtml(plan)); text('homePlanSubtitle', expiry ? t('plan_until', formatDate(expiry)) : '');
    var limit = Number(a.usage_total) > 0 ? Number(a.usage_total) : (a.unlimited ? 0 : Number(a.traffic_limit) || 0); var used = Number(a.usage_used) || 0;
    var usage = byId('homeUsage');
    toggleClass(usage, 'hidden', !(limit > 0));
    if (limit > 0) {
      var progress = Math.max(0, Math.min(1, used / limit)); var label = byId('homeUsageText'); var size = 28;
      var usageText = formatBytesLatin(used) + ' / ' + formatBytesLatin(limit);
      if (label.textContent !== usageText || !label.offsetWidth) {
        label.textContent = usageText; label.style.fontSize = size + 'px';
        if (label.offsetWidth > 332) { size = Math.max(22, Math.floor(28 * 332 / label.offsetWidth)); label.style.fontSize = size + 'px'; }
        byId('homeUsageBar').style.width = label.offsetWidth ? label.offsetWidth + 'px' : '100%';
      }
      var fill = byId('homeUsageFill'); fill.style.width = (progress * 100) + '%'; fill.style.background = progress < 0.7 ? '#4caf50' : (progress < 0.9 ? '#ff9800' : '#f44336');
      var reset = resetDate(a); var exhausted = used >= limit; var whenText = reset ? resetWhen(reset) : '';
      var note = exhausted ? (reset ? t('traffic_exhausted_reset', whenText) : t('traffic_exhausted')) : (reset ? t('traffic_reset_short', whenText) : '');
      var noteEl = byId('homeUsageNote'); noteEl.textContent = note; toggleClass(noteEl, 'hidden', !note); toggleClass(noteEl, 'exhausted', exhausted);
    }
    text('settingsTelegram', a.telegram_id || '—');
    html('settingsPlan', emojiHtml(plan));
    toggleClass(byId('settingsExpiresRow'), 'hidden', !expiry);
    text('settingsExpires', expiry ? formatDate(expiry) : '—');
    renderUpdateRow();
    text('settingsXray', status.versions && status.versions.xray ? 'Xray-core v' + status.versions.xray : 'Xray-core');
  }

  function renderHome(status) {
    var connected = !!status.connected; var power = byId('powerButton'); var state = byId('connectionState'); var server; var ping;
    currentStatus = status;
    if (status.connected_index !== null && status.connected_index !== undefined) { selectedIndex = Number(status.connected_index); }
    else { resolveSelection(status.servers); }
    server = selectedServer();
    toggleClass(power, 'connected', connected); removeClass(power, 'connecting');
    removeClass(state, 'connected'); removeClass(state, 'connecting'); removeClass(state, 'error');
    text('connectionState', connected ? t('state_connected') : (status.error ? status.error : t('state_disconnected')));
    if (connected) { addClass(state, 'connected'); } else if (status.error) { addClass(state, 'error'); }
    if (server) {
      var p = serverPresentation(server);
      setStyleAttr(byId('homeFlag'), flagStyle(p.code)); text('homeServerName', p.name);
      text('homeServerCountry', automaticSelection ? t('server_auto_selected') : p.country);
    } else {
      setStyleAttr(byId('homeFlag'), flagStyle('')); text('homeServerName', t('server_select')); text('homeServerCountry', '');
    }
    ping = server ? pings[selectedIndex] : 0;
    toggleClass(byId('homePing'), 'hidden', !(ping > 0));
    if (ping > 0) { var strong = byId('homePing').getElementsByTagName('strong')[0]; strong.textContent = ping; strong.style.color = pingColor(ping); }
    text('sessionTraffic', formatBytesLatin(status.session_bytes)); text('sessionTime', formatClock(status.session_seconds));
    renderStats(status); renderAccount(status);
    toggleClass(byId('routeBadge'), 'vpn', connected); text('routeBadge', connected ? t('speed_via_vpn') : t('speed_direct'));
  }

  /* ServerListViewModel.kt: the list shows TCP pings until a Refresh runs the
     full profile check; from then on it shows the verified delays. 0 is "not
     measured yet" (a spinner), -1 unavailable. */
  var profile = { enabled: false, measured: false, running: false, completed: 0, total: 0, pings: [], timer: null, hideTimer: null };
  // The list's own TCP pings (ServerListViewModel._pings), empty on every visit.
  var listPings = [];
  var serversError = null;
  var serversLoading = false; var loadForced = false; var pendingForced = false; var loadGeneration = 0; var tcpInFlight = false;
  function displayedPing(index) {
    if (profile.enabled) { var v = profile.pings[index]; return v === null || v === undefined ? 0 : v; }
    return listPings[index] || 0;
  }
  /* ServerSelection.kt sortVerifiedServersForDisplay: only once the profile
     check has measured: verified by delay, unmeasured next, unavailable last. */
  function displayOrder() {
    var servers = currentStatus && currentStatus.servers ? currentStatus.servers : []; var order = []; var i;
    for (i = 0; i < servers.length; i += 1) { order.push(i); }
    if (!profile.measured) { return order; }
    function rank(index) { var p = displayedPing(index); return p < 0 ? 2 : (p === 0 ? 1 : 0); }
    order.sort(function (a, b) {
      var ra = rank(a); var rb = rank(b); var pa = displayedPing(a) > 0 ? displayedPing(a) : 1e12; var pb = displayedPing(b) > 0 ? displayedPing(b) : 1e12;
      return ra - rb || pa - pb || a - b;
    });
    return order;
  }
  /* ServerSelectionPreferences (prefsDataStore): automatic or manual plus the
     server's name key (serverSelectionKey), kept across launches. An automatic
     choice sticks until its server leaves the list; a launch, a server check
     and the Automatic chip choose again, by quality score in the service. */
  var selectedKey = null;
  try { var savedSelection = JSON.parse(window.localStorage.getItem('serverSelection') || 'null'); if (savedSelection) { automaticSelection = savedSelection.automatic !== false; selectedKey = savedSelection.key || null; } } catch (ignore) {}
  function selectionKey(server) { return String((server && server.name) || '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ').toLowerCase(); }
  function storeSelection(automatic, index) {
    automaticSelection = automatic; selectedIndex = index;
    var server = currentStatus && currentStatus.servers ? currentStatus.servers[index] : null;
    selectedKey = server ? selectionKey(server) : null;
    try { window.localStorage.setItem('serverSelection', JSON.stringify({ automatic: automatic, key: selectedKey })); } catch (ignore) {}
  }
  var autoSelecting = false;
  function resolveSelection(servers) {
    var found = null; var i;
    if (selectedKey) { for (i = 0; i < servers.length; i += 1) { if (selectionKey(servers[i]) === selectedKey) { found = i; break; } } }
    if (found !== null) { selectedIndex = found; return; }
    if (!automaticSelection) { selectedIndex = null; return; }
    // allowFallback for automatic while the new choice is being made.
    selectedIndex = servers.length ? 0 : null;
    ensureAutomaticServerSelected(false);
  }
  // ensureAutomaticServerSelected(servers, forceSelection): selectBestServer.
  function ensureAutomaticServerSelected(force, done) {
    if (!automaticSelection || autoSelecting) { if (done) { done(); } return; }
    autoSelecting = true;
    request('GET', '/api/best?mode=tcp&timeout=' + pingTimeoutSeconds, null, function (error, result) {
      autoSelecting = false;
      if (!error && result && result.pings) { mergePings(result.pings); }
      if (!error && result && result.index !== null && result.index !== undefined && automaticSelection && (force || !selectedKey || selectedIndex === null)) { storeSelection(true, result.index); }
      if (currentStatus) { renderHome(currentStatus); }
      if (done) { done(); }
    });
  }
  // persistBestVerifiedServer: the best profile the last check confirmed.
  function persistBestVerifiedServer(done) {
    request('GET', '/api/best?mode=verified', null, function (error, result) {
      var ok = !error && result && result.index !== null && result.index !== undefined;
      if (ok) { storeSelection(true, result.index); if (currentStatus) { renderHome(currentStatus); } renderServers(currentScreen === 'servers'); }
      if (done) { done(ok); }
    });
  }
  // ServerListViewModel.selectAutomaticServer: a full check first unless the
  // last one measured every server; Back to home only when one was confirmed.
  function selectAutomaticServer() {
    var servers = currentStatus && currentStatus.servers ? currentStatus.servers : []; var complete = profile.measured; var i;
    for (i = 0; i < servers.length && complete; i += 1) { if (!profile.pings[i]) { complete = false; } }
    function pick() { persistBestVerifiedServer(function (ok) { if (ok) { showScreen('home'); setTimeout(function () { byId('powerButton').focus(); }, 100); } }); }
    if (complete) { pick(); } else { runProfileCheck(true, false, pick); }
  }
  function mergePings(next) { for (var i = 0; i < next.length; i += 1) { if (next[i] !== 0 || pings[i] === undefined) { pings[i] = next[i]; } } pingsMeasured = true; }
  // measurePings(servers, force): TCP connect times for every endpoint.
  function measurePings(force, done, onlyIndex) {
    if (tcpInFlight || !currentStatus || !currentStatus.servers || !currentStatus.servers.length) { if (done) { done(); } return; }
    tcpInFlight = true;
    // Each server's value as soon as it answers; a silent one keeps its
    // spinner until the timeout.
    if (onlyIndex === undefined) {
      (function live() {
        setTimeout(function () {
          if (!tcpInFlight) { return; }
          request('GET', '/api/ping/live', null, function (e, r) {
            if (tcpInFlight && !e && r && r.pings) { for (var k = 0; k < r.pings.length; k += 1) { if (r.pings[k] !== 0) { listPings[k] = r.pings[k]; } } updateServerChips(); }
            live();
          });
        }, 300);
      }());
    }
    request('GET', '/api/ping?timeout=' + pingTimeoutSeconds + (force ? '&force=1' : '') + (onlyIndex !== undefined ? '&index=' + onlyIndex : ''), null, function (error, result) {
      tcpInFlight = false;
      if (!error && result && result.pings) { mergePings(result.pings); if (onlyIndex === undefined) { listPings = result.pings.slice(); } }
      if (currentStatus) { renderHome(currentStatus); }
      updateServerChips();
      if (done) { done(); }
    });
  }
  function setRefreshSpinning() { toggleClass(byId('refreshServersButton'), 'rotating', serversLoading || busy); }
  /* refreshServers(force): a press while the open-screen load runs queues a
     check right after it; a press during the check needs no second one. */
  function refreshServers(force) {
    if (force === undefined || (force && force.type)) { force = true; }
    if (serversLoading) {
      if (!force || loadForced) { return; }
      // A press during the open-screen load starts the check now instead of
      // queuing it (Android queues; there the load is short): the check pings
      // every server itself, and a silent server held this load for 7 s.
      loadGeneration += 1;
    }
    serversLoading = true; loadForced = force; setRefreshSpinning();
    var generation = loadGeneration;
    // refreshServers(): the subscription sync (4 s at most) and the server
    // list first, then the TCP pings; the cards spin until those arrive.
    sync();
    // syncSubscription under a 4 s limit (cut at it), then the server list.
    function sync() {
    if (generation !== loadGeneration) { return; }
    serversError = null;
    request('POST', '/api/sync', {}, function () {
    if (generation !== loadGeneration) { return; }
    request('POST', '/api/profile', {}, function (profileError) {
      if (generation !== loadGeneration) { return; }
      if (profileError) { serversError = profileError.message; }
      request('GET', '/api/status', null, function (e, status) {
        if (!e && status) { currentStatus = status; renderHome(status); }
        renderServers(true);
        if (profileError) { return finish(); }
        if (force) { runProfileCheck(true, false, function () { if (automaticSelection) { persistBestVerifiedServer(function () { finish(); }); } else { finish(); } }); }
        else { measurePings(true, finish); }
      });
    });
    });
    }
    function finish() {
      if (generation !== loadGeneration) { return; }
      serversLoading = false; loadForced = false; setRefreshSpinning();
      checkMissingProfiles();
    }
  }
  // One check at a time with one poll: a second caller (the Automatic chip
  // during a Refresh check) waits for the same result instead of restarting it.
  function runProfileCheck(force, missing, done) {
    profile.waiters = profile.waiters || [];
    if (done) { profile.waiters.push(done); }
    if (profile.polling) { if (!missing) { profile.withCard = true; showProbeCard(true); } return; }
    profile.polling = true; profile.withCard = !missing;
    clearTimeout(profile.hideTimer);
    request('POST', '/api/probe/start', { timeout: pingTimeoutSeconds, force: force, missing: missing }, function (error, state) {
      if (error || !state) { return settle(false); }
      profile.enabled = true; if (!missing) { profile.measured = false; }
      applyProfileState(state, profile.withCard);
      (function poll() {
        if (!profile.running) { return settle(true); }
        profile.timer = setTimeout(function () { request('GET', '/api/probe', null, function (e, next) { if (!e && next) { applyProfileState(next, profile.withCard); } poll(); }); }, 300);
      }());
    });
    function settle(measured) {
      profile.polling = false;
      if (measured) {
        profile.measured = true;
        afterNav(function () { renderServers(currentScreen === 'servers'); });
        // PROBE_PROGRESS_COMPLETION_HOLD_MS: the full bar stays 800 ms.
        if (profile.withCard) { profile.hideTimer = setTimeout(function () { showProbeCard(false); }, 800); }
      }
      var waiters = profile.waiters; profile.waiters = [];
      waiters.forEach(function (fn) { fn(); });
    }
  }
  function applyProfileState(state, withCard) {
    profile.running = state.running; profile.completed = state.completed; profile.total = state.total; profile.pings = state.pings || [];
    if (withCard) { showProbeCard(true); updateProbeCard(); }
    updateServerChips();
  }
  // checkMissingProfiles: profiles the last check has no result for (the
  // subscription handed out another host or SNI) are checked quietly.
  function checkMissingProfiles() {
    if (!profile.enabled || !profile.measured || serversLoading || profile.running) { return; }
    var servers = currentStatus && currentStatus.servers ? currentStatus.servers : []; var i;
    for (i = 0; i < servers.length; i += 1) { if (profile.pings[i] === null || profile.pings[i] === undefined) { runProfileCheck(false, true); return; } }
  }
  /* ServerProbeProgressBar: "Checked N of M" over a 7 dp bar. */
  function showProbeCard(visible) { toggleClass(byId('probeWrap'), 'visible', visible); }
  function updateProbeCard() {
    var fraction = profile.total > 0 ? Math.max(0, Math.min(1, profile.completed / profile.total)) : 0;
    text('probeText', t('server_probe_progress', profile.completed, profile.total));
    byId('probeFill').style.width = (fraction * 100) + '%';
    byId('probeTrack').style.left = fraction > 0 ? 'calc(' + (fraction * 100) + '% + 8px)' : '0';
  }
  // Ping chips change in place: rebuilding the grid would move the focus.
  function updateServerChips() {
    var grid = byId('serverGrid'); if (!grid) { return; }
    var rows = grid.getElementsByClassName('server-item'); var i; var changed = false;
    for (i = 0; i < rows.length; i += 1) {
      var idx = Number(rows[i].getAttribute('data-index')); var value = displayedPing(idx);
      if (rows[i].getAttribute('data-ping') === String(value)) { continue; }
      rows[i].setAttribute('data-ping', String(value));
      var old = rows[i].querySelector('.ping-chip, .ping-down'); if (!old) { continue; }
      var holder = document.createElement('span'); holder.innerHTML = statusBlock(value);
      old.parentNode.replaceChild(holder.firstChild, old); changed = true;
    }
    if (changed) { animateSpinners(); }
  }
  // Every 5 s on the server screen (TCP), every 60 s on the home screen for
  // the current server while disconnected (MainViewModel).
  setInterval(function () { if (currentScreen === 'servers' && !serversLoading && currentStatus && currentStatus.linked) { measurePings(true); } }, 5000);
  setInterval(function () { if (currentScreen === 'home' && currentStatus && currentStatus.linked && !currentStatus.connected && selectedIndex !== null) { measurePings(true, null, selectedIndex); } }, 60000);

  /* ServerListScreen.kt */
  function transportLabel(network) {
    var n = String(network || '').toLowerCase();
    return ({ tcp: 'RAW', ws: 'WS', grpc: 'gRPC', xhttp: 'XHTTP', httpupgrade: 'HTTPUpgrade' })[n] || n.toUpperCase();
  }
  function protocolFormula(server) {
    var parts = [];
    if (server.protocol === 'Hysteria2') {
      parts.push('QUIC'); if (server.obfs) { parts.push('Salamander'); } if (server.ech) { parts.push('ECH'); } if (server.port_hopping) { parts.push('Port hopping'); }
    } else {
      if (server.security && server.security !== 'none') { parts.push(server.security.toUpperCase()); }
      if (server.network) { parts.push(transportLabel(server.network)); }
      if (server.vision) { parts.push('Vision'); }
    }
    return parts.join(' · ');
  }
  // MaterialTheme.colorScheme.onSurfaceVariant of the active theme.
  function onSurfaceVariant() { return document.body.className.indexOf('light') >= 0 ? '#5c5e6a' : '#b0b0b5'; }
  function statusBlock(ping) {
    if (ping < 0) { return '<span class="ping-down">' + t('server_unavailable') + '</span>'; }
    if (ping > 0) { return '<span class="chip-box ping-chip"><b style="color:' + pingColor(ping) + '">' + ping + '</b><small>' + t('speed_unit_ms') + '</small></span>'; }
    return '<span class="chip-box ping-chip loading">' + spinnerHtml(36, 4, onSurfaceVariant()) + '</span>';
  }
  function renderServers(keepFocus) {
    var grid = byId('serverGrid'); var servers = currentStatus && currentStatus.servers ? currentStatus.servers : [];
    var order = displayOrder(); var admin = isAdmin(); var out = ''; var r; var c; var idx; var server; var p; var subtitle; var focusedIndex = null;
    if (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-index') !== null) { focusedIndex = document.activeElement.getAttribute('data-index'); }
    toggleClass(byId('autoServerButton'), 'selected', automaticSelection);
    setRefreshSpinning();
    if (!servers.length) {
      // isLoading: a spinner; an error: its text in the error colour; else "no servers".
      grid.innerHTML = serversLoading ? '<div class="center-message">' + spinnerHtml(80, 8, '#4caf50') + '</div>' : (serversError ? '<p class="list-message list-error">' + escapeHtml(serversError || t('servers_load_error')) + '</p>' : '<p class="list-message">' + t('servers_empty') + '</p>');
      animateSpinners(); updateCues(grid); return;
    }
    for (r = 0; r < order.length; r += 2) {
      out += '<div class="server-row">';
      for (c = r; c < r + 2; c += 1) {
        if (c >= order.length) { out += '<span class="server-spacer"></span>'; continue; }
        idx = order[c]; server = servers[idx]; p = serverPresentation(server);
        subtitle = admin ? [server.protocol, protocolFormula(server)].filter(function (v) { return v; }).join(' · ') : server.protocol;
        out += '<div tabindex="0" class="server-item focusable' + (admin ? ' endpoint' : '') + (!automaticSelection && selectedIndex === idx ? ' selected' : '') + '" data-index="' + idx + '" data-ping="' + displayedPing(idx) + '">' +
          '<span class="server-main"><span class="server-flag" style="' + flagStyle(p.code) + '"></span><span class="server-copy-col"><strong>' + emojiHtml(p.name) + '</strong><small>' + escapeHtml(subtitle) + '</small></span>' + statusBlock(displayedPing(idx)) + '</span>' +
          (admin ? '<span class="server-divider"></span><span class="server-endpoint"><span class="endpoint-marker"><svg><use xlink:href="#i-endpoint"></use></svg></span><span class="endpoint-address">' + escapeHtml(server.address) + '</span><span class="chip-box port-chip">' + escapeHtml(server.port) + '</span></span>' : '') +
          '</div>';
      }
      out += '</div>';
    }
    grid.innerHTML = out;
    animateSpinners();
    // Measured here, not on OK: a hidden screen is laid out invisibly for it.
    var screen = byId('serversScreen'); var hidden = screen.className.indexOf('hidden') >= 0;
    if (hidden) { screen.style.visibility = 'hidden'; removeClass(screen, 'hidden'); }
    fitServerNames(grid);
    if (hidden) { addClass(screen, 'hidden'); screen.style.visibility = ''; }
    var rows = grid.getElementsByClassName('server-item'); var i;
    for (i = 0; i < rows.length; i += 1) {
      rows[i].onclick = function () { chooseServer(Number(this.getAttribute('data-index'))); };
      rows[i].onfocus = function () { keepVisible(grid, this.parentNode); };
      if (keepFocus && focusedIndex !== null && rows[i].getAttribute('data-index') === focusedIndex) { rows[i].focus(); }
    }
    updateCues(grid);
  }
  /* The name shrinks in 0.5sp steps down to 13sp until the widest name fits. */
  function fitServerNames(grid) {
    var names = grid.querySelectorAll('.server-copy-col strong'); var ratio = 1; var i;
    for (i = 0; i < names.length; i += 1) { if (names[i].clientWidth) { ratio = Math.max(ratio, names[i].scrollWidth / names[i].clientWidth); } }
    if (ratio <= 1.01) { return; }
    // 0.5sp steps (1px here) down to 13sp, as serverNameFontSize does.
    var size = Math.max(26, Math.floor(32 / ratio));
    for (i = 0; i < names.length; i += 1) { names[i].style.fontSize = size + 'px'; }
  }
  /* PivotBringIntoViewSpec (compose-foundation 1.11, used on TV devices): the
     focused item's top goes to 30% of the viewport, or its bottom to the
     viewport's bottom when it would not fit from there; spring() animation. */
  var scrollAnims = {}; var scrollAnimId = 0;
  function pivotDistance(offset, size, container) {
    var target = 0.3 * container;
    if (size <= container && container - target < size) { target = container - size; }
    return offset - target;
  }
  function keepVisible(list, row) {
    var anim = list.__sid && scrollAnims[list.__sid];
    var from = anim ? anim.pos : (list.__pre != null ? list.__pre : list.scrollTop);
    var offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - from;
    if (!anim) { list.scrollTop = from; }
    var max = Math.max(0, list.scrollHeight - list.clientHeight);
    var target = Math.max(0, Math.min(max, from + pivotDistance(offset, row.getBoundingClientRect().height, list.clientHeight)));
    springScroll(list, target);
  }
  function springScroll(list, target) {
    if (!list.__sid) { scrollAnimId += 1; list.__sid = 's' + scrollAnimId; }
    var anim = scrollAnims[list.__sid];
    if (anim) { anim.retarget(target); return; }
    if (Math.abs(list.scrollTop - target) < 0.5) { list.scrollTop = target; updateCues(list); return; }
    var w = Math.sqrt(1500); // spring(): stiffness 1500, damping ratio 1
    anim = { pos: list.scrollTop, vel: 0, target: target, start: now(), d0: list.scrollTop - target, v0: 0 };
    anim.retarget = function (t) { anim.step(now()); anim.target = t; anim.d0 = anim.pos - t; anim.v0 = anim.vel; anim.start = now(); };
    anim.step = function (time) {
      var dt = (time - anim.start) / 1000; var c = anim.v0 + w * anim.d0; var e = Math.exp(-w * dt);
      anim.pos = anim.target + (anim.d0 + c * dt) * e; anim.vel = (c - w * (anim.d0 + c * dt)) * e;
    };
    scrollAnims[list.__sid] = anim;
    (function frame() {
      anim.step(now());
      var done = Math.abs(anim.pos - anim.target) < 0.5 && Math.abs(anim.vel) < 2;
      list.scrollTop = done ? anim.target : anim.pos; updateCues(list);
      if (done) { delete scrollAnims[list.__sid]; } else { raf(frame); }
    }());
  }
  /* VerticalScrollCues.kt: 38dp fading edges and arrows that follow the scroll. */
  function updateCues(list) {
    var box = list.parentNode; var fade = 76; var h = list.clientHeight;
    var topA = Math.min(1, list.scrollTop / fade); var bottomA = Math.min(1, Math.max(0, list.scrollHeight - list.scrollTop - h) / fade);
    var cues = box.getElementsByClassName('scroll-cue'); var fades = box.getElementsByClassName('scroll-fade');
    if (cues.length) { cues[0].style.opacity = topA; cues[1].style.opacity = bottomA; }
    // The list sits on the screen background, so fading it out equals a gradient of that colour over it.
    if (fades.length) { fades[0].style.opacity = topA; fades[1].style.opacity = bottomA; }
  }

  function chooseServer(index) { storeSelection(false, index); renderHome(currentStatus); showScreen('home'); setTimeout(function () { byId('powerButton').focus(); }, 100); }
  function setConnecting(active, label) { toggleClass(byId('powerButton'), 'connecting', active); toggleClass(byId('connectionState'), 'connecting', active); if (active) { text('connectionState', label); } }
  function toggleConnection() { if (busy || !currentStatus) { return; } if (currentStatus.connected) { disconnect(); } else { connect(); } }
  function connect() {
    if (selectedIndex === null) { showServers(); return; } busy = true; setConnecting(true, t('state_connecting'));
    // VpnConnectionManager revalidation: an automatic connect takes the best
    // profile the last check confirmed (3 min), else the best TCP-scored one.
    if (automaticSelection) {
      request('GET', '/api/best?mode=connect&timeout=' + pingTimeoutSeconds, null, function (error, result) {
        if (!error && result && result.index !== null && result.index !== undefined) { storeSelection(true, result.index); }
        start();
      });
    } else { start(); }
    function start() {
    request('POST', '/api/connect', {index:selectedIndex}, function (error, status) {
      busy = false; if (error) { setConnecting(false, ''); text('connectionState', error.message); addClass(byId('connectionState'), 'error'); return; } renderHome(status);
    });
    }
  }
  function disconnect() {
    busy = true;
    request('POST', '/api/disconnect', {}, function (error, status) {
      busy = false; if (error) { setConnecting(false, ''); text('connectionState', error.message); addClass(byId('connectionState'), 'error'); return; } renderHome(status);
    });
  }

  /* StatsScreen.kt, StatsViewModel.kt and TrafficLogDao.kt over the service's traffic_log. */
  var trafficLog = [];
  var statsPeriod = 0;
  var chartAnimStart = 0;
  var ruWeekShort = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var ruWeekLong = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  var ruMonthShort = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function sessionsWordUnused(n) { var m10 = n % 10; var m100 = n % 100; if (m10 === 1 && m100 !== 11) { return n + ' сессия'; } if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) { return n + ' сессии'; } return n + ' сессий'; }
  function shortBytes(b) {
    if (b <= 0) { return '0'; } if (b < 1024) { return b + 'B'; } if (b < 1048576) { return Math.floor(b / 1024) + 'K'; }
    if (b < 1073741824) { return Math.floor(b / 1048576) + 'M'; } return decimal(b / 1073741824, 1) + 'G';
  }
  function periodStats() {
    var d = new Date(); d.setHours(0, 0, 0, 0); var start; var end; var key; var groups = {}; var list = []; var i;
    var tz = -new Date().getTimezoneOffset() * 60;
    if (statsPeriod === 0) { start = d.getTime() / 1000; end = start + 86400; key = function (t) { return Math.floor(t / 3600) * 3600; }; }
    else if (statsPeriod === 1) { var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); start = d.getTime() / 1000; end = start + 7 * 86400; key = function (t) { return Math.floor((t + tz) / 86400) * 86400 - tz; }; }
    else { d.setDate(1); start = d.getTime() / 1000; var e = new Date(d.getTime()); e.setMonth(e.getMonth() + 1); end = e.getTime() / 1000; key = function (t) { return Math.floor((t - start) / 604800) * 604800 + start; }; }
    for (i = 0; i < trafficLog.length; i += 1) {
      var row = trafficLog[i]; if (row.timestamp < start || row.timestamp >= end) { continue; }
      var k = key(row.timestamp);
      if (!groups[k]) { groups[k] = { period: k, totalBytes: 0, totalSeconds: 0, sessions: 0 }; list.push(groups[k]); }
      groups[k].totalBytes += row.bytes; groups[k].totalSeconds += row.seconds; groups[k].sessions += 1;
    }
    list.sort(function (x, y) { return x.period - y.period; });
    var slots = [];
    if (statsPeriod === 0) { for (i = 0; i < 24; i += 1) { slots.push(groups[start + i * 3600] || { period: start + i * 3600, totalBytes: 0, totalSeconds: 0, sessions: 0 }); } }
    else if (statsPeriod === 1) { for (i = 0; i < 7; i += 1) { slots.push(groups[start + i * 86400] || { period: start + i * 86400, totalBytes: 0, totalSeconds: 0, sessions: 0 }); } }
    else { slots = list; }
    return { stats: list, slots: slots };
  }
  function slotLabel(slot, index) {
    if (statsPeriod === 0) { return index % 3 === 0 ? index + ':00' : ''; }
    if (statsPeriod === 1) { return capital(DATE_NAMES.weekShort[new Date(slot.period * 1000).getDay()]); }
    return t('stats_week_short', index + 1);
  }
  function periodLabel(t) {
    var d = new Date(t * 1000);
    if (statsPeriod === 0) { return two(d.getHours()) + ':00'; }
    if (statsPeriod === 1) { return capital(DATE_NAMES.weekLong[d.getDay()]) + ', ' + two(d.getDate()) + ' ' + DATE_NAMES.monthShort[d.getMonth()]; }
    var e = new Date((t + 6 * 86400) * 1000);
    return two(d.getDate()) + ' ' + DATE_NAMES.monthShort[d.getMonth()] + ' — ' + two(e.getDate()) + ' ' + DATE_NAMES.monthShort[e.getMonth()];
  }
  function renderStats(status) {
    var all = 0; var i; for (i = 0; i < trafficLog.length; i += 1) { all += trafficLog[i].bytes; }
    var data = periodStats(); var sessions = 0; var seconds = 0;
    for (i = 0; i < data.stats.length; i += 1) { sessions += data.stats[i].sessions; seconds += data.stats[i].totalSeconds; }
    text('statsTotal', formatBytesStats(all)); text('statsSessions', sessions);
    text('statsTime', formatStatsTime(seconds)); text('statsAverage', formatBytesStats(sessions > 0 ? Math.floor(all / sessions) : 0));
    return data;
  }
  function renderStatsBody() {
    var data = renderStats(currentStatus || {}); var body = byId('statsBody'); var i;
    if (!data.stats.length) { html('statsBody', '<div class="stats-empty">' + t('stats_no_data') + '</div>'); return; }
    var titles = [t('stats_today_by_hour'), t('stats_week_by_day'), t('stats_month_by_week')];
    var max = 1; for (i = 0; i < data.stats.length; i += 1) { max = Math.max(max, data.stats[i].totalBytes); }
    var rows = '';
    for (i = 0; i < data.stats.length; i += 1) {
      var s = data.stats[i];
      rows += '<div class="stat-row"><div class="stat-row-head"><span class="stat-row-copy"><strong>' + periodLabel(s.period) + '</strong><small>' + plural('stats_sessions_short', s.sessions) + '  •  ' + formatStatsTime(s.totalSeconds) + '</small></span><b>' + formatBytesStats(s.totalBytes) + '</b></div><div class="stat-bar">' + (s.totalBytes > 0 ? '<i style="width:' + (Math.min(1, s.totalBytes / max) * 100) + '%"></i>' : '') + '</div></div>';
    }
    body.innerHTML = '<div id="chartCard" class="chart-card"><svg id="chartSvg"></svg></div><div class="stats-period-title">' + titles[statsPeriod] + '</div><div class="stats-list-box"><div id="statsList" class="scroll-list">' + rows + '</div><span class="scroll-fade top"></span><span class="scroll-fade bottom"></span><svg class="scroll-cue top"><use xlink:href="#i-arrow-up"></use></svg><svg class="scroll-cue bottom"><use xlink:href="#i-arrow-down"></use></svg></div>';
    // Column: the 220dp chart (with 4dp vertical padding) takes what is left, then the title, then the list.
    var room = body.clientHeight; var chartOuter = Math.min(440, room);
    byId('chartCard').style.height = Math.max(0, chartOuter - 16) + 'px';
    if (chartOuter < 16) { byId('chartCard').style.margin = (chartOuter / 2) + 'px 0'; }
    updateCues(byId('statsList'));
    chartAnimStart = now(); chartData = data;
    (function frame() { var t = now() - chartAnimStart; drawChart(progressOf(t, 0, 750)); if (t < 760 && currentScreen === 'stats') { raf(frame); } }());
  }
  var chartData = null;
  function drawChart(progress) {
    var card = byId('chartCard'); if (!card || !chartData) { return; }
    var w = card.clientWidth; var h = card.clientHeight; var svg = byId('chartSvg');
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    var left = 24; var top = 32; var cw = w - 24 - 32; var ch = h - 32 - 56; if (ch <= 0 || !chartData.slots.length) { svg.innerHTML = ''; return; }
    var slots = chartData.slots; var max = 1; var maxIndex = -1; var i;
    for (i = 0; i < slots.length; i += 1) { if (slots[i].totalBytes > max) { max = slots[i].totalBytes; } }
    for (i = 0; i < slots.length; i += 1) { if (slots[i].totalBytes === max && max > 0) { maxIndex = i; break; } }
    var chartLeft = 72; var chartWidth = cw - chartLeft; var usable = ch * 0.88; var out = '';
    [0, 0.5, 1].forEach(function (f) {
      var y = top + ch - usable * f;
      out += '<line x1="' + (left + chartLeft) + '" y1="' + y + '" x2="' + (left + cw) + '" y2="' + y + '" stroke="rgba(73,69,79,.4)" stroke-width="2"' + (f === 0 ? '' : ' stroke-dasharray="6 8"') + '/>';
      out += '<text x="' + (left + chartLeft - 12) + '" y="' + (y + 8) + '" text-anchor="end" font-size="18" fill="rgba(176,176,181,.5)">' + shortBytes(Math.floor(max * f)) + '</text>';
    });
    var n = slots.length; var totalSpacing = chartWidth * 0.22; var spacing = totalSpacing / (n + 1); var bw = (chartWidth - totalSpacing) / n;
    for (i = 0; i < n; i += 1) {
      var bh = slots[i].totalBytes / max * usable * progress; var x = left + chartLeft + spacing + i * (bw + spacing); var bottom = top + ch; var bt = bottom - bh;
      if (bh > 0.5) {
        var isMax = i === maxIndex; var topColor = isMax ? '76,175,80' : '33,150,243'; var bottomA = isMax ? 0.2 : 0.18;
        out += '<defs><linearGradient id="bar' + i + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + bt + '" x2="0" y2="' + bottom + '"><stop offset="0" stop-color="rgb(' + topColor + ')"/><stop offset="1" stop-color="rgb(' + topColor + ')" stop-opacity="' + bottomA + '"/></linearGradient></defs>';
        out += '<rect x="' + (x - 4) + '" y="' + (bt - 4) + '" width="' + (bw + 8) + '" height="' + (bh + 4) + '" rx="12" fill="rgb(' + topColor + ')" fill-opacity="0.12"/>';
        out += '<rect x="' + x + '" y="' + bt + '" width="' + bw + '" height="' + bh + '" rx="8" fill="url(#bar' + i + ')"/>';
        if (isMax && progress > 0.95) { out += '<rect x="' + x + '" y="' + bt + '" width="' + bw + '" height="' + bh + '" rx="8" fill="none" stroke="#4caf50" stroke-width="3"/>'; }
      }
      var label = slotLabel(slots[i], i);
      if (label) { out += '<text x="' + (x + bw / 2) + '" y="' + (top + ch + 32) + '" text-anchor="middle" font-size="18" fill="#b0b0b5">' + label + '</text>'; }
    }
    svg.innerHTML = out;
  }
  function loadStats() {
    request('GET', '/api/stats', null, function (error, result) {
      if (!error && result) { trafficLog = result.logs || []; }
      if (currentScreen === 'stats') { renderStatsBody(); }
    });
  }
  function fitHeroGradient() {
    var card = document.querySelector('.hero-card'); if (!card || !card.offsetWidth) { return; }
    // Brush.linearGradient runs corner to corner: the CSS angle that follows the diagonal.
    var angle = 90 + Math.atan(card.offsetHeight / card.offsetWidth) * 180 / Math.PI;
    card.style.background = 'linear-gradient(' + angle.toFixed(2) + 'deg, rgba(33,150,243,.35), rgba(76,175,80,.18))';
  }

  /* SpeedTestScreen.kt and SpeedTestViewModel.kt (measured by the service). */
  var speed = { phase: 'Idle', ping: 0, downloadSpeed: 0, currentSpeed: 0, progress: 0, error: null };
  var speedHistory = [];
  var speedPoll = null;
  var gauge = { size: 616, shown: 0, from: 0, target: 0, tweenStart: 0, burst: 0, burstStart: 0, successful: false, running: false };
  var speedErrors = { speed_no_connection: 1, speed_measure_failed: 1 };
  function mbps(value) { return decimal(value, 1); }
  function downloadColor(v) { return v < 25 ? '#f44336' : (v < 75 ? '#ff9800' : (v < 150 ? '#4caf50' : '#2196f3')); }
  function pingResultColor(p) { return p >= 1 && p <= 100 ? '#4caf50' : (p > 100 && p <= 200 ? '#ff9800' : (p > 200 ? '#f44336' : '#b0b0b5')); }
  function sizeGauge() {
    var el = byId('speedGauge'); var body = el.parentNode;
    var h = body.clientHeight - 32; var w = body.clientWidth;
    gauge.size = h > 0 && w > 0 ? Math.min(h * 0.85, w * 0.35) : 616;
    el.style.width = gauge.size + 'px'; el.style.height = gauge.size + 'px';
    byId('gaugeSvg').setAttribute('viewBox', '0 0 ' + gauge.size + ' ' + gauge.size);
  }
  function setGaugeTarget(fraction) {
    if (Math.abs(fraction - gauge.target) < 1e-6) { return; }
    gauge.from = gauge.shown; gauge.target = fraction; gauge.tweenStart = now();
  }
  function drawGaugeFrame(t) {
    var size = gauge.size; var stroke = 36; var pad = stroke / 2 + 16; var r = (size - pad * 2) / 2; var c = size / 2;
    var phase = speed.phase; var hasError = !!speed.error;
    gauge.shown = gauge.from + (gauge.target - gauge.from) * progressOf(t - gauge.tweenStart, 0, 420);
    var scanCycle = (t % 1800) / 900; var scan = 0.06 + 0.88 * fastOutSlowIn(scanCycle <= 1 ? scanCycle : 2 - scanCycle);
    var pulseCycle = (t % 2200) / 1100; var pulse = fastOutSlowIn(pulseCycle <= 1 ? pulseCycle : 2 - pulseCycle);
    var inactive = phase === 'Idle' || phase === 'Checking' || hasError;
    var running = phase === 'Ping' || phase === 'Download';
    var fraction = phase === 'Ping' ? scan : gauge.shown;
    var v = speed.currentSpeed;
    var color = phase === 'Ping' ? '#2196f3' : (v < 25 ? '#f44336' : (v < 75 ? '#ff9800' : (v < 150 ? '#4caf50' : '#2196f3')));
    function pt(angle, radius) { var a = angle * Math.PI / 180; return [c + radius * Math.cos(a), c + radius * Math.sin(a)]; }
    function arc(sweep) { var s = pt(150, r); var e = pt(150 + sweep, r); return 'M' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2); }
    var svg = '';
    if (running) { svg += '<circle cx="' + c + '" cy="' + c + '" r="' + (size * (0.43 + pulse * 0.035)).toFixed(2) + '" fill="#2196f3" fill-opacity="' + (0.05 + pulse * 0.07).toFixed(3) + '"/>'; }
    svg += '<path d="' + arc(240) + '" fill="none" stroke="' + gaugeTrack() + '" stroke-width="' + stroke + '" stroke-linecap="round"/>';
    if (fraction > 0) { svg += '<path d="' + arc(Math.max(0.01, 240 * fraction)) + '" fill="none" stroke="' + color + '" stroke-width="' + stroke + '" stroke-linecap="round"/>'; }
    for (var i = 0; i <= 10; i += 1) { var a1 = pt(150 + 24 * i, r - stroke / 2 - 12); var a2 = pt(150 + 24 * i, r - stroke / 2 - 4); svg += '<line x1="' + a1[0].toFixed(2) + '" y1="' + a1[1].toFixed(2) + '" x2="' + a2[0].toFixed(2) + '" y2="' + a2[1].toFixed(2) + '" stroke="' + gaugeTrack() + '" stroke-width="4"/>'; }
    if (!inactive) {
      var n = pt(150 + 240 * fraction, r - stroke - 32);
      svg += '<line x1="' + c + '" y1="' + c + '" x2="' + n[0].toFixed(2) + '" y2="' + n[1].toFixed(2) + '" stroke="' + color + '" stroke-width="6" stroke-linecap="round"/><circle cx="' + c + '" cy="' + c + '" r="12" fill="' + color + '"/>';
    }
    var burst = gauge.successful ? progressOf(t - gauge.burstStart, 0, 720) : 0;
    if (burst > 0.001 && burst < 0.999) {
      for (var k = 0; k < 12; k += 1) { var p = pt(k * 30 - 90, r * (0.82 + burst * 0.22)); svg += '<circle cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="' + ((2.8 - burst * 1.2) * 2).toFixed(2) + '" fill="#4caf50" fill-opacity="' + ((1 - burst) * 0.75).toFixed(3) + '"/>'; }
    }
    byId('gaugeSvg').innerHTML = svg;
    return running || (t - gauge.tweenStart) < 420 || (burst > 0.001 && burst < 0.999);
  }
  // MaterialTheme.colorScheme.surfaceVariant of the active theme.
  function gaugeTrack() { return document.body.className.indexOf('light') >= 0 ? '#e9eaec' : '#242426'; }
  var gaugeLoop = false;
  function animateGauge() {
    if (gaugeLoop) { return; } gaugeLoop = true;
    (function frame() { var more = currentScreen === 'speed' && drawGaugeFrame(now()); if (more) { raf(frame); } else { gaugeLoop = false; } }());
  }
  function renderSpeed() {
    var phase = speed.phase; var error = speed.error ? (speedErrors[speed.error] ? t(speed.error) : speed.error) : '';
    var successful = phase === 'Done' && !speed.error && speed.downloadSpeed > 0;
    var inactive = phase === 'Idle' || phase === 'Checking' || !!speed.error;
    if (successful && !gauge.successful) { gauge.burstStart = now(); }
    gauge.successful = successful;
    setGaugeTarget(Math.max(0, Math.min(1, speed.currentSpeed / 500)));
    text('speedValue', inactive ? '0' : mbps(speed.currentSpeed));
    toggleClass(byId('gaugeCheck'), 'visible', successful);
    toggleClass(byId('speedError'), 'hidden', !error); text('speedError', error);
    var stages = byId('speedStages'); var showStages = !error && (phase === 'Ping' || phase === 'Download' || phase === 'Done');
    if (showStages && stages.className.indexOf('hidden') >= 0) { removeClass(stages, 'hidden'); removeClass(stages, 'entering'); void stages.offsetWidth; addClass(stages, 'entering'); }
    if (!showStages) { addClass(stages, 'hidden'); }
    toggleClass(byId('stagePing'), 'active', phase === 'Ping'); toggleClass(byId('stagePing'), 'completed', phase === 'Download' || phase === 'Done');
    toggleClass(byId('stageDownload'), 'active', phase === 'Download'); toggleClass(byId('stageDownload'), 'completed', phase === 'Done');
    text('speedPing', speed.ping > 0 ? speed.ping : '—'); byId('speedPing').style.color = pingResultColor(speed.ping);
    text('speedDownload', speed.downloadSpeed > 0 ? mbps(speed.downloadSpeed) : '—'); byId('speedDownload').style.color = speed.downloadSpeed > 0 ? downloadColor(speed.downloadSpeed) : '#b0b0b5';
    text('startSpeedButton', phase === 'Idle' || phase === 'Done' ? t('speed_start_test') : t('speed_stop'));
    var count = byId('historyCount'); toggleClass(count, 'hidden', !speedHistory.length); text('historyCount', speedHistory.length);
    animateGauge();
  }
  function pollSpeed() {
    if (speedPoll) { clearTimeout(speedPoll); speedPoll = null; }
    request('GET', '/api/speedtest', null, function (error, state) {
      if (!error && state) { speed = state; renderSpeed(); }
      if (speed.phase === 'Done') { loadSpeedHistory(); }
      if (currentScreen === 'speed' && (speed.phase === 'Checking' || speed.phase === 'Ping' || speed.phase === 'Download')) { speedPoll = setTimeout(pollSpeed, 250); }
    });
  }
  function runSpeedTest() {
    if (speed.phase === 'Done' || speed.phase === 'Idle') {
      gauge.successful = false;
      request('POST', '/api/speedtest/start', {}, function (error, state) { if (!error) { speed = state; renderSpeed(); pollSpeed(); } });
    } else {
      request('POST', '/api/speedtest/stop', {}, function () { speed = { phase: 'Idle', ping: 0, downloadSpeed: 0, currentSpeed: 0, progress: 0, error: null }; renderSpeed(); });
    }
  }
  function loadSpeedHistory(done) {
    request('GET', '/api/speedtest/history', null, function (error, result) {
      if (!error && result) { speedHistory = result.history || []; }
      var count = byId('historyCount'); toggleClass(count, 'hidden', !speedHistory.length); text('historyCount', speedHistory.length);
      if (done) { done(); }
    });
  }
  function openSpeed() {
    sizeGauge(); renderSpeed(); loadSpeedHistory();
    request('GET', '/api/speedtest', null, function (error, state) { if (!error && state) { speed = state; renderSpeed(); if (speed.phase !== 'Done' && speed.phase !== 'Idle') { pollSpeed(); } } });
  }
  /* SpeedTestHistoryScreen.kt */
  function renderSpeedHistory() {
    var list = byId('historyList'); var out = ''; var i;
    text('historyTotal', speedHistory.length);
    if (!speedHistory.length) { list.innerHTML = '<p class="history-empty">' + t('speed_history_empty') + '</p>'; updateCues(list); return; }
    for (i = 0; i < speedHistory.length; i += 1) {
      var e = speedHistory[i]; var d = new Date(e.timestamp);
      out += '<div class="history-card focusable" tabindex="0" data-ts="' + e.timestamp + '"><div class="history-copy"><span>' + formatDate(d) + '  ' + two(d.getHours()) + ':' + two(d.getMinutes()) + '</span><div class="history-values"><b>' + t('speed_history_download_value', e.download) + '</b><strong>' + t('speed_history_ping_value', e.ping) + '</strong><em>' + (e.viaVpn ? t('speed_via_vpn') : t('speed_direct')) + '</em></div></div><button class="history-delete focusable" data-ts="' + e.timestamp + '"><svg><use xlink:href="#i-delete-outline"></use></svg></button></div>';
    }
    list.innerHTML = out;
    var cards = list.getElementsByClassName('history-card'); var dels = list.getElementsByClassName('history-delete');
    for (i = 0; i < cards.length; i += 1) {
      cards[i].onfocus = function () { keepVisible(list, this); };
      // SpeedTestHistoryScreen.kt: card right -> its delete button, delete left -> card.
      cards[i].id = 'histCard' + i; dels[i].id = 'histDel' + i; cards[i].setAttribute('data-right', dels[i].id); dels[i].setAttribute('data-left', cards[i].id);
      cards[i].onkeydown = function (ev) { if (ev.keyCode === 46) { deleteHistoryEntry(this); } };
      dels[i].onclick = function () { deleteHistoryEntry(this.parentNode); };
    }
    updateCues(list);
  }
  var deleting = false;
  function deleteHistoryEntry(card) {
    if (deleting) { return; } deleting = true;
    var ts = card.getAttribute('data-ts'); var h = card.offsetHeight;
    // slideOutHorizontally + fadeOut(250) + shrinkVertically(320), then the entry goes.
    card.style.height = h + 'px'; addClass(card, 'removing'); void card.offsetWidth;
    card.style.webkitTransform = 'translateX(-100%)'; card.style.transform = 'translateX(-100%)'; card.style.opacity = 0;
    card.style.height = '0px'; card.style.paddingTop = '0px'; card.style.paddingBottom = '0px'; card.style.marginBottom = '0px';
    var next = card.nextSibling || card.previousSibling;
    setTimeout(function () {
      request('POST', '/api/speedtest/delete', { timestamp: Number(ts) }, function (error, result) {
        deleting = false; if (!error && result) { speedHistory = result.history || []; }
        renderSpeedHistory(); renderSpeed();
        var target = next && next.getAttribute ? list().querySelector('[data-ts="' + next.getAttribute('data-ts') + '"]') : null;
        if (target) { target.focus(); } else { focusFirst('speedHistoryScreen'); }
      });
    }, 320);
    function list() { return byId('historyList'); }
  }

  /* SubscriptionScreen.kt and PurchasePriceResolver.kt */
  function planTitle(days) { var k = ({ 1: 'plan_day', 7: 'plan_week', 30: 'plan_month', 90: 'plan_3month', 365: 'plan_year' })[days]; return k ? t(k) : String(days); }
  function planKey(days) { return ({ 1: 'day', 7: 'week', 30: 'month', 90: '3month', 365: 'year' })[days] || 'd' + days; }
  function formatRub(amount) {
    var value = parseFloat(amount); if (isNaN(value)) { return amount + '₽'; }
    var n = Math.floor(value); var s = String(n);
    if (n >= 1000) { s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
    return s + '₽';
  }
  function formatAmount(currency, amount) {
    var value = parseFloat(amount);
    if (currency === 'RUB') { return formatRub(amount); }
    if (currency === 'USD') { return isNaN(value) ? '$' + amount : '$' + value.toFixed(2); }
    if (currency === 'XTR') { return isNaN(value) ? amount + ' ⭐' : Math.floor(value) + ' ⭐'; }
    return (amount + ' ' + currency).replace(/^\s+|\s+$/g, '');
  }
  function scaledShortest(duration, durations, currency) {
    var shortest = null; var i; var j; var term; var amount;
    for (i = 0; i < durations.length; i += 1) {
      term = durations[i]; if (!(term.days > 0)) { continue; } amount = null;
      for (j = 0; term.prices && j < term.prices.length; j += 1) { if (String(term.prices[j].currency).toUpperCase() === currency) { amount = term.prices[j].amount; break; } }
      if (amount === null) { for (j = 0; term.payment_methods && j < term.payment_methods.length; j += 1) { if (String(term.payment_methods[j].currency).toUpperCase() === currency) { amount = term.payment_methods[j].original_amount; break; } } }
      amount = parseFloat(amount);
      if (amount > 0 && (!shortest || term.days < shortest.days)) { shortest = { days: term.days, amount: amount }; }
    }
    if (!shortest || duration.days <= shortest.days) { return null; }
    return String(Math.round(shortest.amount * duration.days / shortest.days * 100) / 100);
  }
  function resolvePrice(duration, durations) {
    var order = ['RUB', 'USD', 'XTR']; var methods = []; var prices = []; var i; var j; var found = null; var currency; var original; var finalAmount; var discount;
    for (i = 0; duration.payment_methods && i < duration.payment_methods.length; i += 1) { var m = duration.payment_methods[i]; if (m.currency && m.original_amount && m.final_amount) { methods.push(m); } }
    for (i = 0; i < order.length && !found; i += 1) { for (j = 0; j < methods.length; j += 1) { if (String(methods[j].currency).toUpperCase() === order[i]) { found = methods[j]; break; } } }
    if (!found && methods.length) { found = methods[0]; }
    if (found) {
      currency = String(found.currency).toUpperCase(); original = scaledShortest(duration, durations, currency) || found.original_amount; finalAmount = found.final_amount; discount = found.discount_percent || 0;
    } else {
      for (i = 0; duration.prices && i < duration.prices.length; i += 1) { if (duration.prices[i].currency && duration.prices[i].amount) { prices.push(duration.prices[i]); } }
      for (i = 0; i < order.length && !found; i += 1) { for (j = 0; j < prices.length; j += 1) { if (String(prices[j].currency).toUpperCase() === order[i]) { found = prices[j]; break; } } }
      if (!found) { found = prices[0]; } if (!found) { return { finalPrice: 'XXX', originalPrice: null, discount: 0 }; }
      currency = String(found.currency).toUpperCase(); original = scaledShortest(duration, durations, currency) || found.amount; finalAmount = found.amount; discount = found.discount_percent || 0;
    }
    discount = Math.max(0, Math.min(100, discount));
    var hasDiscount = discount > 0 && parseFloat(finalAmount) < parseFloat(original);
    return { finalPrice: formatAmount(currency, finalAmount), originalPrice: hasDiscount ? formatAmount(currency, original) : null, discount: hasDiscount ? discount : 0 };
  }
  function normalizedName(value) { return String(value || '').replace(/^\s+|\s+$/g, '').toLowerCase().replace(/\s+/g, ' '); }
  function sameTariff(current, selected) {
    var a = normalizedName(current); var b = normalizedName(selected);
    return !!a && !!b && (a === b || a.indexOf(b + ' ') === 0 || b.indexOf(a + ' ') === 0);
  }
  function buildTariffs() {
    var plans = (purchasePlans && purchasePlans.plans) || []; var tariffs = []; var i;
    plans = plans.filter(function (p) { return (p.durations || []).some(function (d) { return d.days > 0; }); });
    plans.sort(function (a, b) { return (a.order_index || 0) - (b.order_index || 0) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)); });
    for (i = 0; i < plans.length; i += 1) {
      var plan = plans[i]; var traffic = Number(plan.traffic_limit) || 0; var devices = Number(plan.device_limit) || 0;
      var description = (traffic <= 0 ? t('plan_unlimited_traffic') : t('plan_traffic_month_fmt', traffic)) + (devices > 0 ? ' · ' + t('plan_devices_fmt', devices) : '');
      var durations = (plan.durations || []).filter(function (d) { return d.days > 0; }).sort(function (a, b) { return (a.order_index || 0) - (b.order_index || 0); });
      tariffs.push({ key: String(plan.id), title: plan.name, purchaseType: plan.purchase_type, periods: durations.map(function (d) {
        var price = resolvePrice(d, plan.durations || []);
        return { key: plan.id + ':' + planKey(d.days), title: planTitle(d.days), price: price.finalPrice, original: price.originalPrice, discount: price.discount, description: description, url: d.bot_payment_url };
      }) });
    }
    return tariffs;
  }
  function priceDiscountHtml(original, discount) { return '<span class="old-price"><s>' + escapeHtml(original) + '</s><em>−' + discount + '%</em></span>'; }
  function renderSubscription() {
    var a = account(); var expiry = parseDate(a.expires_at); var tariffs = buildTariffs(); var i; var out = '';
    html('currentPlanName', emojiHtml(a.plan_name || 'XXX'));
    text('currentPlanSubtitle', expiry ? t('plan_active_until', formatDate(expiry)) : '');
    var trafficGb = Number(a.traffic_limit) > 0 ? Math.floor(Number(a.traffic_limit) / 1073741824) : null; var devices = Number(a.device_limit) > 0 ? Number(a.device_limit) : null;
    var reset = trafficGb ? resetDate(a) : null;
    var resetText = reset ? t('traffic_reset_datetime', LANG === 'ru' ? two(reset.getDate()) + '.' + two(reset.getMonth() + 1) : DATE_NAMES.monthShort[reset.getMonth()] + ' ' + reset.getDate(), two(reset.getHours()) + ':' + two(reset.getMinutes())) : '';
    var limits = '';
    if (trafficGb !== null) { limits += '<span class="limit-stat"><b>' + trafficGb + ' ' + t('unit_gb') + '</b>' + (resetText ? '<span class="reset-pill"><svg><use xlink:href="#i-refresh-rounded"></use></svg>' + resetText + '</span>' : '<small>' + t('per_month_short') + '</small>') + '</span>'; }
    if (trafficGb !== null && devices !== null) { limits += '<span class="limit-dot">·</span>'; }
    if (devices !== null) { limits += '<span class="limit-stat"><b>' + devices + '</b><small>' + t('devices_label') + '</small></span>'; }
    html('currentPlanLimits', limits); toggleClass(byId('currentPlanLimits'), 'hidden', !limits);

    if (purchasePlans === null) {
      var loading = '<div class="card-message">' + (plansError ? escapeHtml(plansError) : spinnerHtml(80, 8, '#4caf50') + '<span class="loading-text">' + t('subscription_loading_plans') + '</span>') + '</div>';
      html('plansBody', loading); html('purchaseCard', loading); animateSpinners(); return;
    }
    if (!tariffs.length) { html('plansBody', '<div class="card-message">' + t('subscription_no_plans') + '</div>'); html('purchaseCard', '<div class="card-message">' + t('subscription_no_plans') + '</div>'); return; }
    var tariff = null;
    for (i = 0; i < tariffs.length; i += 1) { if (tariffs[i].key === selectedTariffKey) { tariff = tariffs[i]; } }
    if (!tariff) { tariff = tariffs[0]; selectedTariffKey = tariff.key; }
    var plan = null;
    for (i = 0; i < tariff.periods.length; i += 1) { if (tariff.periods[i].key === selectedPlanKey) { plan = tariff.periods[i]; } }
    if (!plan) { for (i = 0; i < tariff.periods.length; i += 1) { if (/:month$/.test(tariff.periods[i].key)) { plan = tariff.periods[i]; } } }
    if (!plan) { plan = tariff.periods[0]; } selectedPlanKey = plan.key;

    out += '<div class="tabs-viewport"><div class="tabs-strip-wrap"><div id="tabsStrip" class="tabs-strip">';
    for (i = 0; i < tariffs.length; i += 1) { out += '<button class="tariff-tab focusable' + (tariffs[i].key === tariff.key ? ' selected' : '') + '" data-tariff="' + escapeHtml(tariffs[i].key) + '">' + emojiHtml(tariffs[i].title) + '</button>'; }
    out += '<span id="tabIndicator" class="tab-indicator"></span></div></div><span class="scroll-fade start"></span><span class="scroll-fade end"></span><svg class="tab-arrow start"><use xlink:href="#i-arrow-left"></use></svg><svg class="tab-arrow end"><use xlink:href="#i-chevron"></use></svg></div>';
    out += '<div class="plan-list-box"><div id="planList" class="scroll-list">';
    for (i = 0; i < tariff.periods.length; i += 1) {
      var period = tariff.periods[i];
      out += '<div tabindex="0" class="plan-option focusable' + (period.key === plan.key ? ' selected' : '') + '" data-plan="' + escapeHtml(period.key) + '"><span class="plan-copy"><strong>' + escapeHtml(period.title) + '</strong><small>' + escapeHtml(period.description) + '</small></span><span class="plan-price">' + (period.original ? priceDiscountHtml(period.original, period.discount) : '') + '<b>' + escapeHtml(period.price) + '</b></span></div>';
    }
    out += '</div><span class="scroll-fade top"></span><span class="scroll-fade bottom"></span><svg class="scroll-cue top"><use xlink:href="#i-arrow-up"></use></svg><svg class="scroll-cue bottom"><use xlink:href="#i-arrow-down"></use></svg></div>';
    html('plansBody', out);

    var paid = a.status !== 'trial' && !!a.plan_name; var renewal = paid && sameTariff(a.plan_name, tariff.title);
    var actionTitle = tariff.title ? tariff.title + ' · ' + plan.title : plan.title;
    var label = t(renewal ? 'renew_plan' : (paid ? 'change_plan' : 'buy_plan'), actionTitle, plan.price);
    var qrUrl = plan.url || (renewal ? a.renewal_url : '');
    html('purchaseCard', '<h2>' + escapeHtml(plan.title) + '</h2>' + (plan.original ? priceDiscountHtml(plan.original, plan.discount) : '') + '<span class="purchase-price">' + escapeHtml(plan.price) + '</span><span class="purchase-description">' + escapeHtml(plan.description) + '</span><button class="purchase-button focusable"><span>' + emojiHtml(label) + '</span></button><span class="purchase-hint">' + t('subscription_sync_hint') + '</span>');
    var buy = document.querySelector('.purchase-button');
    buy.onclick = function () { if (qrUrl) { showQr(qrUrl); } };
    layoutTabs();
    var tabs = document.querySelectorAll('.tariff-tab');
    for (i = 0; i < tabs.length; i += 1) {
      tabs[i].onclick = function () { var key = this.getAttribute('data-tariff'); if (key === selectedTariffKey) { return; } selectedTariffKey = key; selectedPlanKey = 'month'; renderSubscription(); addClass(byId('planList'), 'tariff-enter'); focusSelector('.tariff-tab[data-tariff="' + key + '"]'); };
      tabs[i].onfocus = function () { scrollTabIntoView(this); };
    }
    var options = document.querySelectorAll('.plan-option');
    for (i = 0; i < options.length; i += 1) {
      options[i].onclick = function () { selectedPlanKey = this.getAttribute('data-plan'); var key = selectedPlanKey; renderSubscription(); focusSelector('.plan-option[data-plan="' + key + '"]'); };
      options[i].onfocus = function () { keepVisible(byId('planList'), this); subFocus.left = this.id; subscriptionRoutes(); };
    }
    // SubscriptionScreen.kt focusProperties: the remembered tariff tab is the
    // way back up from the plans, the purchase button and the header.
    buy.id = 'subBuy';
    for (i = 0; i < tabs.length; i += 1) { tabs[i].id = 'subTab' + i; if (tabs[i].className.indexOf('selected') >= 0) { subFocus.selected = i; } (function (k, tab) { var prev = tab.onfocus; tab.onfocus = function () { prev.call(this); subFocus.tab = k; subFocus.left = this.id; subscriptionRoutes(); }; }(i, tabs[i])); if (i > 0) { tabs[i].setAttribute('data-left', 'subTab' + (i - 1)); } if (i < tabs.length - 1) { tabs[i].setAttribute('data-right', 'subTab' + (i + 1)); } }
    for (i = 0; i < options.length; i += 1) { options[i].id = 'subPlan' + i; options[i].setAttribute('data-right', 'subBuy'); }
    if (subFocus.left && !byId(subFocus.left)) { subFocus.left = null; }
    subscriptionRoutes();
    updateCues(byId('planList'));
  }
  var subFocus = { tab: null, selected: 0, left: null };
  function subscriptionRoutes() {
    var tab = 'subTab' + (subFocus.tab !== null && byId('subTab' + subFocus.tab) ? subFocus.tab : subFocus.selected);
    var back = byId('subBack'); var first = byId('subPlan0'); var buy = byId('subBuy');
    if (back) { if (byId(tab)) { back.setAttribute('data-down', tab); } else { back.removeAttribute('data-down'); } }
    if (first) { first.setAttribute('data-up', tab); }
    if (buy) { buy.setAttribute('data-up', tab); buy.setAttribute('data-left', subFocus.left || tab); }
  }
  /* TvQrDialog.kt with QrCode.kt: zxing, error correction M, margin 0, 512 px. */
  function drawQr(canvas, data) {
    var qr = qrcode(0, 'M'); qr.addData(data, 'Byte'); qr.make();
    var n = qr.getModuleCount(); var multiple = Math.floor(512 / n); var pad = Math.floor((512 - n * multiple) / 2);
    var ctx = canvas.getContext('2d'); var r; var c;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 512); ctx.fillStyle = '#000';
    for (r = 0; r < n; r += 1) { for (c = 0; c < n; c += 1) { if (qr.isDark(r, c)) { ctx.fillRect(pad + c * multiple, pad + r * multiple, multiple, multiple); } } }
  }
  function showQr(data) { showQrDialog(data, t('subscription_qr_title'), t('subscription_qr_hint'), t('subscription_sync_hint'), t('subscription_change_plan')); }
  function focusSelector(selector) { var el = document.querySelector(selector); if (el) { el.focus(); } }
  /* TariffTabs: natural widths (+8dp safety, min 88dp), spare width shared equally. */
  function layoutTabs() {
    var strip = byId('tabsStrip'); if (!strip) { return; }
    var viewport = strip.parentNode.parentNode; var max = viewport.clientWidth; var tabs = strip.getElementsByClassName('tariff-tab'); var widths = []; var sum = 0; var i; var offset = 0; var selected = 0;
    for (i = 0; i < tabs.length; i += 1) {
      tabs[i].style.width = 'auto'; var bold = tabs[i].className.indexOf('selected') >= 0; if (!bold) { tabs[i].style.fontWeight = '700'; }
      widths.push(Math.max(Math.ceil(tabs[i].offsetWidth) + 16, 176)); tabs[i].style.fontWeight = ''; sum += widths[i];
    }
    var spare = Math.max(0, max - sum); var extra = Math.floor(spare / tabs.length); var rest = spare % tabs.length;
    for (i = 0; i < tabs.length; i += 1) { widths[i] += extra + (i < rest ? 1 : 0); tabs[i].style.width = widths[i] + 'px'; if (tabs[i].className.indexOf('selected') >= 0) { selected = i; } }
    for (i = 0; i < selected; i += 1) { offset += widths[i]; }
    strip.style.width = (sum + spare) + 'px';
    var indicator = byId('tabIndicator'); indicator.style.left = offset + 'px'; indicator.style.width = widths[selected] + 'px';
    strip.setAttribute('data-scroll', '0'); strip.setAttribute('data-max', String(Math.max(0, sum + spare - max)));
    scrollTabIntoView(tabs[selected]);
  }
  function scrollTabIntoView(tab) {
    var strip = byId('tabsStrip'); if (!strip || !tab) { return; }
    var max = strip.parentNode.parentNode.clientWidth; var maxScroll = Number(strip.getAttribute('data-max')) || 0; var current = Number(strip.getAttribute('data-scroll')) || 0;
    var start = tab.offsetLeft; var width = tab.offsetWidth; var end = start + width; var center = start + width / 2; var comfort = Math.max(max / 4, width / 2); var target = current;
    if (maxScroll > 0 && (start < current || end > current + max || center < current + comfort || center > current + max - comfort)) { target = center - max / 2; }
    target = Math.max(0, Math.min(maxScroll, target));
    strip.setAttribute('data-scroll', String(target)); strip.style.webkitTransform = 'translateX(' + (-target) + 'px)'; strip.style.transform = 'translateX(' + (-target) + 'px)';
    var arrows = strip.parentNode.parentNode.getElementsByClassName('tab-arrow'); var startA = maxScroll > 0 ? Math.min(1, target / 76) : 0; var endA = maxScroll > 0 ? Math.min(1, (maxScroll - target) / 76) : 0;
    arrows[0].style.opacity = startA; arrows[1].style.opacity = endA;
    var fades = strip.parentNode.parentNode.getElementsByClassName('scroll-fade');
    fades[0].style.opacity = startA; fades[1].style.opacity = endA;
  }
  function loadPlans() {
    request('GET', '/api/plans', null, function (error, result) {
      if (error) { plansError = error.message; } else { purchasePlans = result || { plans: [] }; plansError = ''; }
      afterNav(function () { if (currentScreen === 'subscription') { var had = !!document.querySelector('.tariff-tab'); renderSubscription(); if (!had) { focusFirst('subscriptionScreen'); } } });
    });
  }

  /* SettingsScreen.kt */
  function renderTimeout() {
    var progress = (pingTimeoutSeconds - 5) / 10;
    text('pingTimeout', t('server_ping_timeout_value', pingTimeoutSeconds));
    var track = byId('timeoutBar').parentNode.clientWidth || 1;
    byId('timeoutBar').style.width = (progress * track) + 'px';
    byId('timeoutTrack').style.width = Math.max(0, track - progress * track - 8) + 'px';
    byId('timeoutTrack').parentNode.getElementsByTagName('u')[0].style.display = progress < 1 ? 'block' : 'none';
  }
  function setPingTimeout(value) {
    pingTimeoutSeconds = Math.max(5, Math.min(15, value));
    try { window.localStorage.setItem('pingTimeout', String(pingTimeoutSeconds)); } catch (ignore) {}
    renderTimeout();
  }
  var settingsPage = 0;
  var pageTimer = null;
  function showSettingsPage(page) {
    var buttons = document.querySelectorAll('[data-settings-page]'); var j; var previous = settingsPage;
    var oldEl = byId('settingsPage' + previous); var newEl = byId('settingsPage' + page);
    var animate = previous !== page && currentScreen === 'settings' && !oldEl.className.match(/hidden/) ;
    for (j = 0; j < 3; j += 1) { if (j !== page && !(animate && j === previous)) { toggleClass(byId('settingsPage' + j), 'hidden', true); } toggleClass(buttons[j], 'selected', j === page); }
    removeClass(newEl, 'hidden'); settingsPage = page;
    if (page === 0) { byId('aboutCard').style.height = byId('settingsLeft0').offsetHeight + 'px'; }
    if (page === 1) { renderTimeout(); }
    if (animate) {
      // AnimatedContent: slide by the full width in 260 ms, fade in 180 ms.
      var dir = page > previous ? 1 : -1; var width = newEl.parentNode.clientWidth;
      if (pageTimer) { clearTimeout(pageTimer); }
      addClass(oldEl, 'page-leaving');
      slidePage(newEl, dir * width, 0, false); slidePage(oldEl, 0, 1, false);
      void newEl.offsetWidth;
      slidePage(newEl, 0, 1, true); slidePage(oldEl, -dir * width, 0, true);
      pageTimer = setTimeout(function () { pageTimer = null; addClass(oldEl, 'hidden'); removeClass(oldEl, 'page-leaving'); slidePage(oldEl, 0, '', false); slidePage(newEl, 0, '', false); }, 270);
    }
  }
  function slidePage(el, x, opacity, withTransition) {
    var t = withTransition ? '-webkit-transform 260ms cubic-bezier(.4,0,.2,1), opacity 180ms cubic-bezier(.4,0,.2,1)' : 'none';
    el.style.webkitTransition = t; el.style.transition = t.replace('-webkit-transform', 'transform');
    el.style.webkitTransform = x ? 'translateX(' + x + 'px)' : ''; el.style.transform = el.style.webkitTransform; el.style.opacity = opacity;
  }

  /* First start on a TV: the service is not installed yet, or the package
     carries a newer one. setup/setup.sh installs it as root through the
     Homebrew Channel service (org.webosbrew.hbchannel exec); a TV without
     root has nothing to install it with. */
  var SETUP_TEXT = {
    ru: { installing: 'Устанавливаем службу ToBeVPN…', title: 'Не удалось запустить ToBeVPN', noRoot: 'Для работы нужен телевизор с root-доступом и установленным Homebrew Channel. Инструкция по установке есть на странице приложения.', failed: 'Не удалось установить службу ToBeVPN. Перезагрузите телевизор и откройте приложение ещё раз.' },
    en: { installing: 'Installing the ToBeVPN service…', title: 'ToBeVPN could not start', noRoot: 'ToBeVPN needs a rooted TV with Homebrew Channel installed. See the installation guide on the app page.', failed: 'The ToBeVPN service could not be installed. Restart the TV and open the app again.' }
  };
  function setupText(key) { return (SETUP_TEXT[LANG] || SETUP_TEXT.en)[key]; }
  var setupTried = false;
  function appDir() { return decodeURIComponent(window.location.pathname.replace(/\/[^\/]*$/, '')); }
  function runSetup(done) {
    setupTried = true; text('loadingText', setupText('installing')); showScreen('loading');
    var bridge; var finished = false;
    function end(error) { if (finished) { return; } finished = true; clearTimeout(timer); window.__setupBridge = null; text('loadingText', ''); done(error); }
    var timer = setTimeout(function () { end(new Error(setupText('failed'))); }, 120000);
    try { bridge = new PalmServiceBridge(); } catch (noBridge) { return end(new Error(setupText('noRoot'))); }
    window.__setupBridge = bridge; // keep the bridge alive until it answers
    bridge.onservicecallback = function (raw) {
      var r = {}; try { r = JSON.parse(raw); } catch (ignore) {}
      // The command always exits 0 (Homebrew Channel does not answer a failed
      // one) and prints the script's own exit code.
      if (r.returnValue) { var code = /tobevpn-setup:(\d+)/.exec(r.stdoutString || ''); return end(code && code[1] === '0' ? null : new Error(setupText('failed'))); }
      // No Homebrew Channel service (no root) or a failed script.
      end(new Error(/unknown|not found|does not exist|denied|-1/i.test(String(r.errorText || r.errorCode || '')) && !r.stderrString ? setupText('noRoot') : setupText('failed')));
    };
    bridge.call('luna://org.webosbrew.hbchannel.service/exec', JSON.stringify({ command: 'sh ' + appDir() + '/setup/setup.sh > /tmp/tobevpn-setup.log 2>&1; echo tobevpn-setup:$?' }));
  }
  function loadStatus(initial) {
    request('GET', '/api/status', null, function (error, status) {
      var packaged = window.TOBEVPN_BUILD && window.TOBEVPN_BUILD.service;
      if (initial && !setupTried && (error || (packaged && status && status.versions && status.versions.app !== packaged))) {
        dataReady = true; revealApp();
        return runSetup(function (setupError) { if (setupError) { text('errorTitle', setupText('title')); fail(setupError); } else { loadStatus(true); } });
      }
      if (initial) { dataReady = true; revealApp(); }
      if (error) { if (initial) { text('errorTitle', setupText('title')); fail(error); } return; }
      currentStatus = status;
      if (!status.linked) {
        if (initial || !authScreens[currentScreen]) { openSignIn(); } return;
      }
      renderHome(status);
      if (initial) {
        renderServers();
        measurePings();
        checkUpdateOnce();
        // MainViewModel init: servers and the account sync, then a fresh automatic choice.
        request('POST', '/api/profile', {}, function (e) { if (!e) { loadStatus(false); } ensureAutomaticServerSelected(true); });
        var target = String(window.location.hash || '').replace(/^#/, '');
        if (/^(servers|stats|speed|subscription|settings)$/.test(target)) { navigate(target); } else { showScreen('home'); }
      } else if (currentScreen === 'loading' || currentScreen === 'error' || authScreens[currentScreen]) { stopPairing(); showScreen('home'); }
    });
  }
  /* OnboardingScreen.kt -> MobileAppInstallScreen.kt -> PairingScreen.kt, with PairingViewModel.kt. */
  var authScreens = { onboarding: 1, install: 1, pair: 1 };
  var GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.tobevpn.app';
  var pairing = { entry: 'app', version: 0, timer: null, expirations: 0, state: 'loading', qr: '', code: '', message: '' };
  function onboardingSeen() { try { return window.localStorage.getItem('onboardingSeen') === '1'; } catch (ignore) { return false; } }
  function accented(full, accent) { var i = accent ? full.indexOf(accent) : -1; if (i < 0) { return escapeHtml(full); } return escapeHtml(full.slice(0, i)) + '<em>' + escapeHtml(accent) + '</em>' + escapeHtml(full.slice(i + accent.length)); }
  function openSignIn() { if (!onboardingSeen()) { showScreen('onboarding'); } else { startPairing('app'); } }
  function showInstall() {
    stopPairing();
    html('installTitle', accented(t('mobile_install_title'), t('mobile_install_title_accent')));
    drawQr(byId('installQr'), GOOGLE_PLAY_URL);
    showScreen('install', true); setTimeout(function () { byId('installDone').focus(); }, 60);
  }
  function chooseEntry(entry) { try { window.localStorage.setItem('onboardingSeen', '1'); } catch (ignore) {} startPairing(entry); }
  function stopPairing() { pairing.version += 1; if (pairing.timer) { clearTimeout(pairing.timer); pairing.timer = null; } }
  function startPairing(entry) {
    pairing.entry = entry; pairing.expirations = 0;
    var title = { app: 'pairing_title_app', iphone: 'pairing_title_iphone', nophone: 'pairing_title_telegram' }[entry];
    html('pairTitle', accented(t(title), entry === 'nophone' ? t('pairing_title_telegram_accent') : ''));
    text('pairInstruction', t({ app: 'pairing_instruction_app', iphone: 'pairing_instruction_iphone', nophone: 'pairing_instruction_telegram' }[entry]));
    var telegram = entry !== 'app';
    toggleClass(byId('pairPlate'), 'tg', telegram); toggleClass(byId('tgCaption'), 'hidden', !telegram);
    html('tgCaptionText', accented(t('pairing_open_telegram_bot'), t('pairing_open_telegram_bot_accent')));
    showScreen('pair', true); requestPairCode();
    setTimeout(function () { byId('pairBack').focus(); }, 60);
  }
  function requestPairCode() {
    stopPairing(); var version = pairing.version;
    setPairState('loading');
    var telegram = pairing.entry !== 'app';
    request('POST', telegram ? '/api/telegram/request' : '/api/pair', {}, function (error, result) {
      if (version !== pairing.version) { return; }
      if (error) { return setPairState('error', { message: error.message }); }
      if (telegram) { pairing.qr = 'https://t.me/meow_meow_vpn_bot?start=' + encodeURIComponent(result.auth_token); pairing.code = ''; pollPair(result.auth_token, version, 0); }
      else { pairing.qr = 'tobevpn://pair?code=' + result.code; pairing.code = result.code; pollPair(result.code, version, 0); }
      setPairState('waiting');
    });
  }
  function rotatePairCode() {
    // Idle expirations count across rotations; after five the user retries by hand.
    pairing.expirations += 1;
    if (pairing.expirations >= 5) { return setPairState('error', { message: t('auth_error_server') }); }
    var keep = pairing.expirations; requestPairCode(); pairing.expirations = keep;
  }
  function pollPair(key, version, attempt) {
    pairing.timer = setTimeout(function () {
      if (version !== pairing.version) { return; }
      if (attempt >= 60) { return rotatePairCode(); }
      var path = pairing.entry === 'app' ? '/api/pair/status?code=' + encodeURIComponent(key) : '/api/telegram/status?token=' + encodeURIComponent(key);
      request('GET', path, null, function (error, result) {
        if (version !== pairing.version) { return; }
        if (error) { return setPairState('error', { message: error.message }); }
        if (result.status === 'completed') { stopPairing(); setPairState('success'); loadStatus(true); return; }
        if (result.status === 'expired') { return rotatePairCode(); }
        pollPair(key, version, attempt + 1);
      });
    }, 3000);
  }
  function setPairState(state, extra) {
    pairing.state = state; pairing.message = (extra && extra.message) || '';
    var plate = byId('pairPlate'); var tg = pairing.entry !== 'app'; var spinner = spinnerHtml(80, 8, '#000');
    if (state === 'loading') { plate.innerHTML = spinner; }
    else if (state === 'waiting') { plate.innerHTML = '<canvas width="512" height="512"></canvas>'; drawQr(plate.firstChild, pairing.qr); }
    else if (state === 'success') { plate.innerHTML = '<span class="plate-done">' + escapeHtml(t('pairing_done')) + '</span>'; }
    else if (state === 'error') { plate.innerHTML = '<div class="plate-error"><b>' + escapeHtml(t('error_generic')) + '</b><span>' + escapeHtml(pairing.message || t('auth_error_server')) + '</span></div>'; }
    var chip = byId('pairCodeChip'); toggleClass(chip, 'hidden', !(state === 'waiting' && pairing.code)); text('pairCode', pairing.code);
    var status = state === 'loading' ? t(tg ? 'pairing_loading_telegram' : 'pairing_loading_app') : (state === 'waiting' ? t(tg ? 'pairing_waiting_telegram' : 'pairing_waiting_app') : (state === 'error' ? (pairing.message || t('auth_error_server')) : ''));
    toggleClass(byId('pairStatus'), 'hidden', !status); toggleClass(byId('pairStatus'), 'error', state === 'error'); text('pairStatusText', status);
    var retry = byId('pairRetry'); toggleClass(retry, 'hidden', state !== 'error');
    if (state === 'error' && currentScreen === 'pair') { setTimeout(function () { retry.focus(); }, 30); }
    animateSpinners();
  }
  function showServers() {
    // hiltViewModel(): a fresh ServerListViewModel per visit, so the list shows
    // TCP pings again until the next Refresh, and they are measured right away.
    // Leaving the screen cleared the old ViewModel's scope: whatever was still
    // loading there does not block this visit.
    clearTimeout(profile.hideTimer);
    if (!profile.polling) { profile.enabled = false; profile.measured = false; profile.pings = []; showProbeCard(false); }
    if (!profile.polling) { serversLoading = false; pendingForced = false; loadGeneration += 1; }
    listPings = [];
    var grid = byId('serverGrid'); renderServers(); showScreen('servers'); updateCues(grid);
    refreshServers(false);
  }
  function navigate(name) {
    if (currentStatus) { renderHome(currentStatus); }
    if (name === 'servers') { showServers(); return; }
    showScreen(name);
    if (name === 'stats') { fitHeroGradient(); renderStatsBody(); loadStats(); }
    if (name === 'speed') { openSpeed(); }
    if (name === 'speedHistory') { loadSpeedHistory(renderSpeedHistory); }
    if (parentScreen[name] === 'settings') { returnFocus[name] = document.activeElement; }
    if (name === 'devices') { renderDevices(); loadDevices(); }
    if (name === 'promocodes') { renderPromocodes(); loadPromocodes(); }
    if (name === 'support') { renderSupport(); }
    if (name === 'referrals') { renderReferrals(); loadReferrals(true); }
    if (name === 'appFilter') { renderAppFilter(); }
    if (name === 'subscription') { subFocus.tab = null; subFocus.left = null; renderSubscription(); loadPlans(); }
    if (name === 'settings') { settingsPage = 0; for (var k = 1; k < 3; k += 1) { addClass(byId('settingsPage' + k), 'hidden'); } showSettingsPage(0); }
  }

  function focusables() {
    var dlg = topDialog(); var screen = dlg ? dlg.el : byId(currentScreen + 'Screen'); var all = screen ? screen.querySelectorAll('.focusable') : []; var visible = [];
    for (var i = 0; i < all.length; i += 1) { if (canFocus(all[i])) { visible.push(all[i]); } } return visible;
  }
  function canFocus(el) { return el.offsetWidth > 0 && el.offsetHeight > 0 && !el.disabled; }
  /* TwoDimensionalFocusSearch.kt (compose-ui 1.11). Every scroll container is a
     focus group (Modifier.scrollable adds one), so a key first looks among the
     group's own items, clipped ones included, and only then outside it.
     data-up/-down/-left/-right name the element focusProperties routes to. */
  function isFocusGroup(el) { var c = typeof el.className === 'string' ? el.className : ''; return /(^|\s)scroll-(list|page)(\s|$)/.test(c) || el.hasAttribute('data-focus-group'); }
  function focusTree(root) {
    var top = { el: root, kids: [], parent: null, leaf: false };
    (function walk(el, node) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (c.classList.contains('focusable')) { if (canFocus(c)) { var leaf = { el: c, leaf: true, parent: node, kids: [] }; node.kids.push(leaf); walk(c, leaf); } continue; }
        if (isFocusGroup(c)) { var g = { el: c, kids: [], parent: node, leaf: false }; walk(c, g); if (g.kids.length) { node.kids.push(g); } continue; }
        walk(c, node);
      }
    }(root, top));
    return top;
  }
  function findNode(node, el) { for (var i = 0; i < node.kids.length; i += 1) { var k = node.kids[i]; if (k.el === el) { return k; } var f = findNode(k, el); if (f) { return f; } } return null; }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top }; }
  function beamBeats(source, rect1, rect2, d) {
    function inBeam(r) { return d === 37 || d === 39 ? r.bottom > source.top && r.top < source.bottom : r.right > source.left && r.left < source.right; }
    function inDirection(r) { return d === 37 ? source.left >= r.right : d === 39 ? source.right <= r.left : d === 38 ? source.top >= r.bottom : source.bottom <= r.top; }
    function major(r) { return Math.max(0, d === 37 ? source.left - r.right : d === 39 ? r.left - source.right : d === 38 ? source.top - r.bottom : r.top - source.bottom); }
    function majorFar(r) { return Math.max(1, d === 37 ? source.left - r.left : d === 39 ? r.right - source.right : d === 38 ? source.top - r.top : r.bottom - source.bottom); }
    if (inBeam(rect2) || !inBeam(rect1)) { return false; }
    if (!inDirection(rect2)) { return true; }
    if (d === 37 || d === 39) { return true; }
    return major(rect1) < majorFar(rect2);
  }
  function isBetterCandidate(proposed, current, f, d) {
    function isCandidate(r) {
      if (d === 37) { return (f.right > r.right || f.left >= r.right) && f.left > r.left; }
      if (d === 39) { return (f.left < r.left || f.right <= r.left) && f.right < r.right; }
      if (d === 38) { return (f.bottom > r.bottom || f.top >= r.bottom) && f.top > r.top; }
      return (f.top < r.top || f.bottom <= r.top) && f.bottom < r.bottom;
    }
    function weighted(r) {
      var major = Math.max(0, d === 37 ? f.left - r.right : d === 39 ? r.left - f.right : d === 38 ? f.top - r.bottom : r.top - f.bottom);
      var minor = d === 37 || d === 39 ? (f.top + f.height / 2) - (r.top + r.height / 2) : (f.left + f.width / 2) - (r.left + r.width / 2);
      major = Math.floor(major); minor = minor < 0 ? Math.ceil(minor) : Math.floor(minor);
      return 13 * major * major + minor * minor;
    }
    if (!isCandidate(proposed)) { return false; }
    if (!isCandidate(current)) { return true; }
    if (beamBeats(f, proposed, current, d)) { return true; }
    if (beamBeats(f, current, proposed, d)) { return false; }
    return weighted(proposed) < weighted(current);
  }
  function bestCandidate(nodes, f, d) {
    var best = d === 37 ? { left: f.left + f.width + 1, right: f.right + f.width + 1, top: f.top, bottom: f.bottom } : d === 39 ? { left: f.left - f.width - 1, right: f.right - f.width - 1, top: f.top, bottom: f.bottom } : d === 38 ? { left: f.left, right: f.right, top: f.top + f.height + 1, bottom: f.bottom + f.height + 1 } : { left: f.left, right: f.right, top: f.top - f.height - 1, bottom: f.bottom - f.height - 1 };
    best.width = best.right - best.left; best.height = best.bottom - best.top;
    var found = null;
    for (var i = 0; i < nodes.length; i += 1) { var r = rectOf(nodes[i].el); if (isBetterCandidate(r, best, f, d)) { best = r; found = nodes[i]; } }
    return found;
  }
  function searchChildren(node, f, d) {
    var kids = node.kids.slice();
    while (kids.length) {
      var next = bestCandidate(kids, f, d); if (!next) { return null; }
      if (next.leaf) { return next.el; }
      var hit = searchChildren(next, f, d); if (hit) { return hit; }
      kids.splice(kids.indexOf(next), 1);
    }
    return null;
  }
  var routeAttr = { 37: 'data-left', 38: 'data-up', 39: 'data-right', 40: 'data-down' };
  function moveFocus(key) {
    var dlg = topDialog(); var root = dlg ? dlg.el : byId(currentScreen + 'Screen'); if (!root) { return; }
    var current = document.activeElement;
    var tree = focusTree(root); var node = current && current !== document.body ? findNode(tree, current) : null;
    if (!node) { var first = focusables()[0]; if (first) { focusEl(first); } return; }
    var route = current.getAttribute(routeAttr[key]);
    if (route) {
      var ids = route.split(' ');
      for (var j = 0; j < ids.length; j += 1) { if (ids[j] === 'cancel') { return; } var target = byId(ids[j]); if (target && canFocus(target)) { focusEl(target); return; } }
    }
    var f = rectOf(current);
    for (var g = node.parent; g; g = g.parent) { var hit = searchChildren(g, f, key); if (hit) { focusEl(hit); return; } }
  }
  /* Focus without the browser's own jump: scroll containers then glide to the
     item the way ContentInViewNode does (keepVisible). */
  function focusEl(el) {
    var saved = [];
    for (var p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) { if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) { p.__pre = p.scrollTop; saved.push([p, p.scrollTop, p.scrollLeft]); } }
    el.focus();
    for (var i = 0; i < saved.length; i += 1) {
      var box = saved[i][0];
      if (!(box.__sid && scrollAnims[box.__sid])) { if (isFocusGroup(box)) { keepVisible(box, el); } else { box.scrollTop = saved[i][1]; box.scrollLeft = saved[i][2]; } }
      box.__pre = null;
    }
  }
  function goBack() {
    var parent = parentScreen[currentScreen];
    if (parent) { var from = currentScreen; showScreen(parent, true); var f = returnFocus[from]; setTimeout(function () { if (f && document.body.contains(f)) { f.focus(); } else { focusFirst(parent + 'Screen'); } }, 60); return; }
    if (currentScreen === 'pair') { showInstall(); return; }
    if (currentScreen !== 'home' && currentScreen !== 'loading' && !authScreens[currentScreen] && currentScreen !== 'error') { showScreen('home'); return; }
    if (window.webOS && window.webOS.platformBack) { window.webOS.platformBack(); } else { window.close(); }
  }
  /* ---------- Modal dialogs: focus stays inside, Back closes the top one ---------- */
  var dialogStack = [];
  function openDialog(html, options) {
    options = options || {};
    var layer = byId('modalLayer'); var scrim = document.createElement('div');
    scrim.className = 'scrim' + (options.soft ? ' soft' : '') + (options.bottom ? ' bottom' : '');
    scrim.innerHTML = html; layer.appendChild(scrim); removeClass(layer, 'hidden');
    var entry = { el: scrim, onClose: options.onClose, returnFocus: document.activeElement, onKey: options.onKey, modal: !!options.modal };
    dialogStack.push(entry);
    animateSpinners();
    setTimeout(function () { var f = options.focus ? scrim.querySelector(options.focus) : scrim.querySelector('.focusable'); if (f) { f.focus(); } }, 32);
    return scrim;
  }
  function closeDialog() {
    var entry = dialogStack.pop(); if (!entry) { return; }
    entry.el.parentNode.removeChild(entry.el);
    if (!dialogStack.length) { addClass(byId('modalLayer'), 'hidden'); }
    if (entry.returnFocus && entry.returnFocus.focus && document.body.contains(entry.returnFocus)) { entry.returnFocus.focus(); }
    if (entry.onClose) { entry.onClose(); }
  }
  function closeDialogEl(el) {
    for (var i = dialogStack.length - 1; i >= 0; i -= 1) {
      if (dialogStack[i].el === el) { if (i === dialogStack.length - 1) { closeDialog(); } else { var entry = dialogStack.splice(i, 1)[0]; el.parentNode.removeChild(el); if (entry.onClose) { entry.onClose(); } } return; }
    }
  }
  function topDialog() { return dialogStack.length ? dialogStack[dialogStack.length - 1] : null; }

  /* TvConfirmationDialog.kt: the safe action is focused first. */
  function confirmDialog(o) {
    var el = openDialog('<div class="confirm-card' + (o.centered ? ' centered' : '') + '"><h2>' + escapeHtml(o.title) + '</h2><p>' + escapeHtml(o.message) + '</p><div class="confirm-row"><button class="confirm-btn cancel focusable">' + escapeHtml(o.cancel || t('cancel')) + '</button><button class="confirm-btn ok focusable' + (o.destructive ? ' danger' : '') + '">' + escapeHtml(o.confirm) + '</button></div></div>', { focus: '.cancel' });
    el.querySelector('.cancel').onclick = closeDialog;
    el.querySelector('.ok').onclick = function () { closeDialog(); o.onConfirm(); };
    fitText(el.querySelector('.ok'), 30, 24);
  }
  function fitText(el, max, min) { var size = max; el.style.fontSize = size + 'px'; while (size > min && el.scrollWidth > el.clientWidth + 1) { size -= 1; el.style.fontSize = size + 'px'; } }

  /* WhatsNewDialog.kt: the 1.0.35 highlights of the Android TV build. */
  var whatsNew = [['i-route', 'whats_new_final_mask_v1036'], ['i-memory', 'whats_new_xray_core_v1036']];
  function showWhatsNew() {
    var items = ''; var i;
    for (i = 0; i < whatsNew.length; i += 1) { items += '<div class="wn-item"><span class="wn-item-icon"><svg><use xlink:href="#' + whatsNew[i][0] + '"></use></svg></span><span class="wn-item-copy"><b>' + escapeHtml(t(whatsNew[i][1] + '_title')) + '</b><span>' + escapeHtml(t(whatsNew[i][1] + '_desc')) + '</span></span></div>'; }
    var version = (currentStatus && currentStatus.versions && currentStatus.versions.app) || '1.0.35-tv';
    var el = openDialog('<div class="wn-card"><div class="wn-inner"><span class="wn-badge"><svg><use xlink:href="#i-sparkle"></use></svg></span><span class="wn-title">' + escapeHtml(t('whats_new_title')) + '</span><span class="wn-pill">' + escapeHtml(t('whats_new_version', version)) + '</span><span class="wn-intro">' + escapeHtml(t('whats_new_intro')) + '</span><div class="wn-list-box"><div class="wn-list scroll-list" tabindex="-1" style="outline:0">' + items + '</div><span class="scroll-fade top"></span><span class="scroll-fade bottom"></span><svg class="scroll-cue top"><use xlink:href="#i-arrow-up"></use></svg><svg class="scroll-cue bottom"><use xlink:href="#i-arrow-down"></use></svg></div><button class="wn-done focusable">' + escapeHtml(t('whats_new_done')) + '</button></div><button class="wn-close focusable"><svg><use xlink:href="#i-close"></use></svg></button></div>', {
      soft: true, focus: '.wn-done',
      onKey: function (key) {
        // WhatsNewDialog.kt: Done -Up-> highlights; the highlights scroll 120 dp
        // per press and hand focus to Close / Done at their ends; Close -Down-> highlights.
        var dlg = topDialog().el; var list = dlg.querySelector('.wn-list'); var active = document.activeElement;
        var max = Math.max(0, list.scrollHeight - list.clientHeight); var anim = list.__sid && scrollAnims[list.__sid]; var pos = anim ? anim.target : list.scrollTop;
        if (active === list) {
          if (key === 40) { if (pos < max - 0.5) { springScroll(list, Math.min(max, pos + 240)); } else { dlg.querySelector('.wn-done').focus(); } return true; }
          if (key === 38) { if (pos > 0.5) { springScroll(list, Math.max(0, pos - 240)); } else { dlg.querySelector('.wn-close').focus(); } return true; }
          return true;
        }
        if ((key === 38 && active === dlg.querySelector('.wn-done')) || (key === 40 && active === dlg.querySelector('.wn-close'))) { list.focus(); return true; }
        return false;
      }
    });
    el.querySelector('.wn-done').onclick = closeDialog; el.querySelector('.wn-close').onclick = closeDialog;
    updateCues(el.querySelector('.wn-list'));
    setTimeout(function () { addClass(el.querySelector('.wn-card'), 'in'); }, 16);
  }


  /* UpdateViewModel.kt + SettingsUpdateCheckRow.kt + UpdateBanner.kt (the
     direct GitHub build): the service checks the same releases and installs
     the .ipk; this side shows the status line and the modal update cards. */
  var upd = { state: 'idle', info: null, downloaded: 0, error: '', inFlight: false, checked: false, dialog: null, kind: null, timer: null };
  function appVersion() { return (currentStatus && currentStatus.versions && currentStatus.versions.app) || '1.0.35-tv'; }
  function renderUpdateRow() {
    var label = byId('settingsVersion'); var button = document.querySelector('#settingsScreen .check-button');
    if (label) { label.textContent = upd.state === 'available' && upd.info ? t('update_available_short', appVersion(), upd.info.version) : t('update_check_uptodate', appVersion()); }
    if (button) { button.innerHTML = (upd.inFlight ? spinnerHtml(32, 4, 'currentColor') + '<span style="margin-left:16px">' : '<span>') + escapeHtml(t('update_check_button')) + '</span>'; animateSpinners(); }
  }
  function applyUpdate(snapshot) {
    upd.state = snapshot.state; upd.info = snapshot.info; upd.downloaded = snapshot.downloaded || 0; upd.error = snapshot.error || '';
    renderUpdateRow(); renderUpdateDialog();
  }
  function updateCall(method, path, body, done) { request(method, path, body, function (error, result) { if (!error && result && result.state) { applyUpdate(result); } if (done) { done(error); } }); }
  function checkUpdateOnce() { if (upd.checked) { return; } upd.checked = true; updateCall('POST', '/api/update/check', { force: false }); }
  function forceUpdateCheck() {
    if (upd.inFlight) { return; }
    upd.inFlight = true; renderUpdateRow();
    updateCall('POST', '/api/update/check', { force: true }, function () { upd.inFlight = false; renderUpdateRow(); });
  }
  function megabytes(bytes) { var v = (bytes / 1048576).toFixed(1); return LANG === 'ru' ? v.replace('.', ',') : v; }
  function updateProgressText() { var total = upd.info ? upd.info.size : 0; return total > 0 ? t('update_banner_progress_of', megabytes(upd.downloaded), megabytes(total)) : t('update_banner_progress', megabytes(upd.downloaded)); }
  function updateButton(cls, key, action) { return '<button class="upd-btn ' + cls + ' focusable" data-action="' + action + '">' + escapeHtml(t(key)) + '</button>'; }
  function updateCardHtml(kind) {
    var v = upd.info.version;
    if (kind === 'available') { return '<h2 class="upd-title">' + escapeHtml(t('update_banner_title', v)) + '</h2><div class="upd-actions">' + updateButton('text', 'update_banner_later', 'dismiss') + updateButton('primary', 'update_banner_download', 'download') + '</div>'; }
    if (kind === 'downloading') { return '<h2 class="upd-title">' + escapeHtml(t('update_banner_downloading_title', v)) + '</h2><div class="upd-progress"><i class="upd-track"></i><i class="upd-bar"></i><i class="upd-stop"></i></div><div class="upd-progress-text"></div><div class="upd-actions tight">' + updateButton('text', 'update_banner_cancel', 'dismiss') + '</div>'; }
    if (kind === 'ready') { return '<h2 class="upd-title">' + escapeHtml(t('update_banner_ready_title', v)) + '</h2><p class="upd-desc">' + escapeHtml(t('update_banner_ready_description')) + '</p><div class="upd-actions">' + updateButton('text', 'update_banner_later', 'dismiss') + updateButton('primary', 'update_banner_install', 'install') + '</div>'; }
    return '<h2 class="upd-title">' + escapeHtml(t('update_banner_failed_title')) + '</h2>' + (upd.error ? '<p class="upd-desc">' + escapeHtml(upd.error) + '</p>' : '') + '<div class="upd-actions">' + updateButton('text', 'update_banner_later', 'dismiss') + updateButton('outlined', 'update_banner_retry', 'retry') + '</div>';
  }
  function renderUpdateDialog() {
    clearTimeout(upd.timer);
    var kind = upd.state === 'installing' ? 'ready' : upd.state;
    if (kind === 'idle' || !upd.info) { if (upd.dialog) { closeDialogEl(upd.dialog); } return; }
    if (!upd.dialog) { upd.dialog = openDialog('<div class="upd-card"></div>', { soft: true, modal: true, onClose: function () { upd.dialog = null; upd.kind = null; } }); }
    var card = upd.dialog.querySelector('.upd-card');
    if (upd.kind !== kind) {
      upd.kind = kind; card.innerHTML = updateCardHtml(kind);
      var buttons = card.querySelectorAll('.upd-btn');
      for (var i = 0; i < buttons.length; i += 1) { buttons[i].onclick = function () { var action = this.getAttribute('data-action'); if (upd.state === 'installing') { return; } updateCall('POST', '/api/update/' + action, {}); }; }
      // Download / Install / Retry (Cancel while downloading) take focus.
      setTimeout(function () { var b = card.querySelectorAll('.upd-btn'); if (b.length) { b[b.length - 1].focus(); } }, 40);
    }
    if (kind === 'downloading') {
      var total = upd.info.size || 0; var fraction = total > 0 ? Math.max(0, Math.min(1, upd.downloaded / total)) : 0;
      card.querySelector('.upd-bar').style.width = (fraction * 100) + '%';
      card.querySelector('.upd-track').style.left = fraction > 0 ? 'calc(' + (fraction * 100) + '% + 8px)' : '0';
      card.querySelector('.upd-progress-text').textContent = updateProgressText();
    }
    if (upd.state === 'installing') { var install = card.querySelector('[data-action="install"]'); if (install && !install.querySelector('svg')) { install.innerHTML = spinnerHtml(32, 4, 'currentColor') + '<span style="margin-left:16px">' + escapeHtml(t('update_banner_install')) + '</span>'; animateSpinners(); } }
    if (upd.state === 'downloading' || upd.state === 'installing') { upd.timer = setTimeout(function () { updateCall('GET', '/api/update', null); }, 500); }
  }

  /* SettingsScreen.kt actions */
  function settingsActions() {
    var page0 = byId('settingsPage0'); var page1 = byId('settingsPage1'); var page2 = byId('settingsPage2');
    page0.querySelector('.action-button').onclick = function () {
      confirmDialog({ title: t('logout_confirm_title'), message: t('logout_confirm_message'), confirm: t('logout'), destructive: true, centered: true, onConfirm: function () {
        request('POST', '/api/logout', {}, function () { currentStatus = null; pings = []; pingsMeasured = false; profile.enabled = false; profile.measured = false; profile.pings = []; byId('serverGrid').innerHTML = ''; loadStatus(true); });
      } });
    };
    var langs = page0.querySelectorAll('.choice-chip'); var i;
    for (i = 0; i < langs.length; i += 1) {
      (function (lang, chip) {
        toggleClass(chip, 'selected', lang === LANG);
        chip.onclick = function () {
          if (lang === LANG) { return; }
          confirmDialog({ title: t('language_restart_title'), message: t('language_restart_message'), confirm: t('language_restart_button'), centered: true, onConfirm: function () {
            try { window.localStorage.setItem('language', lang); } catch (ignore) {}
            window.location.reload();
          } });
        };
      }(i === 0 ? 'en' : 'ru', langs[i]));
    }
    page0.querySelector('.whats-new').onclick = showWhatsNew;
    page0.querySelector('.check-button').onclick = forceUpdateCheck;
    var cards1 = page1.querySelectorAll('.action-button');
    cards1[0].onclick = function () { navigate('appFilter'); };
    cards1[1].onclick = function () { navigate('support'); };
    cards1[2].onclick = function () { navigate('referrals'); };
    var cards2 = page2.querySelectorAll('.action-button');
    cards2[0].onclick = function () { navigate('promocodes'); };
    cards2[1].onclick = function () { navigate('devices'); };
    var themes = page2.querySelectorAll('.choice-chip');
    for (i = 0; i < themes.length; i += 1) {
      (function (mode, chip) { chip.onclick = function () { setTheme(mode); }; }(i === 0 ? 'dark' : 'light', themes[i]));
    }
    refreshThemeChips();
  }
  var THEME = (function () { var saved = null; try { saved = window.localStorage.getItem('theme'); } catch (ignore) {} return saved === 'light' ? 'light' : 'dark'; }());
  function setTheme(mode) {
    THEME = mode; try { window.localStorage.setItem('theme', mode); } catch (ignore) {}
    toggleClass(document.body, 'light', mode === 'light'); refreshThemeChips();
    if (currentScreen === 'stats') { renderStatsBody(); }
  }
  function refreshThemeChips() { var themes = byId('settingsPage2').querySelectorAll('.choice-chip'); toggleClass(themes[0], 'selected', THEME === 'dark'); toggleClass(themes[1], 'selected', THEME === 'light'); }

  /* Bot API through the service: answers with {status, body, retry_after}. */
  function bot(method, path, body, done) {
    request('POST', '/api/bot', { method: method, path: path, body: body || null }, function (error, result) {
      if (error) { return done({ network: true }); }
      done(null, result);
    });
  }
  function headerHtml(titleKey, refreshId) {
    return '<header class="screen-header"><button class="header-icon focusable back-button"><svg><use xlink:href="#i-back"></use></svg></button><h1 class="grow">' + escapeHtml(t(titleKey)) + '</h1>' + (refreshId ? '<button id="' + refreshId + '" class="header-icon refresh-button focusable"><svg viewBox="0 0 24 24"><path d="M23 4V10H17M1 20V14H7M3.51 9C4.95 5.35 8.58 3.04 12.55 3.05C14.92 3.05 17.16 4.03 18.36 5.64L23 10M1 14L5.64 18.36C7.38 20.05 9.86 20.99 12.45 20.95C15.92 20.9 19.03 18.75 20.49 15"/></svg></button>' : '') + '</header>';
  }
  function bindBack(root) { var backs = root.querySelectorAll('.back-button'); for (var i = 0; i < backs.length; i += 1) { backs[i].onclick = function () { goBack(); }; } }
  function minDelay(started, fn) { var wait = 900 - (now() - started); if (started && wait > 0) { setTimeout(fn, wait); } else { fn(); } }

  /* DevicesScreen.kt and DevicesViewModel.kt */
  var devices = { loading: false, data: null, error: null, busy: null };
  function deviceKind(d) {
    var type = String(d.device_type || '').toLowerCase(); var platform = String(d.platform || '').toLowerCase(); var ua = String(d.user_agent || '').toLowerCase();
    if (type === 'tv' || platform === 'android tv' || ua.indexOf('/androidtv/') >= 0) { return 'tv'; }
    if (type === 'desktop' || platform === 'linux' || platform === 'windows' || platform === 'macos' || ua.indexOf('/linux/') >= 0 || ua.indexOf('/windows/') >= 0 || ua.indexOf('/macos/') >= 0) { return 'desktop'; }
    return 'phone';
  }
  function deviceTypeLabel(d) { return t({ tv: 'devices_type_tv', desktop: 'devices_type_desktop', phone: 'devices_type_phone' }[deviceKind(d)]); }
  function deviceTitle(d) {
    var kind = deviceKind(d);
    if (kind === 'desktop') {
      var name = String(d.device_name || '').replace(/^\s+|\s+$/g, '');
      if (name && !(/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name) && name === name.toLowerCase())) { return name; }
      var model = String(d.device_model || '').replace(/^\s+|\s+$/g, ''); var nm = model.toLowerCase(); var np = String(d.platform || '').replace(/^\s+|\s+$/g, '').toLowerCase();
      if (model && nm !== 'desktop' && nm !== 'pc' && nm !== np) { return model; }
      var pl = String(d.platform || '').replace(/^\s+|\s+$/g, '');
      return pl ? t('devices_type_desktop') + ' ' + pl : t('devices_type_desktop');
    }
    return d.device_name || d.device_model || deviceTypeLabel(d);
  }
  function deviceIcon(d) { return { tv: 'i-tv', desktop: 'i-computer', phone: 'i-phone' }[deviceKind(d)]; }
  function loadDevices() {
    if (devices.loading) { return; }
    var started = devices.data ? now() : 0; devices.loading = true; devices.error = null; renderDevices();
    bot('GET', 'api/devices', null, function (error, r) {
      minDelay(started, function () {
        devices.loading = false;
        if (error) { devices.error = t('devices_load_error'); }
        else if (r.status < 300 && r.body && r.body.success && r.body.data) { devices.data = r.body.data; devices.self = r.device_id; }
        else { devices.error = (r.body && r.body.message) || t('devices_load_error'); }
        renderDevices();
      });
    });
  }
  function renderDevices() {
    var page = byId('devicesPage'); var d = devices.data || { devices: [], max_devices: 5 }; var self = String(devices.self || '').toLowerCase();
    var list = d.devices || []; var current = null; var others = []; var i;
    for (i = 0; i < list.length; i += 1) { var dev = list[i]; var mine = self && (String(dev.device_id || '').toLowerCase() === self || String(dev.hwid || '').toLowerCase() === self); if (mine && !current) { current = dev; } else { others.push(dev); } }
    var count = d.current_count != null ? d.current_count : list.length; var max = d.max_devices || 0;
    var focusedId = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-device') : null;
    var out = headerHtml('devices_title', 'devRefresh');
    out += '<div class="dev-counter"><b>' + (max === 0 ? count : count + '/' + max) + '</b><span>' + escapeHtml(t(max === 0 ? 'devices_count_unlimited' : 'devices_count')) + '</span></div>';
    if (devices.error) { out += '<div class="dev-error">' + escapeHtml(devices.error) + '</div>'; }
    function placeholder(isCurrent) { return '<div class="dev-card skeleton"><span class="ph" style="width:56px;height:56px;border-radius:14px"></span><span class="dev-ph-lines"><span class="ph" style="width:48%;height:34px"></span><span class="ph" style="width:34%;height:26px"></span></span><span class="ph" style="width:' + (isCurrent ? 148 : 208) + 'px;height:' + (isCurrent ? 30 : 68) + 'px;border-radius:20px"></span></div>'; }
    if (devices.loading) { out += '<span class="dev-section">' + escapeHtml(t('devices_this_device')) + '</span>' + placeholder(true); }
    else if (current) { out += '<span class="dev-section">' + escapeHtml(t('devices_this_device')) + '</span>' + deviceCard(current, true); }
    out += '<span class="dev-section">' + escapeHtml(t('devices_other_devices')) + '</span>';
    if (devices.loading) { var n = Math.max(2, Math.min(3, others.length)); for (i = 0; i < n; i += 1) { out += placeholder(false); } }
    else if (!others.length) { out += '<div class="dev-empty">' + escapeHtml(t('devices_empty')) + '</div>'; }
    else { for (i = 0; i < others.length; i += 1) { out += deviceCard(others[i], false); } }
    page.innerHTML = '<div class="scroll-inner">' + out + '</div>';
    bindBack(page);
    var refresh = byId('devRefresh'); toggleClass(refresh, 'rotating', devices.loading); refresh.onclick = function () { if (!devices.loading) { loadDevices(); } };
    var buttons = page.querySelectorAll('.dev-unlink');
    // DevicesScreen.kt focusProperties: header -> first device, devices chain up/down.
    var devBack = page.querySelector('.back-button'); devBack.id = 'devBack';
    for (var b = 0; b < buttons.length; b += 1) { buttons[b].id = 'devUnlink' + b; if (b > 0) { buttons[b].setAttribute('data-up', 'devUnlink' + (b - 1)); } if (b < buttons.length - 1) { buttons[b].setAttribute('data-down', 'devUnlink' + (b + 1)); } }
    devBack.setAttribute('data-right', 'devRefresh'); devBack.setAttribute('data-down', buttons.length ? 'devUnlink0' : 'devRefresh');
    refresh.setAttribute('data-left', 'devBack'); refresh.setAttribute('data-down', buttons.length ? 'devUnlink0' : 'devBack');
    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].onclick = function () {
        var id = this.getAttribute('data-device'); if (devices.loading || devices.busy) { return; }
        devices.busy = id; renderDevices();
        bot('POST', 'api/device/unlink', { device_id: id }, function (error, r) {
          devices.busy = null;
          if (error || !(r.status < 300 && r.body && r.body.success)) { devices.error = (r && r.body && r.body.message) || t('error_devices_disconnect'); }
          loadDevices();
        });
      };
      buttons[i].onfocus = function () { keepVisible(page, this.parentNode); };
    }
    if (focusedId) { var again = page.querySelector('[data-device="' + focusedId + '"]'); if (again) { again.focus(); } }
    if (currentScreen === 'devices' && (!document.activeElement || document.activeElement === document.body)) { var first = page.querySelector('.focusable'); if (first) { first.focus(); } }
    updateCues(page); animateSpinners();
  }
  function deviceCard(d, isCurrent) {
    var meta = deviceTypeLabel(d) + (d.platform ? ' · ' + d.platform : '');
    var busy = devices.busy === d.device_id;
    return '<div class="dev-card' + (isCurrent ? ' current' : '') + '"><svg><use xlink:href="#' + deviceIcon(d) + '"></use></svg><span class="dev-copy"><b>' + escapeHtml(deviceTitle(d)) + '</b><span>' + escapeHtml(meta) + '</span></span>' +
      (isCurrent ? '<span class="dev-badge">' + escapeHtml(t('devices_current_badge')) + '</span>' : '<button class="dev-unlink focusable" data-device="' + escapeHtml(d.device_id) + '">' + (busy ? spinnerHtml(32, 4, '#f2b8b5') : escapeHtml(t('devices_disconnect'))) + '</button>') + '</div>';
  }

  /* PromocodesScreen.kt and PromocodesViewModel.kt */
  var promo = { loading: false, history: null, discount: 0, activating: false, error: null, success: false, code: '' };
  function loadPromocodes() {
    if (promo.loading) { return; }
    var started = promo.history ? now() : 0; promo.loading = true; renderPromocodes();
    var left = 2; var history = null; var discount = 0; var failed = false;
    function finish() { left -= 1; if (left) { return; } minDelay(started, function () { promo.loading = false; if (!failed) { promo.history = history; promo.discount = discount; } renderPromocodes(); }); }
    bot('GET', 'api/user/promocodes?limit=50&offset=0', null, function (error, r) {
      if (!error && r.status < 300 && r.body && r.body.success) { history = r.body.data || { total: 0, promocodes: [] }; } else { failed = true; }
      finish();
    });
    request('GET', '/api/plans', null, function (error, plans) { if (!error && plans) { discount = Math.max(0, Math.min(100, Number(plans.effective_discount_percent) || 0)); } finish(); });
  }
  function promoErrorKey(r) {
    if (!r) { return 'promocodes_activation_error_network'; }
    var detail = (r.body && r.body.detail) || {}; var code = String(detail.code || '').toUpperCase(); var message = String(detail.message || '').toLowerCase(); var s = r.status;
    if (s === 401 || s === 403 || code === 'USER_NOT_FOUND') { return 'promocodes_activation_error_auth'; }
    if (s === 429) { return 'promocodes_activation_error_too_many'; }
    if (code === 'PROMOCODE_NOT_FOUND' || s === 404) { return 'promocodes_activation_error_not_found'; }
    if (code === 'PROMOCODE_EXPIRED') { return 'promocodes_activation_error_expired'; }
    if (code === 'PROMOCODE_ALREADY_ACTIVATED') { return 'promocodes_activation_error_already_activated'; }
    if (code === 'PROMOCODE_NOT_AVAILABLE') { return 'promocodes_activation_error_not_available'; }
    return 'promocodes_activation_error_not_available';
  }
  function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function activatePromocode() {
    var code = promo.code.replace(/^\s+|\s+$/g, '').toUpperCase();
    if (!code || promo.activating) { return; }
    promo.activating = true; promo.error = null; promo.success = false; renderPromocodes();
    bot('POST', 'api/user/promocodes/activate', { code: code, request_id: uuid() }, function (error, r) {
      promo.activating = false;
      if (!error && r.status < 300 && r.body && r.body.success) { promo.success = true; promo.code = ''; renderPromocodes(); loadPromocodes(); return; }
      promo.error = promoErrorKey(error ? null : r); renderPromocodes();
    });
  }
  function rewardText(item) {
    var reward = Number(item.reward) || 0;
    var key = { PERSONAL_DISCOUNT: 'promocodes_reward_personal_discount', PURCHASE_DISCOUNT: 'promocodes_reward_purchase_discount', TRAFFIC: 'promocodes_reward_traffic', DEVICES: 'promocodes_reward_devices', DURATION: 'promocodes_reward_duration_days' }[String(item.reward_type || '').toUpperCase()];
    return key ? t(key, reward) : t('promocodes_reward_applied');
  }
  function renderPromocodes() {
    var body = byId('promoBody'); var linked = currentStatus && currentStatus.linked; var initial = promo.loading && !promo.history; var i;
    var focusedSel = document.activeElement && document.activeElement.id === 'promoInput' ? '#promoInput' : (document.activeElement && document.activeElement.id === 'promoApply' ? '#promoApply' : null);
    toggleClass(byId('promoRefresh'), 'hidden', initial); toggleClass(byId('promoRefresh'), 'rotating', promo.loading);
    if (initial) { body.innerHTML = '<div class="center-message">' + loaderHtml() + '</div>'; runInlineLoaders(); return; }
    if (!linked) { body.innerHTML = '<div class="center-message">' + escapeHtml(t('promocodes_auth_description')) + '</div>'; return; }
    var refreshing = promo.loading && promo.history;
    var left = '<div class="promo-col"><div class="promo-head"><svg><use xlink:href="#i-offer"></use></svg><b>' + escapeHtml(t('promocodes_activate_title')) + '</b></div><div class="promo-desc">' + escapeHtml(t('promocodes_activate_description')) + '</div>' +
      '<div id="promoField" class="promo-field' + (promo.code ? ' filled' : '') + '"><svg><use xlink:href="#i-offer"></use></svg><label>' + escapeHtml(t('promocodes_code_label')) + '</label><input id="promoInput" class="focusable" data-up="pBack" data-down="promoApply" type="text" maxlength="64" value="' + escapeHtml(promo.code) + '"' + (promo.activating ? ' disabled' : '') + '></div>' +
      (promo.error ? '<div class="promo-error">' + escapeHtml(t(promo.error)) + '</div>' : '') +
      '<button id="promoApply" class="promo-apply focusable" data-up="promoInput"' + (!promo.code.replace(/\s/g, '') || promo.activating ? ' disabled' : '') + '>' + (promo.activating ? spinnerHtml(36, 4, 'currentColor') + '<span style="margin-left:16px">' + escapeHtml(t('promocodes_activating')) + '</span>' : escapeHtml(t('promocodes_activate_button'))) + '</button>' +
      (refreshing && promo.discount > 0 ? '<div class="promo-discount skeleton"><span class="ph" style="width:50px;height:50px;border-radius:14px"></span><span class="ph" style="flex:1;height:32px;margin:0 20px 0 18px"></span><span class="ph" style="width:108px;height:50px;border-radius:99px"></span></div>' : (promo.discount > 0 ? '<div class="promo-discount"><svg><use xlink:href="#i-percent"></use></svg><span>' + escapeHtml(t('promocodes_current_discount_title')) + '</span><b>−' + promo.discount + '%</b></div>' : '')) +
      (promo.success ? '<div class="promo-success">' + escapeHtml(t('promocodes_success_description')) + '</div>' : '') + '</div>';
    var h = promo.history || { total: 0, promocodes: [] }; var items = h.promocodes || []; var right;
    if (refreshing) {
      right = '<div class="promo-col"><div class="skeleton" style="display:flex;align-items:center"><span class="ph" style="width:48px;height:48px;border-radius:14px"></span><span class="ph" style="width:356px;height:42px;margin-left:18px"></span><span style="flex:1"></span><span class="ph" style="width:56px;height:34px"></span></div><div style="margin-top:20px">';
      for (i = 0; i < 3; i += 1) { right += '<div class="promo-item skeleton" style="margin-bottom:20px"><span class="ph" style="width:56px;height:56px;border-radius:16px"></span><span style="flex:1;margin-left:20px"><span class="ph" style="width:52%;height:34px"></span><span class="ph" style="width:76%;height:28px;margin-top:14px"></span><span class="ph" style="width:38%;height:24px;margin-top:14px"></span></span></div>'; }
      right += '</div></div>';
    } else {
      right = '<div class="promo-col"><div class="promo-head history"><svg><use xlink:href="#i-history"></use></svg><b>' + escapeHtml(t('promocodes_history_title')) + '</b><span>' + (h.total || 0) + '</span></div>';
      if (!items.length) { right += '<div class="promo-empty">' + escapeHtml(t('promocodes_empty_description')) + '</div>'; }
      else {
        right += '<div class="promo-list-box"><div id="promoList" class="scroll-list promo-list">';
        for (i = 0; i < items.length; i += 1) {
          var it = items[i]; var date = it.activated_at ? parseDate(it.activated_at) : null;
          right += '<div class="promo-item focusable" tabindex="0"><svg><use xlink:href="#i-offer"></use></svg><span class="promo-item-copy"><b>' + escapeHtml(it.code || t('promocodes_unknown_code')) + '</b><span>' + escapeHtml(rewardText(it)) + '</span>' + (date ? '<span>' + formatDate(date) + '</span>' : '') + '</span></div>';
        }
        right += '</div><span class="scroll-fade top"></span><span class="scroll-fade bottom"></span><svg class="scroll-cue top"><use xlink:href="#i-arrow-up"></use></svg><svg class="scroll-cue bottom"><use xlink:href="#i-arrow-down"></use></svg></div>';
      }
      right += '</div>';
    }
    body.innerHTML = left + right;
    var input = byId('promoInput'); var field = byId('promoField');
    input.onfocus = function () { addClass(field, 'focused'); }; input.onblur = function () { removeClass(field, 'focused'); };
    input.oninput = function () { promo.code = input.value.replace(/[\r\n]/g, '').slice(0, 64); promo.error = null; promo.success = false; toggleClass(field, 'filled', !!promo.code); byId('promoApply').disabled = !promo.code.replace(/\s/g, ''); };
    input.onkeydown = function (e) { if (e.keyCode === 13 && promo.code.replace(/\s/g, '')) { e.preventDefault(); input.blur(); activatePromocode(); } };
    byId('promoApply').onclick = activatePromocode;
    var list = byId('promoList');
    if (list) { var rows = list.getElementsByClassName('promo-item'); for (i = 0; i < rows.length; i += 1) { rows[i].onfocus = function () { keepVisible(list, this); }; } updateCues(list); }
    if (focusedSel) { var f = body.querySelector(focusedSel); if (f && !f.disabled) { f.focus(); } }
    animateSpinners();
  }
  function loaderHtml() { return '<div class="brand-loader inline-loader"><svg class="loader-ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="39" fill="none" stroke="rgba(127,127,127,.18)" stroke-width="3"/><g class="loader-arc"><circle cx="42" cy="42" r="39" fill="none" stroke="url(#ring-gradient)" stroke-width="3" stroke-linecap="round" stroke-dasharray="150 245"/></g></svg><div class="loader-shield"><span class="loader-glow"></span><svg viewBox="0 0 2400 2400"><use xlink:href="#brand-icon"></use></svg></div></div>'; }
  var inlineLoop = false;
  function runInlineLoaders() {
    if (inlineLoop) { return; } inlineLoop = true; var start = now();
    (function frame() {
      var list = document.querySelectorAll('.inline-loader'); var visible = 0; var i;
      var tt = now() - start; var cycle = (tt % 2400) / 1200; var s = 0.94 + 0.1 * fastOutSlowIn(cycle <= 1 ? cycle : 2 - cycle);
      for (i = 0; i < list.length; i += 1) {
        if (!list[i].offsetWidth) { continue; } visible += 1;
        list[i].querySelector('.loader-arc').setAttribute('transform', 'rotate(' + ((tt % 900) / 900 * 360) + ' 42 42)');
        var sh = list[i].querySelector('.loader-shield'); sh.style.webkitTransform = 'scale(' + s + ')'; sh.style.transform = sh.style.webkitTransform;
        list[i].style.opacity = Math.min(1, tt / 200);
      }
      if (visible) { raf(frame); } else { inlineLoop = false; }
    }());
  }

  /* SupportScreen.kt */
  var faqKeys = ['connect', 'connecting_check', 'slow', 'server', 'stats', 'pay', 'activate', 'discount', 'devices', 'app_filter', 'referrals', 'updates', 'diagnostics', 'privacy', 'support_details'];
  function renderSupport() {
    var list = byId('faqList'); var out = ''; var i;
    for (i = 0; i < faqKeys.length; i += 1) {
      out += '<div class="faq-card focusable" tabindex="0"><div class="faq-q"><b>' + escapeHtml(t('faq_q_' + faqKeys[i])) + '</b><i><svg><use xlink:href="#i-expand"></use></svg></i></div><div class="faq-a"><p>' + escapeHtml(t('faq_a_' + faqKeys[i])) + '</p></div></div>';
    }
    list.innerHTML = out + '<div style="height:12px"></div>';
    var cards = list.getElementsByClassName('faq-card');
    for (i = 0; i < cards.length; i += 1) {
      cards[i].onclick = function () {
        var open = this.className.indexOf('open') >= 0; var j;
        for (j = 0; j < cards.length; j += 1) { if (cards[j] !== this && cards[j].className.indexOf('open') >= 0) { removeClass(cards[j], 'open'); cards[j].lastChild.style.height = '0px'; } }
        toggleClass(this, 'open', !open);
        var answer = this.lastChild; answer.style.height = open ? '0px' : answer.firstChild.offsetHeight + 'px';
        var card = this; setTimeout(function () { keepVisible(list, card); }, 290);
      };
      cards[i].onfocus = function () { keepVisible(list, this); };
    }
    updateCues(list);
  }
  function showSupportQr() { showQrDialog(t('block_appeal_link'), t('support_contact_button'), t('block_appeal_scan_hint'), null, t('close')); }

  /* ReferralsScreen.kt and ReferralsViewModel.kt */
  var ref = { loading: false, refreshing: false, loadingMore: false, data: null, error: null, assigning: false, assignError: null, input: '', limitedUntil: 0 };
  try { ref.limitedUntil = Number(window.localStorage.getItem('referrerLimitUntil')) || 0; } catch (ignore) {}
  function refErrorKey(r) { if (!r) { return 'referrals_error_network'; } return (r.status === 401 || r.status === 403 || r.status === 404 || (r.status < 300 && !(r.body && r.body.success))) ? 'referrals_error_unavailable' : 'referrals_error_unknown'; }
  function loadReferrals(reset) {
    if (ref.loading || ref.refreshing || ref.loadingMore) { return; }
    var offset = reset ? 0 : ((ref.data && ref.data.referrals) || []).length; var started = reset && ref.data ? now() : 0;
    if (reset) { if (ref.data) { ref.refreshing = true; } else { ref.loading = true; } } else { ref.loadingMore = true; }
    ref.error = null; renderReferrals(); refreshFriendsDialog();
    bot('GET', 'api/referrals?limit=20&offset=' + offset, null, function (error, r) {
      minDelay(started, function () {
        ref.loading = ref.refreshing = ref.loadingMore = false;
        if (!error && r.status < 300 && r.body && r.body.success && r.body.data) {
          var page = r.body.data; page.referrals = page.referrals || page.referals || [];
          if (!reset && ref.data) {
            var seen = {}; var merged = []; var all = (ref.data.referrals || []).concat(page.referrals); var i;
            for (i = 0; i < all.length; i += 1) { var k = all[i].telegram_id + '|' + all[i].created_at + '|' + all[i].display_name; if (!seen[k]) { seen[k] = 1; merged.push(all[i]); } }
            page.referrals = merged; page.referral_url = page.referral_url || ref.data.referral_url; page.referrer = page.referrer || ref.data.referrer;
          }
          ref.data = page;
        } else { ref.error = refErrorKey(error ? null : r); }
        renderReferrals(); refreshFriendsDialog();
      });
    });
  }
  function limitSecondsLeft() { return ref.limitedUntil ? Math.max(0, Math.floor((ref.limitedUntil - Date.now() + 999) / 1000)) : 0; }
  function formatLimitWait(seconds) { var minutes = Math.floor((seconds + 59) / 60); var hours = Math.floor(minutes / 60); if (seconds < 60) { return t('referrals_referrer_wait_under_minute'); } if (hours > 0) { return t('referrals_referrer_wait_hours', hours, two(minutes % 60)); } return t('referrals_referrer_wait_minutes', minutes); }
  function parseRetryAfter(value) { var text = String(value || '').replace(/^\s+|\s+$/g, ''); if (!text) { return null; } if (/^\d+$/.test(text)) { return Number(text); } var d = Date.parse(text); return isNaN(d) ? null : Math.max(0, Math.floor((d - Date.now()) / 1000)); }
  function assignReferrer(id) {
    if (ref.assigning || !ref.data || ref.data.referrer || limitSecondsLeft() > 0) { return; }
    ref.assigning = true; ref.assignError = null; renderReferrals();
    bot('POST', 'api/device/referrer', { referrer_id: id }, function (error, r) {
      ref.assigning = false;
      if (!error && r.status < 300 && r.body && r.body.success) { ref.data.referrer = { telegram_id: id }; renderReferrals(); loadReferrals(true); return; }
      if (!error && r.status === 429) {
        var wait = parseRetryAfter(r.retry_after); ref.limitedUntil = Date.now() + (wait == null ? 3600 : wait) * 1000;
        try { window.localStorage.setItem('referrerLimitUntil', String(ref.limitedUntil)); } catch (ignore) {}
        ref.assignError = 'referrals_referrer_error_limited_short';
      } else if (error) { ref.assignError = 'referrals_referrer_error_network'; }
      else { ref.assignError = { 404: 'referrals_referrer_error_not_found', 409: 'referrals_referrer_error_conflict', 401: 'referrals_referrer_error_unavailable', 403: 'referrals_referrer_error_unavailable' }[r.status] || 'referrals_referrer_error_unknown'; }
      renderReferrals();
    });
  }
  var limitTimer = null;
  /* ReferralsScreen.kt referralDirectionalFocus(): up, down, left, right. */
  var referralRoutes = {
    refBack: ['cancel', 'refCopy refList refRetry cancel', 'cancel', 'refRefresh cancel'],
    refRefresh: ['cancel', 'refList refRetry cancel', 'refBack', 'cancel'],
    refCopy: ['refBack', 'cancel', 'cancel', 'refQr'],
    refQr: ['refBack', 'cancel', 'refCopy', 'refInput refInlineRetry refList'],
    refInfo: ['refRefresh', 'refList', 'refQr', 'cancel'],
    refList: ['refInfo', 'refInput refInlineRetry refQr', 'refQr', 'cancel'],
    refInput: ['refList', 'refInlineRetry cancel', 'refQr', 'refAssign'],
    refAssign: ['refList', 'refInlineRetry cancel', 'refInput', 'cancel'],
    refInlineRetry: ['refAssign refList', 'cancel', 'refQr', 'cancel'],
    refRetry: ['refBack', 'cancel', 'cancel', 'cancel']
  };
  function applyRoutes(routes) {
    var names = ['data-up', 'data-down', 'data-left', 'data-right'];
    for (var id in routes) { if (routes.hasOwnProperty(id)) { var el = byId(id); if (el) { for (var k = 0; k < 4; k += 1) { el.setAttribute(names[k], routes[id][k]); } } } }
  }
  function renderReferrals() { renderReferralsBody(); applyRoutes(referralRoutes); }
  function renderReferralsBody() {
    var body = byId('refBody'); var linked = currentStatus && currentStatus.linked; var d = ref.data; var i;
    var activeId = document.activeElement && document.activeElement.id;
    var initial = ref.loading && !d;
    toggleClass(byId('refRefresh'), 'hidden', !linked || initial); toggleClass(byId('refRefresh'), 'rotating', ref.loading || ref.refreshing);
    if (initial) { body.innerHTML = '<div class="center-message">' + loaderHtml() + '</div>'; runInlineLoaders(); return; }
    if (!linked) { body.innerHTML = '<div class="ref-message"><svg><use xlink:href="#i-groups"></use></svg><b>' + escapeHtml(t('referrals_auth_title')) + '</b><span>' + escapeHtml(t('referrals_auth_description')) + '</span></div>'; return; }
    if (!d) { body.innerHTML = '<div class="ref-message"><span class="ref-error-title">' + escapeHtml(t('referrals_error_title')) + '</span><span class="ref-error-text">' + escapeHtml(t(ref.error || 'referrals_error_unknown')) + '</span><button id="refRetry" class="ref-btn primary focusable" style="margin-top:36px">' + escapeHtml(t('retry')) + '</button></div>'; byId('refRetry').onclick = function () { loadReferrals(true); }; return; }
    var url = d.referral_url || '';
    var hero = '<div class="ref-hero"><div class="ref-hero-head"><span class="ref-icon-box"><svg><use xlink:href="#i-gift"></use></svg></span><span class="ref-hero-copy"><b>' + escapeHtml(t('referrals_hero_title')) + '</b><span>' + escapeHtml(t('referrals_hero_description')) + '</span></span></div><div class="ref-link-label">' + escapeHtml(t('referrals_your_link')) + '</div><div class="ref-link">' + escapeHtml(url || t('referrals_link_unavailable')) + '</div><div class="ref-link-spacer"></div><div class="ref-actions"><button id="refCopy" class="ref-btn focusable"' + (url ? '' : ' disabled') + '><svg><use xlink:href="#i-copy"></use></svg>' + escapeHtml(t('referrals_copy')) + '</button><button id="refQr" class="ref-btn primary focusable"' + (url ? '' : ' disabled') + '><svg><use xlink:href="#i-qr"></use></svg>' + escapeHtml(t('referrals_show_qr')) + '</button></div></div>';
    var total = d.total || 0;
    var side = '<div class="ref-side"><div class="ref-card ref-summary"><div class="ref-summary-head"><span class="ref-round blue"><svg><use xlink:href="#i-groups"></use></svg></span><span class="ref-summary-copy"><b>' + (ref.refreshing ? '…' : total) + '</b><span>' + escapeHtml(plural('referrals_invited_label', total)) + '</span></span><button id="refInfo" class="ref-info focusable"><svg><use xlink:href="#i-info"></use></svg></button></div><button id="refList" class="ref-btn focusable">' + escapeHtml(t('referrals_open_list')) + '</button></div>';
    if (!d.referrer) {
      var value = ref.input; var id = /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null; var localError = value && !id; var left = limitSecondsLeft(); var limited = left > 0;
      var shown = ref.assignError === 'referrals_referrer_error_limited_short' && !limited ? null : ref.assignError;
      var errorText = localError ? t('referrals_referrer_id_invalid') : (limited ? t('referrals_referrer_error_limited', formatLimitWait(left)) : (shown ? t(shown) : ''));
      side += '<div class="ref-card"><div class="ref-input-head"><svg><use xlink:href="#i-person-add"></use></svg><b>' + escapeHtml(t('referrals_referrer_input_title')) + '</b></div><div class="ref-input-desc">' + escapeHtml(t('referrals_referrer_input_description')) + '</div><div class="ref-input-row"><div id="refField" class="ref-field' + (value ? ' filled' : '') + (localError || shown || limited ? ' error' : '') + '"><label>' + escapeHtml(t('referrals_referrer_id_label')) + '</label><input id="refInput" class="focusable" type="text" inputmode="numeric" value="' + escapeHtml(value) + '"' + (ref.assigning ? ' disabled' : '') + '></div><button id="refAssign" class="ref-btn primary focusable"' + (id && !ref.assigning && !limited ? '' : ' disabled') + '>' + escapeHtml(t(ref.assigning ? 'referrals_referrer_assigning' : 'referrals_referrer_assign')) + '</button></div>' + (errorText ? '<div class="ref-input-error">' + escapeHtml(errorText) + '</div>' : '') + '</div>';
      if (limited && !limitTimer) { limitTimer = setInterval(function () { if (limitSecondsLeft() <= 0) { clearInterval(limitTimer); limitTimer = null; } if (currentScreen === 'referrals' && !(document.activeElement && document.activeElement.id === 'refInput')) { renderReferrals(); } }, 1000); }
    } else {
      var rr = d.referrer; var name = rr.display_name || (rr.telegram_id ? t('referrals_referrer_id_value', rr.telegram_id) : t('referrals_unknown_user'));
      side += '<div class="ref-card ref-referrer"><span class="ref-round green"><svg><use xlink:href="#i-person"></use></svg></span><span class="ref-referrer-copy"><span>' + escapeHtml(t('referrals_referred_by')) + '</span><b>' + escapeHtml(name) + '</b></span></div>';
    }
    if (ref.error) { side += '<div class="ref-inline-error"><span>' + escapeHtml(t(ref.error)) + '</span><button id="refInlineRetry" class="ref-btn focusable">' + escapeHtml(t('retry')) + '</button></div>'; }
    side += '</div>';
    body.innerHTML = hero + side;
    byId('refCopy').onclick = function () { copyText(url); var toast = byId('refToast'); addClass(toast, 'visible'); clearTimeout(toast.timer); toast.timer = setTimeout(function () { removeClass(toast, 'visible'); }, 1800); };
    byId('refQr').onclick = function () { if (url) { showQrDialog(url, t('referrals_qr_title'), t('referrals_qr_description'), null, t('close')); } };
    byId('refInfo').onclick = showRewards;
    byId('refList').onclick = showFriends;
    var input = byId('refInput');
    if (input) {
      var field = byId('refField');
      input.onfocus = function () { addClass(field, 'focused'); }; input.onblur = function () { removeClass(field, 'focused'); };
      input.oninput = function () {
        ref.input = input.value.replace(/\D/g, '').slice(0, 19); if (input.value !== ref.input) { input.value = ref.input; }
        if (ref.assignError && ref.assignError !== 'referrals_referrer_error_limited_short') { ref.assignError = null; }
        var pos = ref.input.length; renderReferrals(); var again = byId('refInput'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (ignore) {} }
      };
      input.onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); requestAssign(); } };
      byId('refAssign').onclick = requestAssign;
    }
    var retry = byId('refInlineRetry'); if (retry) { retry.onclick = function () { loadReferrals(true); }; }
    if (activeId && byId(activeId) && !byId(activeId).disabled) { byId(activeId).focus(); }
  }
  function requestAssign() {
    var id = /^\d+$/.test(ref.input) && Number(ref.input) > 0 ? Number(ref.input) : null; if (!id) { return; }
    var el = openDialog('<div class="ref-dialog ref-confirm"><span class="ref-round green"><svg><use xlink:href="#i-person-add"></use></svg></span><h2>' + escapeHtml(t('referrals_referrer_confirm_title')) + '</h2><p>' + escapeHtml(t('referrals_referrer_confirm_description')) + '</p><span class="ref-id-pill">' + escapeHtml(t('referrals_referrer_id_value', id)) + '</span><div class="ref-dialog-row"><button class="ref-dlg-cancel focusable">' + escapeHtml(t('cancel')) + '</button><button class="ref-dlg-ok focusable">' + escapeHtml(t('referrals_referrer_confirm')) + '</button></div></div>', { focus: '.ref-dlg-cancel' });
    el.querySelector('.ref-dlg-cancel').onclick = closeDialog;
    el.querySelector('.ref-dlg-ok').onclick = function () { closeDialog(); assignReferrer(id); };
  }
  function showRewards() {
    function metric(icon, color, label, value) { return '<div class="ref-metric"><i style="background:' + color + '26"><svg style="fill:' + color + '"><use xlink:href="#' + icon + '"></use></svg></i><div><span>' + escapeHtml(t(label)) + '</span><b>' + escapeHtml(t(value)) + '</b></div></div>'; }
    var el = openDialog('<div class="ref-dialog ref-rewards"><span class="ref-spark"><svg><use xlink:href="#i-sparkle"></use></svg></span><h2>' + escapeHtml(t('referrals_rewards_dialog_title')) + '</h2><div class="ref-rule"><i></i><span>' + escapeHtml(t('referrals_rewards_description')) + '</span></div>' +
      metric('i-person-add', '#4caf50', 'referrals_rewards_signup', 'referrals_rewards_signup_value') + metric('i-groups', '#2196f3', 'referrals_rewards_direct', 'referrals_rewards_direct_value') + metric('i-group-add', '#8b5cf6', 'referrals_rewards_indirect', 'referrals_rewards_indirect_value') +
      '<div class="ref-note">' + escapeHtml(t('referrals_rewards_note')) + '</div><button class="ref-dlg-close focusable">' + escapeHtml(t('referrals_rewards_close')) + '</button></div>');
    el.querySelector('.ref-dlg-close').onclick = closeDialog;
  }
  var friendsDialog = null;
  function friendsHtml() {
    var d = ref.data || {}; var items = d.referrals || []; var total = d.total || 0; var hasMore = items.length < total; var out = ''; var i;
    if (ref.refreshing) { for (i = 0; i < 3; i += 1) { out += '<div class="ref-row skeleton"><span class="ph" style="width:80px;height:80px;border-radius:50%"></span><span style="flex:1;margin-left:24px"><span class="ph" style="width:52%;height:30px"></span><span class="ph" style="width:32%;height:22px;margin-top:14px"></span></span></div>'; } }
    else if (!items.length) { out = '<div class="ref-empty-list"><svg><use xlink:href="#i-groups"></use></svg><b>' + escapeHtml(t('referrals_empty_title')) + '</b><span>' + escapeHtml(t('referrals_empty_description')) + '</span></div>'; }
    else {
      for (i = 0; i < items.length; i += 1) {
        var it = items[i]; var date = it.created_at ? parseDate(it.created_at) : null;
        out += '<div class="ref-row"><span class="avatar"><svg><use xlink:href="#i-person"></use></svg></span><span class="ref-row-copy"><b>' + escapeHtml(it.display_name || t('referrals_unknown_user')) + '</b>' + (date ? '<span>' + escapeHtml(t('referrals_joined', mediumDate(date))) + '</span>' : '') + '</span><span class="ref-level">' + escapeHtml(t('referrals_level', Math.max(1, it.level || 1))) + '</span></div>';
      }
    }
    var action = ref.error || hasMore ? '<button class="ref-btn primary focusable ref-more"' + (ref.refreshing || ref.loadingMore ? ' disabled' : '') + '>' + (ref.loadingMore ? spinnerHtml(34, 4, '#000') + '<span style="margin-left:16px">' : '<span>') + escapeHtml(t(ref.error ? 'retry' : 'referrals_load_more')) + '</span></button>' : '';
    return '<div class="ref-friends"><div class="ref-friends-head"><div><b>' + escapeHtml(t('referrals_invited_title')) + '</b><span>' + escapeHtml(plural('referrals_invited_count', total)) + '</span></div><button class="ref-friends-close focusable"><svg><use xlink:href="#i-close"></use></svg></button></div><div class="ref-friends-box"><div class="ref-friends-list scroll-list">' + out + '</div><span class="scroll-fade top"></span><span class="scroll-fade bottom"></span><svg class="scroll-cue top"><use xlink:href="#i-arrow-up"></use></svg><svg class="scroll-cue bottom"><use xlink:href="#i-arrow-down"></use></svg></div>' + action + '</div>';
  }
  function showFriends() {
    friendsDialog = openDialog(friendsHtml(), { bottom: true, focus: '.ref-friends-close', onClose: function () { friendsDialog = null; }, onKey: function (key) {
      // The list scrolls by 170 px; at its end Down moves to the bottom action.
      var list = friendsDialog.querySelector('.ref-friends-list');
      if (key === 40) { if (list.scrollTop + list.clientHeight < list.scrollHeight - 1) { list.scrollTop += 340; updateCues(list); return true; } var more = friendsDialog.querySelector('.ref-more'); if (more && !more.disabled) { more.focus(); } return true; }
      if (key === 38) { if (document.activeElement && document.activeElement.className.indexOf('ref-more') >= 0) { return false; } if (list.scrollTop > 0) { list.scrollTop -= 340; updateCues(list); } return true; }
      return false;
    } });
    bindFriends();
  }
  function bindFriends() {
    if (!friendsDialog) { return; }
    friendsDialog.querySelector('.ref-friends-close').onclick = closeDialog;
    var more = friendsDialog.querySelector('.ref-more'); if (more) { more.onclick = function () { if (ref.error) { loadReferrals(true); } else { loadReferrals(false); } }; }
    updateCues(friendsDialog.querySelector('.ref-friends-list')); animateSpinners();
  }
  function refreshFriendsDialog() {
    if (!friendsDialog) { return; }
    var list = friendsDialog.querySelector('.ref-friends-list'); var scroll = list ? list.scrollTop : 0; var onMore = document.activeElement && document.activeElement.className.indexOf('ref-more') >= 0;
    friendsDialog.innerHTML = friendsHtml(); bindFriends();
    list = friendsDialog.querySelector('.ref-friends-list'); list.scrollTop = scroll; updateCues(list);
    var target = onMore ? friendsDialog.querySelector('.ref-more') : friendsDialog.querySelector('.ref-friends-close'); if (target && !target.disabled) { target.focus(); } else { friendsDialog.querySelector('.ref-friends-close').focus(); }
  }
  function mediumDate(d) { return LANG === 'ru' ? d.getDate() + ' ' + DATE_NAMES.monthShort[d.getMonth()] + ' ' + d.getFullYear() + ' г.' : DATE_NAMES.monthShort[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  function copyText(value) {
    var area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.left = '-2000px'; document.body.appendChild(area); area.select();
    try { document.execCommand('copy'); } catch (ignore) {}
    document.body.removeChild(area);
  }
  function showQrDialog(data, title, description, supporting, action) {
    var el = openDialog('<div class="qr-card"><h2 class="qr-title">' + escapeHtml(title) + '</h2><p class="qr-text">' + escapeHtml(description) + '</p><div class="qr-plate"><canvas width="512" height="512"></canvas></div>' + (supporting ? '<p class="qr-support">' + escapeHtml(supporting) + '</p>' : '') + '<button class="qr-action focusable">' + escapeHtml(action) + '</button></div>', { focus: '.qr-action' });
    drawQr(el.querySelector('canvas'), data);
    el.querySelector('.qr-action').onclick = closeDialog;
  }

  /* AppFilterScreen.kt: webOS sends every app through one route table, so
     only the "all apps" mode can be honoured on this TV. */
  var appFilterMode = 'off';
  function renderAppFilter() {
    var modes = byId('appFilterScreen').querySelectorAll('.af-mode'); var i;
    for (i = 0; i < modes.length; i += 1) { toggleClass(modes[i], 'selected', modes[i].getAttribute('data-mode') === appFilterMode); }
    html('afCard', '<div class="af-summary">' + escapeHtml(t('app_filter_subtitle_off')) + '</div><div class="af-text">' + escapeHtml(t('app_filter_off_explainer').replace(/\s*[^.]*(другой режим|another mode|different mode)[^.]*\.\s*$/i, '')) + '</div>');
  }

  document.addEventListener('keydown', function (e) { var dlg = topDialog(); if (dlg) { if (e.keyCode === 461 || e.keyCode === 27) { e.preventDefault(); if (!dlg.modal) { closeDialog(); } return; } if (e.keyCode >= 37 && e.keyCode <= 40) { e.preventDefault(); if (!(dlg.onKey && dlg.onKey(e.keyCode))) { moveFocus(e.keyCode); } return; } } if (e.keyCode===13 && document.activeElement && document.activeElement.tagName === 'DIV' && document.activeElement.onclick) { e.preventDefault(); document.activeElement.onclick(); return; } if (e.keyCode>=37&&e.keyCode<=40) { e.preventDefault(); moveFocus(e.keyCode); } else if (e.keyCode===461||e.keyCode===27) { e.preventDefault(); goBack(); } });
  byId('retryButton').onclick = function () { setupTried = false; showScreen('loading'); setTimeout(function () { loadStatus(true); }, 200); };
  byId('onbStart').onclick = showInstall; byId('installDone').onclick = function () { chooseEntry('app'); }; byId('installIphone').onclick = function () { chooseEntry('iphone'); }; byId('installNoPhone').onclick = function () { chooseEntry('nophone'); };
  byId('pairRetry').onclick = function () { pairing.expirations = 0; requestPairCode(); }; byId('pairBack').onclick = showInstall;
  byId('powerButton').onclick = toggleConnection; byId('serverCard').onclick = showServers;
  byId('autoServerButton').onclick = function () { if (currentStatus && currentStatus.servers.length) { selectAutomaticServer(); } };
  byId('refreshServersButton').onclick = function () { refreshServers(true); }; byId('startSpeedButton').onclick = runSpeedTest;
  byId('historyButton').onclick = function () { returnFocus.speedHistory = this; navigate('speedHistory'); };
  byId('timeoutMinus').onclick = function () { setPingTimeout(pingTimeoutSeconds - 1); };
  byId('timeoutPlus').onclick = function () { setPingTimeout(pingTimeoutSeconds + 1); };
  byId('serverGrid').onscroll = function () { updateCues(this); };
  var nav = document.querySelectorAll('[data-nav]'); var i;
  for (i=0;i<nav.length;i+=1) { nav[i].onclick=function(){navigate(this.getAttribute('data-nav'));}; }
  var backs = document.querySelectorAll('.back-button');
  for (i=0;i<backs.length;i+=1) { backs[i].onclick=function(){ goBack(); }; }
  var periods = document.querySelectorAll('[data-period]');
  for (i=0;i<periods.length;i+=1) { periods[i].onclick=function(){ for (var j=0;j<periods.length;j+=1) { toggleClass(periods[j],'active',periods[j]===this); } statsPeriod = Number(this.getAttribute('data-period')); renderStatsBody(); }; }
  var pageButtons = document.querySelectorAll('[data-settings-page]');
  for (i=0;i<pageButtons.length;i+=1) { pageButtons[i].onclick=function(){ showSettingsPage(Number(this.getAttribute('data-settings-page'))); this.focus(); }; }
  applyStrings(); settingsActions(); toggleClass(document.body, 'light', THEME === 'light');
  byId('promoRefresh').onclick = function () { loadPromocodes(); }; byId('refRefresh').onclick = function () { loadReferrals(true); }; byId('supportContact').onclick = showSupportQr;
  bindBack(document);
  runSplash(); runLoader();
  window.addEventListener('load', function () { setTimeout(function(){loadStatus(true);},180); setInterval(function(){if(!busy&&!navTimer&&currentStatus&&currentStatus.linked){loadStatus(false);}},2000); });
}());
