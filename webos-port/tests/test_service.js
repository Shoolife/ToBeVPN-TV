'use strict';

process.env.TOBEVPN_TEST = '1';
var assert = require('assert');
var service = require('../service/tobevpn_service.js');

var link = 'vless://00000000-1111-2222-3333-444444444444@example.com:443?security=reality&type=xhttp&sni=cdn.example.com&fp=chrome&pbk=public&sid=abcd&path=%2Fvpn&mode=auto#Moscow';
assert.deepEqual(service.parseProfileLinks(link), [link]);
assert.deepEqual(service.parseProfileLinks(new Buffer(link).toString('base64')), [link]);

var server = service.parseServer(link);
assert.equal(server.name, 'Moscow');
assert.equal(server.network, 'xhttp');
var config = service.buildXrayConfig(server, '203.0.113.4');
assert.equal(config.outbounds[0].settings.vnext[0].address, '203.0.113.4');
assert.equal(config.outbounds[0].streamSettings.realitySettings.serverName, 'cdn.example.com');
assert.equal(config.outbounds[0].streamSettings.xhttpSettings.path, '/vpn');

var hy = service.parseServer('hysteria2://secret@example.com:443?sni=edge.example.com&obfs=salamander&obfs-password=cat#Fast');
var hyConfig = service.buildXrayConfig(hy, '203.0.113.8');
assert.equal(hyConfig.outbounds[0].protocol, 'hysteria');
assert.equal(hyConfig.outbounds[0].streamSettings.hysteriaSettings.auth, 'secret');

// Hysteria2 UDP masks belong to streamSettings.finalmask (Xray StreamConfig).
assert.equal(hyConfig.outbounds[0].streamSettings.finalmask.udp[0].type, 'salamander');
assert.equal(hyConfig.outbounds[0].streamSettings.hysteriaSettings.finalmask, undefined);

// fm= (v2rayN finalmask share format) replaces the built finalmask.
var mask = { tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '100-200' } }] };
var masked = service.parseServer(link.replace('#Moscow', '&fm=' + encodeURIComponent(JSON.stringify(mask)) + '#Moscow'));
assert.deepEqual(JSON.parse(masked.final_mask), mask);
assert.deepEqual(service.buildXrayConfig(masked, '203.0.113.4').outbounds[0].streamSettings.finalmask, mask);
assert.equal(service.buildXrayConfig(server, '203.0.113.4').outbounds[0].streamSettings.finalmask, undefined);
['not-json', encodeURIComponent('[1]'), encodeURIComponent('{}')].forEach(function (value) {
  assert.equal(service.parseServer(link.replace('#Moscow', '&fm=' + value + '#Moscow')).final_mask, '');
});
var hyMasked = service.parseServer('hysteria2://secret@example.com:443?obfs=salamander&obfs-password=cat&fm=' +
  encodeURIComponent(JSON.stringify({ udp: [{ type: 'salamander', settings: { password: 'from-fm' } }] })) + '#Fm');
var hyMaskedStream = service.buildXrayConfig(hyMasked, '203.0.113.8').outbounds[0].streamSettings;
assert.equal(hyMaskedStream.finalmask.udp.length, 1);
assert.equal(hyMaskedStream.finalmask.udp[0].settings.password, 'from-fm');

console.log('Node service tests passed');

// Every method the service calls on its objects must be defined: a lost
// block of prototype methods otherwise only shows up on the TV.
(function () {
  var source = require('fs').readFileSync(require('path').join(__dirname, '..', 'service', 'tobevpn_service.js'), 'utf8');
  var defined = {}; var match;
  var definition = /(\w+)\.prototype\.(\w+)\s*=/g;
  while ((match = definition.exec(source))) { defined[match[2]] = true; }
  var assigned = /\bthis\.(\w+)\s*=\s*\w/g;
  while ((match = assigned.exec(source))) { defined[match[1]] = true; }
  var call = /\b(?:this|self|app|app\.updater)\.(\w+)\(/g; var missing = [];
  while ((match = call.exec(source))) { if (!defined[match[1]] && missing.indexOf(match[1]) < 0) { missing.push(match[1]); } }
  if (missing.length) { throw new Error('Undefined service methods: ' + missing.join(', ')); }
}());
console.log('Service method check passed');
