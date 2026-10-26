#!/usr/bin/node
'use strict';

var fs = require('fs');
var http = require('http');
var url = require('url');
var child = require('child_process');
var crypto = require('crypto');
var dns = require('dns');
var net = require('net');

var BASE = process.env.TOBEVPN_DIR || '/media/developer/tobevpn';
var STATE = BASE + '/state';
var CONFIG_FILE = BASE + '/config.json';
var SESSION_FILE = STATE + '/session.json';
var SERVERS_FILE = STATE + '/servers.json';
var XRAY_CONFIG = STATE + '/xray.json';
var HEV_CONFIG = STATE + '/hev.yml';
var XRAY_PID = STATE + '/xray.pid';
var HEV_PID = STATE + '/hev.pid';
var XRAY_BIN = BASE + '/bin/xray';
var HEV_BIN = BASE + '/bin/hev-socks5-tunnel';
var IP = '/sbin/ip';
var SOCKS_PORT = 28080;
var PROBE_BASE_PORT = 28200;
var PROBE_MARK = 42;
var PROBE_CONFIG = STATE + '/probe.json';
var SPEED_HISTORY_FILE = STATE + '/speed_history.json';
var TRAFFIC_LOG_FILE = STATE + '/traffic_log.json';
var PROBE_TARGETS = ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'];
var APP_VERSION = process.env.TOBEVPN_APP_VERSION || '1.0.35-tv';
var UPDATE_REPO = 'Shoolife/ToBeVPN-Android-TV';
// Test hook: a releases JSON served elsewhere instead of the GitHub API.
var UPDATE_API = process.env.TOBEVPN_UPDATE_API || 'https://api.github.com/repos/' + UPDATE_REPO + '/releases';
var UPDATE_FILE = '/tmp/tobevpn-update.ipk';
var UPDATE_CACHE = STATE + '/update_cache.json';
var UPDATE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
var APP_DIR = '/media/developer/apps/usr/palm/applications/com.tobevpn.app';
var LUNA = '/usr/bin/luna-send';
var app;

function ensureDir(path) {
  if (!fs.existsSync(path)) { fs.mkdirSync(path, 448); }
}

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (ignore) { return fallback; }
}

function writeJson(path, value, mode) {
  var temp = path + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: mode || 384 });
  fs.renameSync(temp, path);
}

function safeLog(message) {
  var safe = String(message).replace(/(access_token|refresh_token|authorization)[^,\s]*/ig, '$1=<redacted>');
  try { fs.appendFileSync(STATE + '/service.log', new Date().toISOString() + ' ' + safe + '\n'); } catch (ignore) {}
}

function run(bin, args, timeout) {
  var result = child.spawnSync(bin, args || [], { timeout: timeout || 20000, encoding: 'utf8' });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : ''
  };
}

function sleep(seconds) { run('/bin/sleep', [String(seconds)], (seconds + 2) * 1000); }

function first(query, key, fallback) {
  var value = query[key];
  if (Array.isArray(value)) { value = value[0]; }
  return value === undefined || value === null ? (fallback || '') : String(value);
}

function unique(values) {
  var seen = {};
  return values.filter(function (value) {
    if (seen[value]) { return false; }
    seen[value] = true;
    return true;
  });
}

function parseProfileLinks(body) {
  var regex = /(?:vless|hysteria2|hy2):\/\/[^\s<>"']+/ig;
  var direct = String(body || '').match(regex);
  if (direct && direct.length) { return unique(direct); }
  var compact = String(body || '').replace(/\s+/g, '');
  if (!compact) { return []; }
  try {
    var decoded = new Buffer(compact, 'base64').toString('utf8');
    return unique(decoded.match(regex) || []);
  } catch (ignore) { return []; }
}

function networkName(raw) {
  var value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'raw' || value === 'tcp') { return 'tcp'; }
  if (value === 'websocket' || value === 'ws') { return 'ws'; }
  if (value === 'splithttp' || value === 'xhttp') { return 'xhttp'; }
  return value;
}

function decoded(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%2B')); }
  catch (ignore) { return String(value || ''); }
}

function parseServer(link) {
  var parsed = url.parse(link, true);
  var scheme = String(parsed.protocol || '').toLowerCase();
  if (!parsed.auth || !parsed.hostname) { throw new Error('Некорректная ссылка сервера'); }
  if (scheme === 'vless:') {
    var fp = first(parsed.query, 'fp', 'chrome').trim().toLowerCase() || 'chrome';
    var oldFp = ['android', 'helloandroid_11_okhttp', 'hellochrome_58', 'hellochrome_62', 'hellofirefox_55', 'hellofirefox_56', 'helloios_11_1'];
    if (oldFp.indexOf(fp) >= 0) { fp = 'chrome'; }
    var extra = first(parsed.query, 'extra');
    if (extra.trim() === 'null') { extra = ''; }
    return {
      protocol: 'vless', name: decoded(parsed.hash ? parsed.hash.substr(1) : parsed.hostname),
      address: parsed.hostname, port: parseInt(parsed.port || '443', 10), uuid: decoded(parsed.auth),
      flow: first(parsed.query, 'flow'), security: first(parsed.query, 'security', 'none').toLowerCase() || 'none',
      sni: first(parsed.query, 'sni'), fingerprint: fp, public_key: first(parsed.query, 'pbk'),
      short_id: first(parsed.query, 'sid'), network: networkName(first(parsed.query, 'type')),
      path: first(parsed.query, 'path'), host: first(parsed.query, 'host'), alpn: first(parsed.query, 'alpn'),
      header_type: first(parsed.query, 'headerType').toLowerCase(), service_name: first(parsed.query, 'serviceName'),
      extra: extra, mode: first(parsed.query, 'mode').toLowerCase(), spx: first(parsed.query, 'spx'), link: link
    };
  }
  if (scheme === 'hysteria2:' || scheme === 'hy2:') {
    var pin = (first(parsed.query, 'pinSHA256') || first(parsed.query, 'pinsha256')).replace(/[:\s]/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pin)) { pin = ''; }
    var obfs = first(parsed.query, 'obfs').toLowerCase();
    return {
      protocol: 'hysteria2', name: decoded(parsed.hash ? parsed.hash.substr(1) : parsed.hostname),
      address: parsed.hostname, port: parseInt(parsed.port || '443', 10), uuid: decoded(parsed.auth),
      sni: first(parsed.query, 'sni'), alpn: first(parsed.query, 'alpn', 'h3') || 'h3',
      obfs_password: obfs === '' || obfs === 'salamander' ? first(parsed.query, 'obfs-password') : '',
      pin_sha256: pin, port_hopping: first(parsed.query, 'mport'), ech: first(parsed.query, 'ech'), link: link
    };
  }
  throw new Error('Неподдерживаемый протокол сервера');
}

// Only what the server list draws: the protocol formula and the endpoint row
// for admins (ServerListScreen.kt). Secrets stay in the service.
function publicServer(server, index) {
  return {
    index: index, name: server.name || server.address,
    protocol: server.protocol === 'hysteria2' ? 'Hysteria2' : 'VLESS',
    address: server.address, port: server.port || 443, network: server.network || 'hysteria',
    security: server.security || '', vision: /vision/i.test(server.flow || ''),
    obfs: !!server.obfs_password, ech: !!server.ech, port_hopping: !!server.port_hopping
  };
}

function buildXrayConfig(server, addressIp) {
  var inbound = {
    tag: 'socks', listen: '127.0.0.1', port: SOCKS_PORT, protocol: 'socks',
    settings: { auth: 'noauth', udp: true, userLevel: 8 },
    sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false }
  };
  var proxy;
  if (server.protocol === 'hysteria2') {
    var tls = { serverName: server.sni || server.address, alpn: server.alpn.split(',').filter(Boolean) };
    if (!tls.alpn.length) { tls.alpn = ['h3']; }
    if (server.pin_sha256) { tls.pinnedPeerCertSha256 = server.pin_sha256; }
    if (server.ech) { tls.echConfigList = server.ech; }
    var hysteria = { version: 2, auth: server.uuid };
    var masks = [];
    if (server.port_hopping) { masks.push({ type: 'udphop', settings: { mode: 'intervalRemote', remotePorts: server.port_hopping } }); }
    if (server.obfs_password) { masks.push({ type: 'salamander', settings: { password: server.obfs_password } }); }
    if (masks.length) { hysteria.finalmask = { udp: masks }; }
    proxy = {
      tag: 'proxy', protocol: 'hysteria', settings: { version: 2, address: addressIp, port: server.port },
      streamSettings: { network: 'hysteria', security: 'tls', tlsSettings: tls, hysteriaSettings: hysteria }
    };
  } else {
    var stream = { network: server.network, security: server.security };
    var settings;
    if (server.network === 'xhttp') {
      settings = {};
      if (server.path) { settings.path = server.path; }
      if (server.host) { settings.host = server.host; }
      if (server.mode) { settings.mode = server.mode; }
      if (server.extra) { try { settings.extra = JSON.parse(server.extra); } catch (ignore) {} }
      stream.xhttpSettings = settings;
    } else if (server.network === 'ws') {
      settings = {};
      if (server.path) { settings.path = server.path; }
      if (server.host) { settings.host = server.host; settings.headers = { Host: server.host }; }
      stream.wsSettings = settings;
    } else if (server.network === 'grpc') {
      settings = { serviceName: server.service_name || '', multiMode: server.mode === 'multi' };
      if (server.host) { settings.authority = server.host; }
      stream.grpcSettings = settings;
    } else {
      var headerType = server.header_type === 'http' ? 'http' : 'none';
      var header = { type: headerType };
      if (headerType === 'http') {
        var request = {};
        if (server.path) { request.path = [server.path]; }
        if (server.host) { request.headers = { Host: [server.host] }; }
        header.request = request; header.response = {};
      }
      stream.tcpSettings = { header: header };
    }
    if (server.security === 'reality') {
      stream.realitySettings = {
        allowInsecure: false, serverName: server.sni || '', fingerprint: server.fingerprint || 'chrome',
        publicKey: server.public_key || '', shortId: server.short_id || '', spiderX: server.spx || '/'
      };
    } else if (server.security === 'tls') {
      stream.tlsSettings = { allowInsecure: false, serverName: server.sni || '', fingerprint: server.fingerprint || 'chrome' };
      var alpn = (server.alpn || '').split(',').filter(Boolean);
      if (alpn.length) { stream.tlsSettings.alpn = alpn; }
    }
    var user = { id: server.uuid, level: 8, encryption: 'none' };
    if (server.flow) { user.flow = server.flow; }
    proxy = {
      tag: 'proxy', protocol: 'vless',
      settings: { vnext: [{ address: addressIp, port: server.port, users: [user] }] }, streamSettings: stream
    };
    if (server.network !== 'xhttp') { proxy.mux = { enabled: false, concurrency: -1 }; }
  }
  return {
    log: { loglevel: 'warning' }, inbounds: [inbound],
    outbounds: [proxy, { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } }, { tag: 'block', protocol: 'blackhole' }],
    dns: { servers: ['1.1.1.1', '8.8.8.8'], queryStrategy: 'UseIPv4' },
    routing: { domainStrategy: 'AsIs', rules: [] }
  };
}

/* UpdateRepository.kt / UpdateViewModel.kt: the same GitHub releases as the
   Android TV build. A release carries the webOS package as an .ipk asset;
   it holds the app and a copy of this service (service/), which replaces the
   running one after the install. */
function parseSemver(raw) {
  var cleaned = String(raw || '').replace(/^v/, '').split('-')[0].split('+')[0];
  var parts = cleaned.split('.');
  if (parts.length < 1 || parts.length > 3) { return null; }
  var nums = [];
  for (var i = 0; i < 3; i += 1) { var piece = parts[i] === undefined ? '0' : parts[i]; if (!/^\d+$/.test(piece)) { return null; } nums.push(parseInt(piece, 10)); }
  return nums;
}
function compareSemver(a, b) { for (var i = 0; i < 3; i += 1) { if (a[i] !== b[i]) { return a[i] - b[i]; } } return 0; }
function pickIpkAsset(release) {
  var ipks = (release.assets || []).filter(function (asset) { return /\.ipk$/i.test(asset.name || ''); });
  return ipks.filter(function (asset) { return /webos/i.test(asset.name); })[0] || ipks[0] || null;
}
function selectNewestUpdate(releases, current) {
  var best = null;
  releases.forEach(function (release) {
    if (release.draft || release.prerelease) { return; }
    var version = parseSemver(release.tag_name); if (!version || compareSemver(version, current) <= 0) { return; }
    var ipk = pickIpkAsset(release); if (!ipk) { return; }
    if (!best || compareSemver(version, best.version) > 0) { best = { release: release, ipk: ipk, version: version }; }
  });
  return best;
}

function Updater() { this.state = 'idle'; this.info = null; this.error = ''; this.proc = null; this.checking = false; }
Updater.prototype.snapshot = function () {
  var downloaded = 0;
  if (this.state === 'downloading') { try { downloaded = fs.statSync(UPDATE_FILE + '.part').size; } catch (ignore) {} }
  if (this.state === 'ready' || this.state === 'installing') { downloaded = this.info ? this.info.size : 0; }
  return { state: this.state, current: APP_VERSION, checking: this.checking, error: this.error, downloaded: downloaded, info: this.info };
};
Updater.prototype.fetchReleases = function () {
  var releases = [];
  for (var page = 1; page <= 5; page += 1) {
    var result = run('/usr/bin/curl', ['-sS', '-L', '--connect-timeout', '8', '--max-time', '20', '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: ToBeVPN-webOS/' + APP_VERSION,
      '-w', '\n__TOBEVPN_HTTP__:%{http_code}', UPDATE_API + '?per_page=100&page=' + page], 24000);
    var marker = result.stdout.lastIndexOf('\n__TOBEVPN_HTTP__:');
    if (result.status !== 0 || marker < 0 || parseInt(result.stdout.substr(marker + 18), 10) !== 200) { throw new Error('GitHub недоступен'); }
    var items = JSON.parse(result.stdout.substr(0, marker));
    if (!Array.isArray(items) || !items.length) { break; }
    releases = releases.concat(items);
    if (items.length < 100) { break; }
  }
  return releases;
};
// checkForUpdate(force): only "up to date" is cached (7 days); failures never are.
Updater.prototype.check = function (force) {
  if (this.state === 'downloading' || this.state === 'ready' || this.state === 'installing') { return this.snapshot(); }
  if (!force) {
    var cached = readJson(UPDATE_CACHE, null);
    if (cached && cached.version === APP_VERSION && Date.now() - cached.at < UPDATE_CACHE_TTL) { return this.snapshot(); }
  }
  this.checking = true;
  try {
    var update = selectNewestUpdate(this.fetchReleases(), parseSemver(APP_VERSION));
    if (update) {
      this.info = { version: update.release.tag_name.replace(/^v/, ''), notes: update.release.body || '', page: update.release.html_url || '', url: update.ipk.browser_download_url, size: update.ipk.size || 0, name: update.ipk.name };
      this.state = 'available'; this.error = '';
      try { fs.unlinkSync(UPDATE_CACHE); } catch (ignore) {}
    } else {
      if (this.state === 'available') { this.state = 'idle'; this.info = null; }
      writeJson(UPDATE_CACHE, { version: APP_VERSION, at: Date.now() });
    }
  } catch (error) {
    safeLog('update check failed: ' + error.message);
  }
  this.checking = false;
  return this.snapshot();
};
Updater.prototype.download = function () {
  var self = this;
  if (this.state !== 'available' || !this.info) { return this.snapshot(); }
  try { fs.unlinkSync(UPDATE_FILE + '.part'); } catch (ignore) {}
  this.state = 'downloading'; this.error = '';
  var proc = child.spawn('/usr/bin/curl', ['-sS', '-L', '--fail', '--connect-timeout', '10', '--max-time', '900', '-o', UPDATE_FILE + '.part', this.info.url], { stdio: 'ignore' });
  this.proc = proc;
  proc.on('exit', function (code) {
    if (self.proc !== proc) { return; }
    self.proc = null;
    var size = 0; try { size = fs.statSync(UPDATE_FILE + '.part').size; } catch (ignore) {}
    if (code === 0 && size > 0 && (!self.info.size || size === self.info.size)) {
      fs.renameSync(UPDATE_FILE + '.part', UPDATE_FILE); self.state = 'ready';
    } else {
      try { fs.unlinkSync(UPDATE_FILE + '.part'); } catch (ignore) {}
      self.state = 'failed'; self.error = 'Не удалось загрузить обновление';
    }
  });
  return this.snapshot();
};
Updater.prototype.dismiss = function () {
  if (this.proc) { var proc = this.proc; this.proc = null; try { proc.kill('SIGTERM'); } catch (ignore) {} }
  try { fs.unlinkSync(UPDATE_FILE + '.part'); } catch (ignore) {}
  if (this.state !== 'installing') { this.state = 'idle'; this.error = ''; }
  return this.snapshot();
};
Updater.prototype.retry = function () { if (this.state === 'failed' && this.info) { this.state = 'available'; this.error = ''; } return this.snapshot(); };
Updater.prototype.install = function () {
  var self = this;
  if (this.state !== 'ready') { return this.snapshot(); }
  this.state = 'installing';
  var out = '';
  // appInstallService closes the running app, installs the package, and the
  // subscription reports "installed" (or an error) at the end.
  var proc = child.spawn(LUNA, ['-n', '30', '-w', '120000', 'luna://com.webos.appInstallService/dev/install', JSON.stringify({ id: 'testing', ipkUrl: UPDATE_FILE, subscribe: true })]);
  // The subscription stays open after the final state: stop at "installed" or a failure.
  proc.stdout.on('data', function (chunk) { out += chunk; if (/"state"\s*:\s*"(installed|[^"]*fail[^"]*)"|"errorCode"/i.test(out)) { try { proc.kill('SIGTERM'); } catch (ignore) {} } });
  proc.on('exit', function () {
    if (!/"state"\s*:\s*"installed"/.test(out)) {
      safeLog('update install failed: ' + out.replace(/\s+/g, ' ').slice(-400));
      self.state = 'failed'; self.error = 'Не удалось установить обновление';
      return;
    }
    try { fs.unlinkSync(UPDATE_FILE); } catch (ignore) {}
    var serviceChanged = self.applyServiceBundle();
    self.state = 'idle'; self.info = null;
    run(LUNA, ['-n', '1', 'luna://com.webos.applicationManager/launch', JSON.stringify({ id: 'com.tobevpn.app' })], 10000);
    if (serviceChanged) {
      // stop.sh ends this process; a detached shell outlives it and starts the new one.
      child.spawn('/bin/sh', ['-c', 'sleep 2; ' + BASE + '/service/stop.sh; nohup ' + BASE + '/service/start.sh >/dev/null 2>&1 &'], { detached: true, stdio: 'ignore' }).unref();
    }
  });
  return this.snapshot();
};
Updater.prototype.applyServiceBundle = function () {
  var bundle = APP_DIR + '/service';
  var changed = false;
  ['tobevpn_service.js', 'start.sh', 'stop.sh'].forEach(function (name) {
    var from = bundle + '/' + name; var to = BASE + '/service/' + name;
    var next; try { next = fs.readFileSync(from); } catch (ignore) { return; }
    var now = null; try { now = fs.readFileSync(to); } catch (ignore) {}
    if (now && now.toString('base64') === next.toString('base64')) { return; }
    fs.writeFileSync(to + '.tmp', next, { mode: 493 }); fs.renameSync(to + '.tmp', to); changed = true;
  });
  if (changed) { safeLog('service updated from the installed package'); }
  return changed;
};

function Controller() {
  ensureDir(STATE);
  this.updater = new Updater();
  this.config = readJson(CONFIG_FILE, {});
  this.session = readJson(SESSION_FILE, {});
  this.servers = readJson(SERVERS_FILE, []);
  this.connectedIndex = null;
  this.connectedName = null;
  this.connectedSince = null;
  this.lastError = '';
  this.busy = false;
  this.stopOldProcesses();
  this.cleanupRoutes();
  if (this.session.is_linked) {
    try { this.syncAccount(); } catch (accountError) { safeLog('Account sync skipped: ' + accountError.message); }
  }
}

Controller.prototype.saveSession = function () { writeJson(SESSION_FILE, this.session); };
Controller.prototype.saveServers = function () { writeJson(SERVERS_FILE, this.servers); };

Controller.prototype.curl = function (method, target, payload, bearer, headers, timeout, headerFile) {
  // withTimeoutOrNull(): a sync running under a deadline stops at it.
  if (this.deadline) {
    var left = Math.ceil((this.deadline - Date.now()) / 1000);
    if (left <= 0) { throw new Error('Время синхронизации вышло'); }
    timeout = Math.min(timeout || 20, left);
  }
  var args = ['-sS', '--connect-timeout', '8', '--max-time', String(timeout || 20), '-X', method, '-H', 'Accept: application/json'];
  if (headerFile) { args.push('-D', headerFile); }
  if (bearer) { args.push('-H', 'Authorization: Bearer ' + bearer); }
  Object.keys(headers || {}).forEach(function (key) { args.push('-H', key + ': ' + headers[key]); });
  if (payload !== null && payload !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(payload));
  }
  args.push('-w', '\n__TOBEVPN_HTTP__:%{http_code}', target);
  var result = run('/usr/bin/curl', args, ((timeout || 20) + 2) * 1000);
  if (result.status !== 0) { throw new Error('Ошибка сетевого запроса'); }
  var marker = '\n__TOBEVPN_HTTP__:';
  var offset = result.stdout.lastIndexOf(marker);
  if (offset < 0) { throw new Error('Некорректный ответ сети'); }
  var body = result.stdout.substr(0, offset);
  var status = parseInt(result.stdout.substr(offset + marker.length), 10);
  var parsed;
  try { parsed = body.trim() ? JSON.parse(body) : {}; } catch (ignore) { parsed = { raw: body }; }
  return { status: status, body: parsed };
};

Controller.prototype.apiUrl = function (path) {
  var base = String(this.config.bot_api_url || '').replace(/\/+$/, '');
  if (!base) { throw new Error('Backend не настроен'); }
  return base + '/' + String(path).replace(/^\/+/, '');
};

Controller.prototype.bootstrap = function () {
  var deviceId = this.session.device_id || this.config.device_id || crypto.randomBytes(16).toString('hex');
  var response = this.curl('POST', this.apiUrl('api/device/bootstrap'), { device_id: deviceId, platform: 'android_tv' });
  var data = response.body.data || {};
  if (response.status >= 300 || !data.access_token) { throw new Error(response.body.message || 'Не удалось зарегистрировать телевизор'); }
  var previous = this.session;
  var now = Math.floor(Date.now() / 1000);
  this.session = {
    device_id: data.device_id || deviceId, access_token: data.access_token, refresh_token: data.refresh_token || '',
    access_expires_at: now + parseInt(data.expires_in || 1800, 10),
    refresh_expires_at: now + parseInt(data.refresh_expires_in || 7776000, 10), is_linked: false
  };
  if (data.is_linked && data.telegram_id) {
    this.session.is_linked = true; this.session.telegram_id = data.telegram_id;
    this.session.panel_user_uuid = data.panel_user_uuid; this.session.short_uuid = data.short_uuid;
  } else if (previous.is_linked) {
    ['is_linked', 'telegram_id', 'panel_user_uuid', 'short_uuid', 'subscription_url'].forEach(function (key) {
      if (previous[key] !== undefined) { this.session[key] = previous[key]; }
    }, this);
  }
  // A fresh token pair does not change who the device belongs to: keep the
  // synced account (plan, expiry, limits) while the link holds.
  if (this.session.is_linked && previous.telegram_id === this.session.telegram_id) {
    Object.keys(previous).forEach(function (key) {
      if (this.session[key] === undefined && (key.indexOf('account_') === 0 || key === 'subscription_url')) { this.session[key] = previous[key]; }
    }, this);
  }
  this.saveSession();
  return this.publicStatus();
};

Controller.prototype.refreshToken = function () {
  if (!this.session.refresh_token) { return this.bootstrap(); }
  var response = this.curl('POST', this.apiUrl('api/device/refresh'), { refresh_token: this.session.refresh_token });
  var data = response.body.data || {};
  if (response.status >= 300 || !data.access_token) { return this.bootstrap(); }
  var now = Math.floor(Date.now() / 1000);
  this.session.access_token = data.access_token;
  this.session.refresh_token = data.refresh_token || this.session.refresh_token;
  this.session.access_expires_at = now + parseInt(data.expires_in || 1800, 10);
  this.session.refresh_expires_at = now + parseInt(data.refresh_expires_in || 7776000, 10);
  this.saveSession();
};

Controller.prototype.accessToken = function () {
  if (!this.session.access_token) { this.bootstrap(); }
  else if ((this.session.access_expires_at || 0) <= Math.floor(Date.now() / 1000) + 10) { this.refreshToken(); }
  return this.session.access_token;
};

Controller.prototype.api = function (method, path, payload, retry) {
  var response = this.curl(method, this.apiUrl(path), payload, this.accessToken());
  if ((response.status === 401 || response.status === 403) && retry !== false) {
    this.bootstrap();
    return this.api(method, path, payload, false);
  }
  return response;
};

Controller.prototype.createPair = function () {
  this.bootstrap();
  var response = this.api('POST', 'api/tv/pair/create', {});
  var data = response.body.data || {};
  if (response.status >= 300 || !response.body.success || !data.code) { throw new Error(response.body.message || 'Не удалось создать код входа'); }
  this.session.pair_code = data.code;
  this.session.pair_expires_at = Math.floor(Date.now() / 1000) + parseInt(data.expires_in || 300, 10);
  this.saveSession();
  return { code: data.code, expires_in: data.expires_in || 300, deep_link: 'tobevpn://pair?code=' + data.code };
};

Controller.prototype.pairStatus = function (code) {
  code = code || this.session.pair_code;
  if (!code) { throw new Error('Вход ещё не начат'); }
  var response = this.api('GET', 'api/tv/pair/status?code=' + encodeURIComponent(code));
  var data = response.body.data || {};
  if (response.status >= 300 || !response.body.success) { throw new Error(response.body.message || 'Не удалось проверить код входа'); }
  var state = data.status || 'pending';
  if (state === 'completed') { this.applyAuthenticated(data); }
  return { status: state, linked: !!this.session.is_linked, servers: this.servers.length };
};

// AuthRepository.applyAuthenticatedDevice: both sign-in routes end here.
Controller.prototype.applyAuthenticated = function (data) {
  if (!data.telegram_id) { throw new Error('Вход завершён без telegram_id'); }
  this.session.is_linked = true; this.session.telegram_id = data.telegram_id;
  this.session.short_uuid = data.short_uuid || this.session.short_uuid;
  this.session.panel_user_uuid = data.panel_user_uuid || this.session.panel_user_uuid;
  this.saveSession();
  this.bootstrap();
  this.resolveSubscriptionUrl();
  this.refreshProfile();
};

// AuthRepository.requestTelegramAuth / checkAuthStatus: the iPhone and
// "no phone" routes sign in through the Telegram bot.
Controller.prototype.telegramAuth = function () {
  this.bootstrap();
  var response = this.api('POST', 'api/auth/request', { panel_user_uuid: this.session.panel_user_uuid || null });
  var data = response.body.data || {};
  if (response.status >= 300 || !response.body.success || !data.auth_token) { throw new Error(response.body.message || 'Could not request auth'); }
  return { auth_token: data.auth_token };
};
Controller.prototype.telegramStatus = function (token) {
  var response = this.api('GET', 'api/auth/status?token=' + encodeURIComponent(token || ''));
  if (response.status >= 300 || !response.body.success) { throw new Error(response.body.message || 'Could not check auth status'); }
  var data = response.body.data || {};
  var state = data.status || 'pending';
  if (state === 'completed') { this.applyAuthenticated(data); }
  return { status: state, linked: !!this.session.is_linked };
};

Controller.prototype.resolveSubscriptionUrl = function () {
  if (!this.session.telegram_id) { return null; }
  var response = this.api('GET', 'api/panel/user-by-telegram/' + this.session.telegram_id);
  var users = response.body && response.body.response;
  if (response.status >= 300 || !Array.isArray(users) || !users.length) { return null; }
  var preferredUuid = this.session.panel_user_uuid;
  var preferredShort = this.session.short_uuid;
  var chosen = users.filter(function (user) { return preferredUuid && user.uuid === preferredUuid; })[0];
  if (!chosen) { chosen = users.filter(function (user) { return preferredShort && user.short_uuid === preferredShort; })[0]; }
  if (!chosen) { chosen = users.filter(function (user) { return String(user.status || '').toUpperCase() === 'ACTIVE'; })[0] || users[0]; }
  this.session.panel_user_uuid = chosen.uuid;
  this.session.short_uuid = chosen.short_uuid;
  this.session.subscription_url = chosen.subscription_url;
  this.session.account_username = chosen.username || '';
  this.session.account_status = chosen.status || '';
  this.session.account_expire_at = chosen.expire_at || '';
  this.session.account_traffic_limit = chosen.traffic_limit_bytes || 0;
  this.session.account_device_limit = chosen.hwid_device_limit || 0;
  this.saveSession();
  try { this.syncAccount(); } catch (ignore) {}
  return this.session.subscription_url;
};

Controller.prototype.syncAccount = function () {
  var response = this.api('GET', 'api/subscription/current-plan');
  var data = response.body.data || {};
  if (response.status >= 300 || !response.body.success) { return; }
  var plan = data.current_plan || data.plan_snapshot || {};
  var subscription = data.subscription || {};
  this.session.account_is_admin = data.is_admin === true;
  this.session.account_plan_name = plan.name || data.plan_name || data.name || this.session.account_plan_name || '';
  this.session.account_status = subscription.status || subscription.stored_status || data.status || this.session.account_status || '';
  this.session.account_expire_at = subscription.expire_at || subscription.expires_at || data.expire_at || data.expires_at || this.session.account_expire_at || '';
  this.session.account_traffic_limit = subscription.traffic_limit_bytes || plan.traffic_limit_bytes || this.session.account_traffic_limit || 0;
  this.session.account_device_limit = subscription.device_limit || plan.device_limit || this.session.account_device_limit || 0;
  this.session.account_unlimited = subscription.is_unlimited === true || String(plan.type || '').toUpperCase() === 'UNLIMITED';
  this.session.account_traffic_reset_at = subscription.next_traffic_reset_at_ts || 0;
  this.session.account_renewal_url = data.renewal_url || '';
  this.saveSession();
};

// subscription-userinfo, as SubscriptionPinger.kt reads it: used = upload + download.
Controller.prototype.readUserInfo = function (headerFile) {
  var raw = '';
  try { raw = fs.readFileSync(headerFile, 'utf8'); fs.unlinkSync(headerFile); } catch (ignore) { return; }
  var match = raw.match(/^subscription-userinfo:\s*(.+)$/im);
  if (!match) { return; }
  var parts = {};
  match[1].split(';').forEach(function (item) {
    var pair = item.split('=');
    if (pair.length === 2) { parts[pair[0].trim().toLowerCase()] = parseInt(pair[1].trim(), 10); }
  });
  if (!isNaN(parts.upload) || !isNaN(parts.download)) { this.session.usage_used = (parts.upload || 0) + (parts.download || 0); }
  if (!isNaN(parts.total)) { this.session.usage_total = parts.total; }
  this.saveSession();
};

// Bot API calls the settings screens make, answered with the HTTP status and
// Retry-After so the UI maps errors exactly as the Android view models do.
var BOT_PROXY_PATHS = [
  /^GET api\/devices$/, /^POST api\/device\/unlink$/,
  /^GET api\/user\/promocodes\?limit=\d+&offset=\d+$/, /^POST api\/user\/promocodes\/activate$/,
  /^GET api\/referrals\?limit=\d+&offset=\d+$/, /^POST api\/device\/referrer$/
];
Controller.prototype.botProxy = function (method, path, payload) {
  var allowed = BOT_PROXY_PATHS.some(function (rule) { return rule.test(method + ' ' + path); });
  if (!allowed) { throw new Error('Запрос не разрешён'); }
  var headerFile = STATE + '/bot.headers';
  var response = this.curl(method, this.apiUrl(path), method === 'GET' ? null : (payload || {}), this.accessToken(), null, 20, headerFile);
  if (response.status === 401 || response.status === 403) {
    try { this.bootstrap(); response = this.curl(method, this.apiUrl(path), method === 'GET' ? null : (payload || {}), this.accessToken(), null, 20, headerFile); } catch (ignore) {}
  }
  var retryAfter = '';
  try { var raw = fs.readFileSync(headerFile, 'utf8'); fs.unlinkSync(headerFile); var m = raw.match(/^retry-after:\s*(.+)$/im); if (m) { retryAfter = m[1].trim(); } } catch (ignore) {}
  return { status: response.status, body: response.body, retry_after: retryAfter, device_id: this.session.device_id || '' };
};

// AuthRepository.logout: unlink this device (the backend resolves it from the
// session), fall back to the session-only logout, then forget the account.
Controller.prototype.logout = function () {
  this.disconnect(false);
  var unlinked = false;
  try { var r = this.api('POST', 'api/device/unlink', {}); unlinked = r.status < 300 && r.body.success === true; } catch (ignore) {}
  if (!unlinked) { try { this.api('POST', 'api/device/logout', {}); } catch (ignore) {} }
  this.session = { device_id: this.session.device_id };
  this.saveSession();
  this.servers = []; this.saveServers();
  return this.publicStatus();
};

// CurrencyRepository: open.er-api.com, RUB base.
Controller.prototype.rubToUsd = function () {
  var response = this.curl('GET', 'https://open.er-api.com/v6/latest/RUB', null, null, null, 10);
  var rate = response.body && response.body.rates ? response.body.rates.USD : null;
  return { rate: typeof rate === 'number' ? rate : null };
};

Controller.prototype.purchasePlans = function () {
  var response = this.api('GET', 'api/purchase/plans');
  if (response.status >= 300 || !response.body.success) { throw new Error(response.body.message || 'Не удалось загрузить тарифы'); }
  return response.body.data || { plans: [] };
};

/*
 * ServerQualityRepository.kt: the ping is the TCP connect time to the server's
 * address and port, every resolved address in turn (Go's dialSerial budget,
 * at least 2 s each), 16 at a time, one probe per address:port:sni, cached
 * 15 s. Hysteria2 runs over UDP, so its ping is a request through Xray. The
 * Android app is excluded from its own VPN; here the probe sockets are bound
 * to the Wi-Fi address, which a policy rule keeps out of the tunnel.
 */
var PING_CACHE_TTL_MS = 15000;
var DNS_LOOKUP_GRACE_MS = 1500;
var MIN_ADDRESS_ATTEMPT_MS = 2000;
var MAX_CONCURRENT_PINGS = 16;
var PROFILE_CACHE_TTL_MS = 3 * 60 * 1000;
var LAN_BYPASS_PREF = 20006;
// A TCP ping that has not connected in 2 s (DNS included) is "unavailable":
// room for one SYN retransmit (sent after 1 s) and a slow DNS answer;
// the list must not wait out the 7 s setting for a silent server.
var TCP_PING_BUDGET_MS = 2000;
function tcpBudget(timeoutMs) { return Math.min(timeoutMs, TCP_PING_BUDGET_MS); }
var PROFILE_PROBE_SLOTS = parseInt(process.env.TOBEVPN_PROBE_SLOTS || '4', 10);

function endpointKey(server) { return (server.protocol === 'hysteria2' ? 'hy2:' : '') + server.address + ':' + server.port + ':' + (server.sni || ''); }
function profileKey(server) { return String(server.link || '').split('#')[0] || endpointKey(server); }
function timeoutSecondsMs(value) { return Math.max(5, Math.min(15, parseInt(value, 10) || 7)) * 1000; }

function resolveAll(host, callback) {
  if (net.isIP(host)) { return callback(null, [host]); }
  dns.resolve4(host, function (error, addresses) {
    if (!error && addresses && addresses.length) { return callback(null, addresses); }
    dns.lookup(host, 4, function (lookupError, address) { callback(lookupError || (address ? null : new Error('no address')), address ? [address] : []); });
  });
}

function connectFirstReachable(host, port, timeoutMs, localAddress, callback) {
  var finished = false;
  var overall = setTimeout(function () { finish(-1); }, timeoutMs < TCP_PING_BUDGET_MS + 1 ? timeoutMs : timeoutMs + DNS_LOOKUP_GRACE_MS);
  function finish(ms) { if (finished) { return; } finished = true; clearTimeout(overall); callback(ms); }
  resolveAll(host, function (error, addresses) {
    if (finished) { return; }
    if (error || !addresses.length) { return finish(-1); }
    var deadline = Date.now() + timeoutMs;
    (function attempt(index) {
      if (finished) { return; }
      var remaining = deadline - Date.now();
      if (index >= addresses.length || remaining <= 0) { return finish(-1); }
      var budget = Math.max(1, Math.floor(Math.max(remaining / (addresses.length - index), Math.min(remaining, MIN_ADDRESS_ATTEMPT_MS))));
      var started = Date.now(); var settled = false;
      var options = { host: addresses[index], port: port }; if (localAddress) { options.localAddress = localAddress; }
      var socket = net.connect(options);
      var timer = setTimeout(function () { next(); }, budget);
      function next() { if (settled) { return; } settled = true; clearTimeout(timer); socket.destroy(); attempt(index + 1); }
      socket.on('connect', function () { if (settled) { return; } settled = true; clearTimeout(timer); var ms = Math.max(1, Date.now() - started); socket.destroy(); finish(ms); });
      socket.on('error', next);
    }(0));
  });
}

Controller.prototype.lanAddress = function () {
  var match = /inet (\d+\.\d+\.\d+\.\d+)/.exec(run(IP, ['-4', 'addr', 'show', 'dev', 'wlan0']).stdout);
  return match ? match[1] : null;
};
Controller.prototype.ensureLanBypass = function () {
  var address = this.lanAddress(); if (!address) { return null; }
  if (run(IP, ['rule', 'show']).stdout.indexOf('from ' + address + ' lookup main') < 0) {
    this.deleteRule(LAN_BYPASS_PREF);
    run(IP, ['rule', 'add', 'from', address, 'lookup', 'main', 'pref', String(LAN_BYPASS_PREF)]);
  }
  return address;
};

// Runs connectFirstReachable for [{key, host, port}] in the long-lived worker
// process; onEach(key, ms) fires as each one finishes, done(results) at the end.
Controller.prototype.pingWorker = function () {
  var self = this;
  if (this.worker) { return this.worker; }
  var worker = { proc: child.spawn(process.execPath, [__filename, '--tcp-ping'], { stdio: ['pipe', 'pipe', 'ignore'] }), batches: {}, buffer: '' };
  worker.proc.stdout.on('data', function (chunk) {
    worker.buffer += chunk; var lines = worker.buffer.split('\n'); worker.buffer = lines.pop();
    lines.forEach(function (line) {
      var parts = line.split(' '); var batch = worker.batches[parts[0]]; if (!batch) { return; }
      if (parts[1] === 'done') { batch.finish(); } else if (parts.length === 3) { batch.result(parts[1], parseInt(parts[2], 10)); }
    });
  });
  function gone() { if (self.worker !== worker) { return; } self.worker = null; Object.keys(worker.batches).forEach(function (id) { worker.batches[id].finish(); }); }
  worker.proc.on('exit', gone); worker.proc.on('error', gone);
  this.worker = worker;
  return worker;
};
Controller.prototype.tcpPingBatch = function (items, timeoutMs, onEach, done) {
  var results = {};
  if (!items.length) { return done(results); }
  var local = this.ensureLanBypass();
  var worker = this.pingWorker();
  this.pingBatchId = (this.pingBatchId || 0) + 1; var id = 'b' + this.pingBatchId;
  var finished = false;
  var guard = setTimeout(function () { batch.finish(); }, tcpBudget(timeoutMs) + 1500);
  var batch = {
    result: function (key, ms) { if (finished || results[key] !== undefined) { return; } results[key] = ms; onEach(key, ms); },
    finish: function () {
      if (finished) { return; } finished = true; clearTimeout(guard); delete worker.batches[id];
      items.forEach(function (item) { if (results[item.key] === undefined) { results[item.key] = -1; onEach(item.key, -1); } });
      done(results);
    }
  };
  worker.batches[id] = batch;
  try { worker.proc.stdin.write(JSON.stringify({ id: id, jobs: items.map(function (item) { return { key: item.key, host: item.host, port: item.port, timeout: tcpBudget(timeoutMs), local: local }; }) }) + '\n'); }
  catch (error) { batch.finish(); }
};

/*
 * ServerQualityRepository.kt: a record per address:port:sni of how
 * connections went (success, failure, healthy tunnel, traffic), kept 90 days,
 * at most 100. The score is the ping plus failure and reliability penalties
 * minus success, recent-health and traffic bonuses; automatic selection takes
 * the lowest score.
 */
var QUALITY_FILE = STATE + '/server_quality.json';
var HEALTHY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
var FAILURE_FULL_PENALTY_MS = 30 * 60 * 1000;
var FAILURE_DECAY_MS = 6 * 60 * 60 * 1000;
var RECENT_HEALTHY_BONUS_MS = 24 * 60 * 60 * 1000;
var RECENT_TRAFFIC_BONUS_MS = 24 * 60 * 60 * 1000;
var RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
var FAILURE_PENALTY_MS = 600;
var MAX_RELIABILITY_PENALTY_MS = 120;
var MIN_RELIABILITY_SAMPLES = 3;
var TRAFFIC_BONUS_STEP_BYTES = 10 * 1024 * 1024;
var MAX_CONFIRMED_TRAFFIC_BYTES = 50 * 1024 * 1024;
var MAX_COUNTER = 100;
var MAX_CONSECUTIVE_FAILURES = 5;
var MAX_RECORDS = 100;

function emptyRecord() { return { successfulConnections: 0, failedConnections: 0, consecutiveFailures: 0, lastSuccessAt: 0, lastFailureAt: 0, lastHealthyAt: 0, lastTrafficAt: 0, confirmedTrafficBytes: 0 }; }
function newestTimestamp(r) { return Math.max(r.lastSuccessAt, r.lastFailureAt, r.lastHealthyAt, r.lastTrafficAt); }
function recencyBonus(timestamp, now, windowMs, maxBonus) { if (timestamp <= 0) { return 0; } var age = now - timestamp; if (age >= windowMs) { return 0; } return maxBonus * (1 - age / windowMs); }
function qualityScore(ping, record, now) {
  if (!record) { return ping; }
  var failureAge = now - record.lastFailureAt; var failureWeight;
  if (record.lastFailureAt <= 0 || failureAge >= FAILURE_DECAY_MS) { failureWeight = 0; }
  else if (failureAge <= FAILURE_FULL_PENALTY_MS) { failureWeight = 1; }
  else { failureWeight = 1 - (failureAge - FAILURE_FULL_PENALTY_MS) / (FAILURE_DECAY_MS - FAILURE_FULL_PENALTY_MS); }
  var failurePenalty = record.consecutiveFailures * FAILURE_PENALTY_MS * failureWeight;
  var observed = record.successfulConnections + record.failedConnections;
  var reliabilityPenalty = observed >= MIN_RELIABILITY_SAMPLES ? record.failedConnections / observed * MAX_RELIABILITY_PENALTY_MS : 0;
  var successBonus = Math.min(record.successfulConnections, 4) * 5;
  var healthyBonus = recencyBonus(record.lastHealthyAt, now, RECENT_HEALTHY_BONUS_MS, 25);
  var trafficBonus = recencyBonus(record.lastTrafficAt, now, RECENT_TRAFFIC_BONUS_MS, 40);
  var trafficVolumeBonus = Math.min(Math.floor(record.confirmedTrafficBytes / TRAFFIC_BONUS_STEP_BYTES), 5) * 3;
  return ping + failurePenalty + reliabilityPenalty - successBonus - healthyBonus - trafficBonus - trafficVolumeBonus;
}
function nextConsecutiveFailures(record, now) {
  var previous = record.lastFailureAt <= 0 || now - record.lastFailureAt >= FAILURE_DECAY_MS ? 0 : record.consecutiveFailures;
  return Math.min(previous + 1, MAX_CONSECUTIVE_FAILURES);
}
Controller.prototype.qualityRecords = function () { if (!this.quality) { this.quality = readJson(QUALITY_FILE, { records: {} }); this.quality.records = this.quality.records || {}; } return this.quality.records; };
Controller.prototype.updateRecord = function (server, minWriteIntervalMs, transform) {
  var records = this.qualityRecords(); var key = endpointKey(server); var now = Date.now();
  var current = records[key] || emptyRecord();
  if (minWriteIntervalMs > 0 && now - current.lastHealthyAt < minWriteIntervalMs && current.lastFailureAt <= current.lastHealthyAt) { return; }
  records[key] = transform(current, now);
  var kept = Object.keys(records).filter(function (k) { return newestTimestamp(records[k]) >= now - RECORD_RETENTION_MS; })
    .sort(function (a, b) { return newestTimestamp(records[b]) - newestTimestamp(records[a]); }).slice(0, MAX_RECORDS);
  var next = {}; kept.forEach(function (k) { next[k] = records[k]; });
  this.quality.records = next;
  writeJson(QUALITY_FILE, this.quality);
};
function copyRecord(r, changes) { var out = {}; Object.keys(r).forEach(function (k) { out[k] = r[k]; }); Object.keys(changes).forEach(function (k) { out[k] = changes[k]; }); return out; }
Controller.prototype.recordConnectionSuccess = function (server) { this.updateRecord(server, 0, function (r, now) { return copyRecord(r, { successfulConnections: Math.min(r.successfulConnections + 1, MAX_COUNTER), lastSuccessAt: now }); }); };
Controller.prototype.recordConnectionFailure = function (server) { this.updateRecord(server, 0, function (r, now) { return copyRecord(r, { failedConnections: Math.min(r.failedConnections + 1, MAX_COUNTER), consecutiveFailures: nextConsecutiveFailures(r, now), lastFailureAt: now }); }); };
Controller.prototype.recordTunnelHealthy = function (server) { this.updateRecord(server, HEALTHY_WRITE_INTERVAL_MS, function (r, now) { return copyRecord(r, { consecutiveFailures: 0, lastHealthyAt: now }); }); };
Controller.prototype.recordTunnelFailure = function (server) { this.updateRecord(server, 0, function (r, now) { return copyRecord(r, { failedConnections: Math.min(r.failedConnections + 1, MAX_COUNTER), consecutiveFailures: nextConsecutiveFailures(r, now), lastFailureAt: now }); }); };
Controller.prototype.recordTraffic = function (server, bytes) {
  if (bytes <= 0) { return; }
  this.updateRecord(server, 0, function (r, now) { return copyRecord(r, { consecutiveFailures: 0, lastTrafficAt: now, confirmedTrafficBytes: Math.min(r.confirmedTrafficBytes + bytes, MAX_CONFIRMED_TRAFFIC_BYTES) }); });
};

// Lowest score, then ping, then name (selectBestServer / selectBestVerifiedServer).
Controller.prototype.rankServers = function (delays) {
  var records = this.qualityRecords(); var now = Date.now(); var best = null;
  this.servers.forEach(function (server, index) {
    var ping = delays[index]; if (!(ping > 0)) { return; }
    var entry = { index: index, ping: ping, name: server.name || '', score: qualityScore(ping, records[endpointKey(server)], now) };
    if (!best || entry.score < best.score || (entry.score === best.score && (entry.ping < best.ping || (entry.ping === best.ping && entry.name < best.name)))) { best = entry; }
  });
  return best ? best.index : null;
};
// selectBestVerifiedServer: profiles a check carried a request through.
Controller.prototype.bestVerifiedServer = function (onlyFresh) {
  var cache = this.profileCache || {}; var now = Date.now(); var check = this.profileCheck;
  var delays = this.servers.map(function (server) {
    var key = profileKey(server);
    if (onlyFresh) { var cached = cache[key]; return cached && now - cached.at <= PROFILE_CACHE_TTL_MS ? cached.delay : -1; }
    return check && check.results[key] !== undefined ? check.results[key] : -1;
  });
  return this.rankServers(delays);
};
// selectBestServer: TCP pings, scored; the first server when nothing answered.
Controller.prototype.bestServer = function (timeoutSeconds, force, callback) {
  var self = this;
  this.pingServers(timeoutSeconds, force, function (result) {
    var best = self.rankServers(result.pings);
    callback({ index: best !== null ? best : (self.servers.length ? 0 : null), pings: result.pings });
  });
};

/*
 * VpnConnectionManager.kt tunnel validation: 500 ms after the start one
 * request (gstatic, example.com; 5 s each, 11.5 s in all) through the tunnel;
 * then every 30 s up to 3 attempts 3 s apart over three targets. A failed
 * probe after at least 16 KB of downlink in the 25 s before it does not count
 * (liveness); two failed cycles in a row are a confirmed failure. Healthy
 * marks the record, and the first healthy check of a connection counts as a
 * success. 64 KB of downlink confirms traffic once per connection.
 */
var TUNNEL_STARTUP_PROBE_TARGETS = ['https://www.gstatic.com/generate_204', 'https://www.example.com/'];
var TUNNEL_PROBE_TARGETS = TUNNEL_STARTUP_PROBE_TARGETS.concat(['https://repo1.maven.org/maven2/']);
var QUALITY_DOWNLINK_CONFIRM_BYTES = 64 * 1024;
var RECENT_DOWNLINK_GRACE_MS = 25000;
var MIN_DOWNLINK_BYTES = 16 * 1024;

function tunnelProbeUrl(target, callback) {
  var out = '';
  var proc = child.spawn('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '5', '--max-time', '5', '-x', 'socks5h://127.0.0.1:' + SOCKS_PORT, target]);
  proc.stdout.on('data', function (chunk) { out += chunk; });
  proc.on('close', function () { var code = parseInt(out, 10); callback(code >= 200 && code <= 399); });
  proc.on('error', function () { callback(false); });
  return proc;
}
function tunnelProbeOnce(targets, callback) {
  (function next(i) { if (i >= targets.length) { return callback(false); } tunnelProbeUrl(targets[i], function (ok) { if (ok) { callback(true); } else { next(i + 1); } }); }(0));
}
Controller.prototype.readRx = function () { try { return parseInt(fs.readFileSync('/sys/class/net/tobe0/statistics/rx_bytes', 'utf8'), 10) || 0; } catch (ignore) { return -1; } };
Controller.prototype.startTunnelHealth = function (index, server) {
  var self = this; this.stopTunnelHealth();
  var watch = { index: index, server: server, failures: 0, succeeded: false, trafficConfirmed: false, timers: [], probing: false, lastRx: this.readRx(), rxSinceProbe: 0, lastDownAt: 0, totalDown: 0 };
  this.health = watch;
  function alive() { return self.health === watch && self.connectedIndex === index; }
  function later(ms, fn) { watch.timers.push(setTimeout(function () { if (alive()) { fn(); } }, ms)); }
  function confirmHealthy() { self.recordTunnelHealthy(server); if (!watch.succeeded) { watch.succeeded = true; self.recordConnectionSuccess(server); } }
  // Downlink counter, once a second; probe responses are not evidence.
  watch.timers.push(setInterval(function () {
    if (!alive()) { return; }
    var rx = self.readRx(); if (rx < 0) { return; }
    var delta = Math.max(0, rx - watch.lastRx); watch.lastRx = rx;
    if (delta <= 0) { return; }
    watch.totalDown += delta;
    if (!watch.probing) { watch.rxSinceProbe += delta; watch.lastDownAt = Date.now(); }
    if (!watch.trafficConfirmed && watch.totalDown >= QUALITY_DOWNLINK_CONFIRM_BYTES) { watch.trafficConfirmed = true; self.recordTraffic(server, watch.totalDown); }
  }, 1000));
  function probeWithRetries(attempts, targets, callback) {
    var startedAt = Date.now(); var evidence = { bytes: watch.rxSinceProbe, at: watch.lastDownAt };
    watch.rxSinceProbe = 0; watch.probing = true;
    (function attempt(i) {
      tunnelProbeOnce(targets, function (ok) {
        if (!alive()) { return; }
        if (ok || i >= attempts - 1) { watch.probing = false; return callback(ok, startedAt, evidence); }
        later(3000, function () { attempt(i + 1); });
      });
    }(0));
  }
  function periodic() {
    probeWithRetries(3, TUNNEL_PROBE_TARGETS, function (ok, startedAt, evidence) {
      var liveness = !ok && evidence.bytes >= MIN_DOWNLINK_BYTES && evidence.at > 0 && evidence.at <= startedAt && startedAt - evidence.at <= RECENT_DOWNLINK_GRACE_MS;
      if (ok || liveness) { watch.failures = 0; confirmHealthy(); }
      else { watch.failures += 1; if (watch.failures >= 2) { watch.failures = 0; self.recordTunnelFailure(server); safeLog('Tunnel validation confirmed failure: index ' + index); } }
      later(30000, periodic);
    });
  }
  later(500, function () {
    var done = false;
    var cap = setTimeout(function () { if (!done && alive()) { done = true; watch.probing = false; self.recordTunnelFailure(server); later(30000, periodic); } }, 11500);
    watch.timers.push(cap);
    probeWithRetries(1, TUNNEL_STARTUP_PROBE_TARGETS, function (ok) {
      if (done) { return; } done = true; clearTimeout(cap);
      if (ok) { confirmHealthy(); } else { self.recordTunnelFailure(server); safeLog('Startup tunnel validation failed: index ' + index); }
      later(30000, periodic);
    });
  });
};
Controller.prototype.stopTunnelHealth = function () {
  if (!this.health) { return; }
  this.health.timers.forEach(function (timer) { clearTimeout(timer); clearInterval(timer); });
  this.health = null;
};

// currentPhysicalNetworkKey: results measured on another network are void.
Controller.prototype.networkKey = function () {
  return (this.lanAddress() || '') + '|' + run(IP, ['-4', 'route', 'show', 'default']).stdout.trim();
};

// syncSubscription under withTimeoutOrNull(4 s): panel user, then the plan.
Controller.prototype.syncSubscription = function (timeoutMs) {
  if (!this.session.is_linked) { return { synced: false }; }
  this.deadline = Date.now() + (timeoutMs || 4000);
  var synced = true;
  try { this.resolveSubscriptionUrl(); this.syncAccount(); this.saveSession(); }
  catch (error) { synced = false; safeLog('Subscription sync stopped: ' + error.message); }
  this.deadline = null;
  return { synced: synced };
};

/* Runs every given server through a throwaway Xray: one SOCKS inbound per
   server, an HTTP 204 through it (both targets, first success wins).
   start() returns a function that probes one server index. */
Controller.prototype.coreProber = function (indexes, timeoutMs, ready) {
  var self = this;
  // VpnConfig.buildOutboundDelayConfigJson: the connection's outbound with no
  // dns section (the system resolver), no mux, no stats or policy.
  var config = { log: { loglevel: 'none' }, inbounds: [], outbounds: [], routing: { domainStrategy: 'AsIs', rules: [] } };
  var ports = {};
  indexes.forEach(function (index) {
    var server = self.servers[index]; var outbound;
    try { outbound = buildXrayConfig(server, server.address).outbounds[0]; } catch (ignore) { return; }
    outbound.tag = 'probe' + index;
    outbound.streamSettings = outbound.streamSettings || {};
    outbound.streamSettings.sockopt = { mark: PROBE_MARK };
    config.inbounds.push({ tag: 'in' + index, listen: '127.0.0.1', port: PROBE_BASE_PORT + index, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
    config.outbounds.push(outbound);
    config.routing.rules.push({ type: 'field', inboundTag: ['in' + index], outboundTag: 'probe' + index });
    ports[index] = PROBE_BASE_PORT + index;
  });
  var api = { stop: function () {}, probe: function (index, callback) { callback(-1); } };
  if (!config.inbounds.length) { return ready(api); }
  config.outbounds.push({ tag: 'direct', protocol: 'freedom', settings: {}, streamSettings: { sockopt: { mark: PROBE_MARK } } });
  writeJson(PROBE_CONFIG, config);
  this.ensureProbeRule();
  var xray = child.spawn(XRAY_BIN, ['run', '-c', PROBE_CONFIG], { stdio: 'ignore' });
  var dead = false; xray.on('error', function () { dead = true; }); xray.on('exit', function () { dead = true; });
  // 4, not MAX_CONCURRENT_PROFILE_PROBES = 16: measured on this TV, sixteen
  // parallel checks gave 36-409 ms where four gave 28-100 ms for the same
  // servers; the CPU, not the network, set the numbers.
  var running = 0; var queue = [];
  function pump() {
    while (running < PROFILE_PROBE_SLOTS && queue.length) {
      (function (job) {
        running += 1;
        if (dead || !ports[job.index]) { running -= 1; job.callback(-1); return; }
        probeOne(ports[job.index], timeoutMs, function (ms) { running -= 1; job.callback(ms); pump(); });
      }(queue.shift()));
    }
  }
  api.stop = function () { try { xray.kill('SIGKILL'); } catch (ignore) {} };
  api.probe = function (index, callback) { queue.push({ index: index, callback: callback }); pump(); };
  var firstPort = ports[indexes.filter(function (i) { return ports[i]; })[0]];
  waitForPort(firstPort, 5000, function () { ready(api); });
};

// measurePings(servers, force): -1 is unreachable.
Controller.prototype.pingServers = function (timeoutSeconds, force, callback, onlyIndex) {
  var self = this;
  var timeoutMs = timeoutSecondsMs(timeoutSeconds);
  this.pingCache = this.pingCache || {};
  var now = Date.now(); var byKey = {}; var tcp = []; var core = [];
  this.servers.forEach(function (server, index) {
    var key = endpointKey(server);
    if (byKey[key]) { return; } byKey[key] = { index: index };
    var cached = self.pingCache[key];
    var only = onlyIndex !== undefined && onlyIndex !== null && endpointKey(self.servers[onlyIndex] || {}) !== key;
    if (cached && (only || (!force && cached.timeoutMs === timeoutMs && now - cached.at <= PING_CACHE_TTL_MS))) { byKey[key].ping = cached.ping; return; }
    if (only) { return; }
    (server.protocol === 'hysteria2' ? core : tcp).push(key);
  });
  var left = tcp.length + core.length;
  function finish() {
    callback({ pings: self.servers.map(function (server) { var entry = byKey[endpointKey(server)]; return entry && entry.ping !== undefined ? entry.ping : 0; }) });
  }
  if (!left) { return finish(); }
  // Results so far, for the list to show each server as soon as it answers.
  self.livePings = self.servers.map(function (server) { var entry = byKey[endpointKey(server)]; return entry && entry.ping !== undefined ? entry.ping : 0; });
  function store(key, ms) {
    byKey[key].ping = ms; self.pingCache[key] = { ping: ms, at: Date.now(), timeoutMs: timeoutMs };
    self.servers.forEach(function (server, i) { if (endpointKey(server) === key && self.livePings) { self.livePings[i] = ms; } });
    left -= 1; if (!left) { finish(); }
  }
  this.tcpPingBatch(tcp.map(function (key) { var server = self.servers[byKey[key].index]; return { key: key, host: server.address, port: server.port }; }), timeoutMs, function (key, ms) { store(key, ms); }, function () {});
  if (core.length) {
    this.coreProber(core.map(function (key) { return byKey[key].index; }), timeoutMs, function (prober) {
      var pending = core.length;
      core.forEach(function (key) { prober.probe(byKey[key].index, function (ms) { store(key, ms); pending -= 1; if (!pending) { prober.stop(); } }); });
    });
  }
};

/*
 * ServerProfileProbeRepository.kt: after an explicit refresh every profile is
 * confirmed end to end. Each server goes from its TCP ping straight to an
 * HTTP request through the complete Xray outbound; an open port alone is not
 * a working server. Results come in one by one (the "Checked N of M" card)
 * and are cached for 3 minutes.
 */
Controller.prototype.startProfileCheck = function (timeoutSeconds, force, onlyMissing) {
  var self = this;
  if (this.profileCheck && this.profileCheck.running) { return this.profileState(); }
  var timeoutMs = timeoutSecondsMs(timeoutSeconds);
  this.profileCache = this.profileCache || {};
  var now = Date.now(); var seen = {}; var candidates = [];
  var check = { running: true, completed: 0, total: 0, results: (onlyMissing && this.profileCheck) ? this.profileCheck.results : {}, timeoutMs: timeoutMs, network: this.networkKey() };
  this.servers.forEach(function (server, index) {
    var key = profileKey(server); if (seen[key]) { return; } seen[key] = true;
    if (onlyMissing && check.results[key] !== undefined) { return; }
    candidates.push(index);
  });
  check.total = candidates.length;
  this.profileCheck = check;
  var uncached = [];
  candidates.forEach(function (index) {
    var key = profileKey(self.servers[index]); var cached = self.profileCache[key];
    if (!force && cached && cached.timeoutMs === timeoutMs && cached.network === check.network && now - cached.at <= PROFILE_CACHE_TTL_MS) { check.results[key] = cached.delay; check.completed += 1; }
    else { check.results[key] = 0; uncached.push(index); }
  });
  if (!uncached.length) { check.running = false; return this.profileState(); }
  var left = uncached.length;
  function record(index, delay) {
    var key = profileKey(self.servers[index]);
    check.results[key] = delay; check.completed += 1;
    self.profileCache[key] = { delay: delay, at: Date.now(), timeoutMs: timeoutMs, network: check.network };
    left -= 1;
    if (!left) {
      if (self.networkKey() !== check.network) {
        // The network changed during the check: its results are void.
        Object.keys(check.results).forEach(function (k) { check.results[k] = -1; delete self.profileCache[k]; });
        safeLog('Server profile results discarded after network change');
      }
      check.running = false; if (check.prober) { check.prober.stop(); }
    }
  }
  this.coreProber(uncached, timeoutMs, function (prober) {
    check.prober = prober;
    function full(index) { prober.probe(index, function (delay) { record(index, delay); }); }
    var tcpItems = [];
    // Hysteria2's "TCP ping" is itself a request through the core
    // (measureThroughCore); the full check follows only when it answered.
    uncached.forEach(function (index) { var server = self.servers[index]; if (server.protocol === 'hysteria2') { prober.probe(index, function (ms) { if (ms < 0) { record(index, -1); } else { full(index); } }); } else { tcpItems.push({ key: String(index), host: server.address, port: server.port }); } });
    // Each server goes from its TCP ping straight to the full check.
    self.tcpPingBatch(tcpItems, timeoutMs, function (key, ms) {
      var index = parseInt(key, 10); var server = self.servers[index];
      self.pingCache = self.pingCache || {}; self.pingCache[endpointKey(server)] = { ping: ms, at: Date.now(), timeoutMs: timeoutMs };
      if (ms < 0) { record(index, -1); } else { full(index); }
    }, function () {});
  });
  return this.profileState();
};
Controller.prototype.profileState = function () {
  var check = this.profileCheck;
  if (!check) { return { enabled: false, running: false, completed: 0, total: 0, pings: [] }; }
  return {
    enabled: true, running: check.running, completed: check.completed, total: check.total,
    pings: this.servers.map(function (server) { var value = check.results[profileKey(server)]; return value === undefined ? null : value; })
  };
};

/*
 * SpeedTestViewModel.kt: Cloudflare then Selectel; preflight 5 s; ping is the
 * median of 7 requests on a warmed connection; download is 2 x 1 MB warm-up,
 * then 4 streams of 25 MB requests for 10 s, published every 250 ms. With the
 * VPN up it goes through Xray's SOCKS inbound, like the Android build.
 */
var SPEED_PROVIDERS = [
  { name: 'CLOUDFLARE', latency: function () { return ['https://speed.cloudflare.com/__down?bytes=0&cacheBust=' + Math.random()]; }, head: false,
    download: function (bytes, suffix) { return { url: 'https://speed.cloudflare.com/__down?bytes=' + bytes + '&cacheBust=' + suffix, range: null }; } },
  { name: 'SELECTEL', latency: function () { return ['https://speedtest.selectel.ru/10MB']; }, head: true,
    download: function (bytes, suffix) { return { url: 'https://speedtest.selectel.ru/100MB?cacheBust=' + suffix, range: '0-' + (bytes - 1) }; } }
];

function SpeedTest(viaVpn, onFinish) {
  this.viaVpn = viaVpn; this.onFinish = onFinish; this.procs = []; this.cancelled = false;
  this.state = { phase: 'Checking', ping: 0, downloadSpeed: 0, currentSpeed: 0, progress: 0, error: null, viaVpn: viaVpn };
}
SpeedTest.prototype.curlArgs = function (extra) {
  var args = ['-s', '-H', 'Accept-Encoding: identity', '-H', 'Cache-Control: no-cache, no-store', '--connect-timeout', '15'];
  if (this.viaVpn) { args.push('-x', 'socks5h://127.0.0.1:' + SOCKS_PORT); }
  return args.concat(extra);
};
SpeedTest.prototype.spawn = function (args) {
  var proc = child.spawn('/usr/bin/curl', args); this.procs.push(proc);
  var self = this;
  proc.on('close', function () { var i = self.procs.indexOf(proc); if (i >= 0) { self.procs.splice(i, 1); } });
  return proc;
};
SpeedTest.prototype.cancel = function () {
  this.cancelled = true;
  this.procs.forEach(function (proc) { try { proc.kill('SIGKILL'); } catch (ignore) {} });
  this.procs = [];
};
// Latency requests in one curl process, so later ones reuse the connection.
SpeedTest.prototype.latency = function (provider, count, timeoutSeconds, callback) {
  var urls = []; var i; var out = '';
  for (i = 0; i < count; i += 1) { urls = urls.concat(provider.latency()); }
  var args = this.curlArgs(['-o', '/dev/null', '-w', '%{http_code} %{time_total}\n', '--max-time', String(timeoutSeconds)]);
  if (provider.head) { args.push('-I'); }
  var proc = this.spawn(args.concat(urls));
  proc.stdout.on('data', function (chunk) { out += chunk; });
  proc.on('close', function () {
    var times = [];
    out.trim().split('\n').forEach(function (line) {
      var parts = line.split(' '); var code = parseInt(parts[0], 10);
      if (code >= 200 && code < 300) { times.push(Math.round(parseFloat(parts[1]) * 1000)); }
    });
    callback(times.length === count ? times : null);
  });
};
SpeedTest.prototype.download = function (provider, callback) {
  var self = this; var total = 0; var rejected = false; var started; var deadline; var done = 0; var timer;
  function request(bytes, suffix, onEnd) {
    var req = provider.download(bytes, suffix);
    var args = self.curlArgs(['-f', '-o', '-', '--max-time', '25']);
    if (req.range) { args.push('-H', 'Range: bytes=' + req.range); }
    var proc = self.spawn(args.concat([req.url]));
    proc.stdout.on('data', function (chunk) { if (started && Date.now() < deadline) { total += chunk.length; } });
    proc.on('close', function (code) { if (code === 22) { rejected = true; } onEnd(code); });
  }
  var warm = 0;
  function warmed() {
    warm += 1; if (warm < 2) { return; }
    if (self.cancelled) { return; }
    if (rejected) { return callback({ mbps: 0, rejected: true }); }
    started = Date.now(); deadline = started + 10000;
    timer = setInterval(function () {
      var elapsed = (Math.min(Date.now(), deadline) - started) / 1000;
      self.state.currentSpeed = elapsed > 0 ? total * 8 / (elapsed * 1e6) : 0;
      self.state.progress = Math.min(1, elapsed / 10);
    }, 250);
    var w;
    for (w = 0; w < 4; w += 1) { worker(w, 0, 0); }
  }
  function worker(index, n, failures) {
    if (self.cancelled || rejected || Date.now() >= deadline) { return finish(); }
    request(25000000, index + '-' + n + '-' + Math.random(), function (code) {
      if (code !== 0 && Date.now() < deadline && !self.cancelled) {
        if (code === 22) { return finish(); }
        failures += 1;
        if (failures >= 2) { return finish(); }
        return setTimeout(function () { worker(index, n + 1, failures); }, 250 * failures);
      }
      worker(index, n + 1, 0);
    });
  }
  function finish() {
    done += 1; if (done < 4) { return; }
    clearInterval(timer);
    var seconds = (Math.min(Date.now(), deadline) - started) / 1000;
    callback({ mbps: total > 0 && seconds > 0 ? total * 8 / (seconds * 1e6) : 0, rejected: rejected });
  }
  request(1000000, 'w1-' + Math.random(), warmed);
  request(1000000, 'w2-' + Math.random(), warmed);
  // Stop every stream at the deadline, as the Android deadlineStopper does.
  this.deadlineWatch = setInterval(function () {
    if (deadline && Date.now() >= deadline) { clearInterval(self.deadlineWatch); self.procs.forEach(function (proc) { try { proc.kill('SIGKILL'); } catch (ignore) {} }); }
  }, 100);
};
SpeedTest.prototype.run = function () {
  var self = this; var order = [];
  function fail(error) { self.state = { phase: 'Done', ping: 0, downloadSpeed: 0, currentSpeed: 0, progress: 0, error: error, viaVpn: self.viaVpn }; self.onFinish(null); }
  (function preflight(i) {
    if (self.cancelled) { return; }
    if (i >= SPEED_PROVIDERS.length) { return fail('speed_no_connection'); }
    self.latency(SPEED_PROVIDERS[i], 1, 5, function (times) {
      if (!times) { return preflight(i + 1); }
      order = [SPEED_PROVIDERS[i]].concat(SPEED_PROVIDERS.filter(function (p) { return p !== SPEED_PROVIDERS[i]; }));
      tryProvider(0);
    });
  }(0));
  function tryProvider(i) {
    if (self.cancelled) { return; }
    if (i >= order.length) { return fail('speed_measure_failed'); }
    var provider = order[i];
    self.state.phase = 'Ping'; self.state.ping = 0; self.state.currentSpeed = 0; self.state.progress = 0;
    self.latency(provider, 8, 20, function (times) {
      if (self.cancelled) { return; }
      if (!times) { return tryProvider(i + 1); }
      var samples = times.slice(1).sort(function (a, b) { return a - b; });
      self.state.ping = samples[Math.floor(samples.length / 2)];
      self.state.phase = 'Download'; self.state.progress = 0;
      self.download(provider, function (result) {
        if (self.cancelled) { return; }
        if (!(result.mbps > 0) || result.rejected) { return tryProvider(i + 1); }
        self.state.phase = 'Done'; self.state.downloadSpeed = result.mbps; self.state.currentSpeed = result.mbps; self.state.progress = 1; self.state.error = null;
        self.onFinish({ timestamp: Date.now(), download: result.mbps, ping: self.state.ping, viaVpn: self.viaVpn });
      });
    });
  }
};

Controller.prototype.speedHistory = function () { return readJson(SPEED_HISTORY_FILE, []); };
Controller.prototype.startSpeedTest = function () {
  var self = this;
  if (this.speedTest) { this.speedTest.cancel(); }
  var test = new SpeedTest(this.connectedIndex !== null, function (entry) {
    if (!entry) { return; }
    var history = [entry].concat(self.speedHistory()).sort(function (a, b) { return b.timestamp - a.timestamp; }).slice(0, 100);
    writeJson(SPEED_HISTORY_FILE, history);
  });
  this.speedTest = test; test.run();
  return test.state;
};
Controller.prototype.stopSpeedTest = function () {
  if (this.speedTest) { this.speedTest.cancel(); this.speedTest = null; }
  return { phase: 'Idle' };
};
Controller.prototype.speedState = function () { return this.speedTest ? this.speedTest.state : { phase: 'Idle', ping: 0, downloadSpeed: 0, currentSpeed: 0, progress: 0, error: null }; };
Controller.prototype.deleteSpeedEntry = function (timestamp) {
  writeJson(SPEED_HISTORY_FILE, this.speedHistory().filter(function (e) { return String(e.timestamp) !== String(timestamp); }));
  return { history: this.speedHistory() };
};

Controller.prototype.ensureProbeRule = function () {
  if (run(IP, ['rule', 'show']).stdout.indexOf('fwmark 0x2a') < 0) {
    run(IP, ['rule', 'add', 'fwmark', String(PROBE_MARK), 'lookup', 'main', 'pref', '20005']);
  }
};

function waitForPort(port, limitMs, callback) {
  var started = Date.now();
  (function attempt() {
    var socket = net.connect({ host: '127.0.0.1', port: port });
    socket.on('connect', function () { socket.destroy(); callback(); });
    socket.on('error', function () {
      socket.destroy();
      if (Date.now() - started > limitMs) { return callback(); }
      setTimeout(attempt, 100);
    });
  }());
}

// One server: both targets in parallel, the first 2xx answer wins; -1 when none does.
// Libv2ray measureInstDelay (AndroidLibXrayLite v26.10.21): two GETs over one
// keep-alive connection, the shorter one counts, so the handshakes of the
// first request stay out of the result. curl reuses the connection for a URL
// given twice. Both targets run at once; the first to answer wins.
function probeOne(port, timeoutMs, callback) {
  var answered = false; var pending = PROBE_TARGETS.length; var procs = [];
  PROBE_TARGETS.forEach(function (target) {
    var out = '';
    var proc = child.spawn('/usr/bin/curl', ['-s', '-o', '/dev/null', '-o', '/dev/null', '-w', '%{http_code} %{time_total}\n', '--max-time', String(timeoutMs / 1000), '-x', 'socks5h://127.0.0.1:' + port, target, target]);
    procs.push(proc);
    proc.stdout.on('data', function (chunk) { out += chunk; });
    proc.on('close', function () {
      pending -= 1;
      var best = -1;
      out.trim().split('\n').forEach(function (line) {
        var parts = line.trim().split(' '); var code = parseInt(parts[0], 10); var seconds = parseFloat(parts[1]);
        if ((code === 200 || code === 204) && seconds > 0) { var ms = Math.max(1, Math.round(seconds * 1000)); if (best < 0 || ms < best) { best = ms; } }
      });
      if (!answered && best > 0) {
        answered = true;
        procs.forEach(function (other) { try { other.kill('SIGKILL'); } catch (ignore) {} });
        return callback(best);
      }
      if (!pending && !answered) { answered = true; callback(-1); }
    });
  });
}

Controller.prototype.refreshProfile = function () {
  var target = this.session.subscription_url || this.resolveSubscriptionUrl();
  if (!target) { throw new Error('Ссылка подписки недоступна'); }
  var headers = {
    'x-hwid': this.session.device_id || '', 'x-device-os': 'Android TV',
    'x-ver-os': this.config.webos_version || '3.9', 'x-device-model': this.config.device_model || 'LG TV',
    'User-Agent': this.config.user_agent || 'ToBeVPN/1.0.35/webos/1'
  };
  var headerFile = STATE + '/profile.headers';
  var response = this.curl('GET', target, null, null, headers, 20, headerFile);
  this.readUserInfo(headerFile);
  if (response.status >= 300) { throw new Error('Профиль вернул HTTP ' + response.status); }
  var body = response.body.raw !== undefined ? response.body.raw : JSON.stringify(response.body);
  var parsed = [];
  parseProfileLinks(body).forEach(function (link) {
    try {
      var server = parseServer(link);
      if (server.uuid !== '00000000-0000-0000-0000-000000000000' && server.address !== '127.0.0.1' && server.address !== '0.0.0.0') { parsed.push(server); }
    } catch (ignore) {}
  });
  if (!parsed.length) { throw new Error('В подписке нет совместимых серверов'); }
  this.servers = parsed;
  this.saveServers();
  return { servers: this.servers.map(publicServer) };
};

Controller.prototype.deleteRule = function (pref) {
  var count;
  for (count = 0; count < 8; count += 1) {
    if (run(IP, ['rule', 'del', 'pref', String(pref)]).status !== 0) { break; }
  }
};

Controller.prototype.cleanupRoutes = function () {
  this.deleteRule(20100); this.deleteRule(20020); this.deleteRule(20010); this.deleteRule(20005);
  run(IP, ['route', 'flush', 'table', '20']);
  run(IP, ['link', 'del', 'tobe0']);
};

Controller.prototype.cleanupPolicy = function () {
  this.deleteRule(20100); this.deleteRule(20020); this.deleteRule(20010);
  run(IP, ['route', 'flush', 'table', '20']);
};

Controller.prototype.lanRoutes = function () {
  var result = run(IP, ['-4', 'route', 'show', 'dev', 'wlan0', 'scope', 'link']);
  var routes = [];
  result.stdout.split('\n').forEach(function (line) {
    var firstPart = line.trim().split(/\s+/)[0] || '';
    if (firstPart.indexOf('/') >= 0 && firstPart !== 'default') { routes.push(firstPart); }
  });
  return routes.length ? unique(routes) : ['192.168.0.0/16'];
};

Controller.prototype.installRoutes = function (serverIps) {
  var self = this;
  this.cleanupPolicy();
  if (run(IP, ['route', 'replace', 'default', 'dev', 'tobe0', 'table', '20']).status !== 0) { throw new Error('Не удалось создать маршрут VPN'); }
  this.lanRoutes().forEach(function (lan) {
    if (run(IP, ['rule', 'add', 'to', lan, 'lookup', 'main', 'pref', '20010']).status !== 0) { throw new Error('Не удалось сохранить локальную сеть'); }
  });
  serverIps.forEach(function (serverIp) {
    if (run(IP, ['rule', 'add', 'to', serverIp + '/32', 'lookup', 'main', 'pref', '20020']).status !== 0) { throw new Error('Не удалось сохранить маршрут сервера'); }
  });
  if (run(IP, ['rule', 'add', 'lookup', '20', 'pref', '20100']).status !== 0) { throw new Error('Не удалось включить VPN-маршрут'); }
};

Controller.prototype.pidAlive = function (pid) {
  if (!pid) { return false; }
  try { process.kill(pid, 0); return true; } catch (ignore) { return false; }
};

Controller.prototype.killPidFile = function (path) {
  var pid = parseInt(readJson(path, 0) || (fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : 0), 10);
  if (this.pidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch (ignore) {}
    sleep(1);
    if (this.pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (ignore2) {} }
  }
  try { fs.unlinkSync(path); } catch (ignore2) {}
};

Controller.prototype.stopOldProcesses = function () { this.killPidFile(HEV_PID); this.killPidFile(XRAY_PID); };

// VpnConnectionManager.saveSessionLog: one traffic_log row per VPN session,
// stamped with the session start in epoch seconds.
Controller.prototype.saveSessionLog = function () {
  if (!this.connectedSince) { return; }
  var bytes = 0;
  ['tx_bytes', 'rx_bytes'].forEach(function (name) {
    try { bytes += parseInt(fs.readFileSync('/sys/class/net/tobe0/statistics/' + name, 'utf8'), 10) || 0; } catch (ignore) {}
  });
  var seconds = Math.floor((Date.now() - this.connectedSince) / 1000);
  if (bytes <= 0 && seconds <= 0) { return; }
  var log = readJson(TRAFFIC_LOG_FILE, []);
  log.push({ bytes: bytes, seconds: seconds, timestamp: Math.floor(this.connectedSince / 1000), server: this.connectedName || '' });
  if (log.length > 5000) { log = log.slice(log.length - 5000); }
  writeJson(TRAFFIC_LOG_FILE, log);
};

Controller.prototype.disconnect = function (keepError) {
  this.stopTunnelHealth();
  try { this.saveSessionLog(); } catch (logError) { safeLog('Session log skipped: ' + logError.message); }
  this.cleanupPolicy();
  this.stopOldProcesses();
  run(IP, ['link', 'del', 'tobe0']);
  this.connectedIndex = null; this.connectedName = null;
  this.connectedSince = null;
  if (!keepError) { this.lastError = ''; }
  return this.publicStatus();
};

Controller.prototype.connectResolved = function (index, server, ips) {
  this.disconnect(false);
  writeJson(XRAY_CONFIG, buildXrayConfig(server, ips[0]));
  var tested = run(XRAY_BIN, ['run', '-test', '-c', XRAY_CONFIG], 10000);
  if (tested.status !== 0) { throw new Error('Конфигурация этого сервера не поддерживается'); }
  var xrayFd = fs.openSync(STATE + '/xray.log', 'a');
  var xray = child.spawn(XRAY_BIN, ['run', '-c', XRAY_CONFIG], { stdio: ['ignore', xrayFd, xrayFd] });
  fs.writeFileSync(XRAY_PID, String(xray.pid) + '\n', { mode: 384 });
  sleep(2);
  if (!this.pidAlive(xray.pid)) { throw new Error('Xray не запустился'); }
  var hevText = "misc:\n  log-level: 'warn'\n  task-stack-size: 24576\n  tcp-buffer-size: 4096\n  max-session-count: 768\ntunnel:\n  name: 'tobe0'\n  mtu: 1500\n  ipv4: '198.18.0.1'\n  ipv6: ''\n  icmp: 'reply'\nsocks5:\n  address: '127.0.0.1'\n  port: " + SOCKS_PORT + "\n  udp: 'udp'\n";
  fs.writeFileSync(HEV_CONFIG, hevText, { mode: 384 });
  var hevFd = fs.openSync(STATE + '/hev.log', 'a');
  var hev = child.spawn(HEV_BIN, [HEV_CONFIG], { stdio: ['ignore', hevFd, hevFd] });
  fs.writeFileSync(HEV_PID, String(hev.pid) + '\n', { mode: 384 });
  sleep(2);
  if (!this.pidAlive(hev.pid) || run(IP, ['link', 'show', 'tobe0']).status !== 0) { throw new Error('TUN-интерфейс не запустился'); }
  this.installRoutes(ips);
  sleep(1);
  if (!this.pidAlive(xray.pid) || !this.pidAlive(hev.pid)) { throw new Error('VPN-процесс неожиданно остановился'); }
  this.connectedIndex = index; this.connectedName = server.name || server.address; this.lastError = '';
  this.connectedSince = Date.now();
  safeLog('Connected to server index ' + index);
  this.startTunnelHealth(index, server);
  return this.publicStatus();
};

Controller.prototype.connect = function (index, callback) {
  var self = this;
  if (!this.servers.length) { this.refreshProfile(); }
  index = parseInt(index, 10);
  var server = this.servers[index];
  if (!server) { return callback(new Error('Неизвестный сервер')); }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(server.address)) {
    try { return callback(null, this.connectResolved(index, server, [server.address])); }
    catch (error) { this.lastError = error.message; this.disconnect(true); this.recordConnectionFailure(server); return callback(error); }
  }
  dns.resolve4(server.address, function (error, addresses) {
    if (error || !addresses || !addresses.length) { self.recordConnectionFailure(server); return callback(new Error('Не удалось определить адрес VPN-сервера')); }
    try { callback(null, self.connectResolved(index, server, unique(addresses))); }
    catch (connectError) { self.lastError = connectError.message; self.disconnect(true); self.recordConnectionFailure(server); callback(connectError); }
  });
};

Controller.prototype.publicStatus = function () {
  var connected = this.connectedIndex !== null;
  if (connected) {
    var xp = fs.existsSync(XRAY_PID) ? parseInt(fs.readFileSync(XRAY_PID, 'utf8'), 10) : 0;
    var hp = fs.existsSync(HEV_PID) ? parseInt(fs.readFileSync(HEV_PID, 'utf8'), 10) : 0;
    if (!this.pidAlive(xp) || !this.pidAlive(hp)) {
      // The tunnel died without a stop request (VpnService destroyed).
      var died = this.servers[this.connectedIndex]; if (died) { this.recordTunnelFailure(died); }
      this.lastError = 'VPN-процесс остановился'; this.disconnect(true); connected = false;
    }
  }
  var tx = 0;
  var rx = 0;
  if (connected) {
    try { tx = parseInt(fs.readFileSync('/sys/class/net/tobe0/statistics/tx_bytes', 'utf8'), 10) || 0; } catch (ignoreTx) {}
    try { rx = parseInt(fs.readFileSync('/sys/class/net/tobe0/statistics/rx_bytes', 'utf8'), 10) || 0; } catch (ignoreRx) {}
  }
  var account = {
    telegram_id: this.session.telegram_id || null,
    username: this.session.account_username || '',
    status: this.session.account_status || '',
    plan_name: this.session.account_plan_name || '',
    is_admin: this.session.account_is_admin === true,
    unlimited: this.session.account_unlimited === true,
    expires_at: this.session.account_expire_at || '',
    traffic_limit: this.session.account_traffic_limit || 0,
    device_limit: this.session.account_device_limit || 0,
    traffic_reset_at: this.session.account_traffic_reset_at || 0,
    renewal_url: this.session.account_renewal_url || '',
    usage_used: this.session.usage_used || 0,
    usage_total: this.session.usage_total || 0
  };
  return {
    ready: true, linked: !!this.session.is_linked,
    pair_code: (this.session.pair_expires_at || 0) > Math.floor(Date.now() / 1000) ? this.session.pair_code : null,
    servers: this.servers.map(publicServer), connected: connected,
    connected_index: this.connectedIndex, connected_name: this.connectedName, error: this.lastError,
    session_bytes: tx + rx,
    session_seconds: connected && this.connectedSince ? Math.floor((Date.now() - this.connectedSince) / 1000) : 0,
    account: account,
    versions: { app: APP_VERSION, xray: '26.10.21', tunnel: '2.19.2' }
  };
};

function send(response, status, value) {
  var payload = new Buffer(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length,
    'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(payload);
}

function handle(request, response) {
  if (request.method === 'OPTIONS') { return send(response, 200, {}); }
  var parsed = url.parse(request.url, true);
  var chunks = [];
  request.on('data', function (chunk) { if (chunks.length < 64) { chunks.push(chunk); } });
  request.on('end', function () {
    var body = {};
    try { if (chunks.length) { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } } catch (ignore) {}
    try {
      if (request.method === 'GET' && parsed.pathname === '/api/status') { return send(response, 200, app.publicStatus()); }
      if (request.method === 'GET' && parsed.pathname === '/api/pair/status') { return send(response, 200, app.pairStatus(first(parsed.query, 'code'))); }
      if (request.method === 'GET' && parsed.pathname === '/api/profile') { return send(response, 200, app.refreshProfile()); }
      if (request.method === 'POST' && parsed.pathname === '/api/speedtest/start') { return send(response, 200, app.startSpeedTest()); }
      if (request.method === 'POST' && parsed.pathname === '/api/speedtest/stop') { return send(response, 200, app.stopSpeedTest()); }
      if (request.method === 'GET' && parsed.pathname === '/api/speedtest') { return send(response, 200, app.speedState()); }
      if (request.method === 'GET' && parsed.pathname === '/api/speedtest/history') { return send(response, 200, { history: app.speedHistory() }); }
      if (request.method === 'POST' && parsed.pathname === '/api/speedtest/delete') { return send(response, 200, app.deleteSpeedEntry(body.timestamp)); }
      if (request.method === 'GET' && parsed.pathname === '/api/stats') { return send(response, 200, { logs: readJson(TRAFFIC_LOG_FILE, []) }); }
      if (request.method === 'POST' && parsed.pathname === '/api/bot') { return send(response, 200, app.botProxy(String(body.method || 'GET'), String(body.path || ''), body.body)); }
      if (request.method === 'POST' && parsed.pathname === '/api/logout') { return send(response, 200, app.logout()); }
      if (request.method === 'GET' && parsed.pathname === '/api/update') { return send(response, 200, app.updater.snapshot()); }
      if (request.method === 'POST' && parsed.pathname === '/api/update/check') { return send(response, 200, app.updater.check(body.force === true)); }
      if (request.method === 'POST' && parsed.pathname === '/api/update/download') { return send(response, 200, app.updater.download()); }
      if (request.method === 'POST' && parsed.pathname === '/api/update/dismiss') { return send(response, 200, app.updater.dismiss()); }
      if (request.method === 'POST' && parsed.pathname === '/api/update/retry') { return send(response, 200, app.updater.retry()); }
      if (request.method === 'POST' && parsed.pathname === '/api/update/install') { return send(response, 200, app.updater.install()); }
      if (request.method === 'GET' && parsed.pathname === '/api/rate') { return send(response, 200, app.rubToUsd()); }
      if (request.method === 'GET' && parsed.pathname === '/api/plans') { return send(response, 200, app.purchasePlans()); }
      if (request.method === 'GET' && parsed.pathname === '/api/ping') {
        return app.pingServers(first(parsed.query, 'timeout'), first(parsed.query, 'force') === '1', function (result) { send(response, 200, result); }, first(parsed.query, 'index') === '' ? null : parseInt(first(parsed.query, 'index'), 10));
      }
      if (request.method === 'POST' && parsed.pathname === '/api/probe/start') { return send(response, 200, app.startProfileCheck(body.timeout, body.force !== false, body.missing === true)); }
      if (request.method === 'GET' && parsed.pathname === '/api/ping/live') { return send(response, 200, { pings: app.livePings || [] }); }
      if (request.method === 'POST' && parsed.pathname === '/api/sync') { return send(response, 200, app.syncSubscription(4000)); }
      if (request.method === 'GET' && parsed.pathname === '/api/best') {
        var mode = first(parsed.query, 'mode');
        if (mode === 'verified' || mode === 'connect') {
          var verified = app.bestVerifiedServer(mode === 'connect');
          if (verified !== null || mode === 'verified') { return send(response, 200, { index: verified }); }
        }
        return app.bestServer(first(parsed.query, 'timeout'), first(parsed.query, 'force') === '1', function (result) { send(response, 200, result); });
      }
      if (request.method === 'GET' && parsed.pathname === '/api/probe') { return send(response, 200, app.profileState()); }
      if (request.method === 'POST' && parsed.pathname === '/api/bootstrap') { return send(response, 200, app.bootstrap()); }
      if (request.method === 'POST' && parsed.pathname === '/api/telegram/request') { return send(response, 200, app.telegramAuth()); }
      if (request.method === 'GET' && parsed.pathname === '/api/telegram/status') { return send(response, 200, app.telegramStatus(first(parsed.query, 'token'))); }
      if (request.method === 'POST' && parsed.pathname === '/api/pair') { return send(response, 200, app.createPair()); }
      if (request.method === 'POST' && parsed.pathname === '/api/profile') { return send(response, 200, app.refreshProfile()); }
      if (request.method === 'POST' && parsed.pathname === '/api/disconnect') { return send(response, 200, app.disconnect(false)); }
      if (request.method === 'POST' && parsed.pathname === '/api/connect') {
        return app.connect(body.index || 0, function (error, result) {
          if (error) { safeLog('Connect failed: ' + error.message); send(response, 500, { error: error.message }); }
          else { send(response, 200, result); }
        });
      }
      return send(response, 404, { error: 'Не найдено' });
    } catch (error) {
      safeLog('Request failed: ' + error.message + ' ' + String(error.stack || '').split('\n').slice(1, 4).join(' | '));
      return send(response, 500, { error: error.message });
    }
  });
}

if (process.argv[2] === '--tcp-ping') {
  // TCP ping worker: its own event loop, so a blocking call in the service
  // (the subscription sync) never lands in the measured connect time. It
  // stays up and takes one batch per stdin line: {id, jobs: [{key, host, port, timeout, local}]}.
  var inbox = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    inbox += chunk; var lines = inbox.split('\n'); inbox = lines.pop();
    lines.forEach(function (line) {
      var batch; try { batch = JSON.parse(line); } catch (ignore) { return; }
      var next = 0; var active = 0; var left = batch.jobs.length;
      if (!left) { return process.stdout.write(batch.id + ' done\n'); }
      (function pump() {
        while (active < MAX_CONCURRENT_PINGS && next < batch.jobs.length) {
          (function (job) {
            active += 1;
            connectFirstReachable(job.host, job.port, job.timeout, job.local || null, function (ms) {
              active -= 1; left -= 1;
              process.stdout.write(batch.id + ' ' + job.key + ' ' + ms + '\n');
              if (!left) { process.stdout.write(batch.id + ' done\n'); } else { pump(); }
            });
          }(batch.jobs[next]));
          next += 1;
        }
      }());
    });
  });
  process.stdin.on('end', function () { process.exit(0); });
} else if (process.env.TOBEVPN_TEST === '1') {
  module.exports = {
    parseProfileLinks: parseProfileLinks,
    parseServer: parseServer,
    buildXrayConfig: buildXrayConfig,
    publicServer: publicServer
  };
} else {
  ensureDir(STATE);
  process.umask(63);
  app = new Controller();
  var server = http.createServer(handle);
  server.listen(18765, '127.0.0.1', function () { safeLog('Service listening on 127.0.0.1:18765'); });

  var shutdown = function () {
    try { app.disconnect(false); } catch (ignore) {}
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
