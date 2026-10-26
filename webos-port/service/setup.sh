#!/bin/sh
# Installs or updates the ToBeVPN service from the app package. The app runs
# it as root through the Homebrew Channel service (org.webosbrew.hbchannel
# exec) on its first start and whenever the packaged service is newer than
# the running one. Nothing outside /media/developer/tobevpn and the Homebrew
# Channel init.d directory is touched.
set -eu
export PATH=/usr/bin:/usr/sbin:/bin:/sbin

SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BASE=/media/developer/tobevpn

mkdir -p "$BASE/bin" "$BASE/service" "$BASE/state" /var/lib/webosbrew/init.d
chmod 700 "$BASE/state"
if [ -x "$BASE/service/stop.sh" ]; then "$BASE/service/stop.sh" >/dev/null 2>&1 || true; fi

cp "$SRC/bin/xray" "$SRC/bin/hev-socks5-tunnel" "$BASE/bin/"
cp "$SRC/service/tobevpn_service.js" "$SRC/service/start.sh" "$SRC/service/stop.sh" "$BASE/service/"
chmod 755 "$BASE/bin/xray" "$BASE/bin/hev-socks5-tunnel" "$BASE/service/start.sh" "$BASE/service/stop.sh" "$BASE/service/tobevpn_service.js"

# The device details the backend and the subscription see (x-device-model,
# x-ver-os, User-Agent), read from this TV.
MODEL="$(luna-send -n 1 -f luna://com.webos.service.tv.systemproperty/getSystemInfo '{"keys":["modelName"]}' 2>/dev/null | sed -n 's/.*"modelName": *"\([^"]*\)".*/\1/p' | head -1)"
WEBOS="$(nyx-cmd OSInfo query webos_release 2>/dev/null || true)"
VERSION="$(cat "$SRC/version")"
/usr/bin/node -e '
  var fs = require("fs");
  var base = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  var target = process.argv[2]; var old = {};
  try { old = JSON.parse(fs.readFileSync(target, "utf8")); } catch (ignore) {}
  var config = {};
  Object.keys(old).forEach(function (k) { config[k] = old[k]; });
  config.bot_api_url = base.bot_api_url;
  config.device_model = "LG " + (process.argv[3] || "webOS TV");
  config.webos_version = process.argv[4] || "webOS";
  config.user_agent = "ToBeVPN/" + process.argv[5].split("-")[0] + "/webos/1";
  fs.writeFileSync(target + ".tmp", JSON.stringify(config, null, 2) + "\n", { mode: 384 });
  fs.renameSync(target + ".tmp", target);
' "$SRC/config.base.json" "$BASE/config.json" "$MODEL" "$WEBOS" "$VERSION"
chmod 600 "$BASE/config.json"

# Start on every boot (Homebrew Channel runs init.d after startup).
cp "$SRC/init-hook" /var/lib/webosbrew/init.d/30-tobevpn
chmod 755 /var/lib/webosbrew/init.d/30-tobevpn

nohup "$BASE/service/start.sh" >/dev/null 2>&1 </dev/null &
i=0
while [ "$i" -lt 20 ]; do
    /usr/bin/curl -sS --max-time 2 http://127.0.0.1:18765/api/status >/dev/null 2>&1 && exit 0
    i=$((i + 1))
    sleep 1
done
echo "service did not start" >&2
exit 1
