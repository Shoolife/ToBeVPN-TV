#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="$(CDPATH= cd -- "$ROOT/.." && pwd)"
DIST="$ROOT/dist"
DEPLOY="$DIST/tobevpn"
TV_HOST="${TV_HOST:-192.168.1.139}"
SSH_KEY="${SSH_KEY:-/home/ivan/.ssh/id_ed25519}"
SSH_ARGS="-F /dev/null -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no"

IPK="$($ROOT/scripts/build.sh | tail -1)"
BOT_API_URL="$(sed -n 's/^bot\.api\.url=//p' "$PROJECT/local.properties" | tail -1)"
if [ -z "$BOT_API_URL" ]; then
    echo "bot.api.url is missing in local.properties" >&2
    exit 1
fi

mkdir -p "$DEPLOY/bin" "$DEPLOY/service" "$DEPLOY/state"
cp "$ROOT/vendor/xray" "$DEPLOY/bin/xray"
cp "$ROOT/vendor/hev-socks5-tunnel-linux-arm32hf" "$DEPLOY/bin/hev-socks5-tunnel"
cp "$ROOT/service/tobevpn_service.js" "$ROOT/service/start.sh" "$ROOT/service/stop.sh" "$DEPLOY/service/"
jq -n \
    --arg bot_api_url "$BOT_API_URL" \
    --arg device_model "LG 43UJ630V-ZA" \
    --arg webos_version "3.9.0" \
    '{bot_api_url:$bot_api_url,device_model:$device_model,webos_version:$webos_version,user_agent:"ToBeVPN/1.0.35/webos/1"}' \
    > "$DEPLOY/config.json"
chmod 755 "$DEPLOY/bin/xray" "$DEPLOY/bin/hev-socks5-tunnel" "$DEPLOY/service/start.sh" "$DEPLOY/service/stop.sh" "$DEPLOY/service/tobevpn_service.js"
chmod 600 "$DEPLOY/config.json"

# scp nests the source when the target directory already exists. Recreate the
# exact staging path so an update can never silently redeploy stale files.
ssh $SSH_ARGS "root@$TV_HOST" "rm -rf /tmp/tobevpn-install"
scp $SSH_ARGS -r "$DEPLOY" "root@$TV_HOST:/tmp/tobevpn-install"
# /tmp/wam-tuning is the directory the WAM hook keeps its conf.sh copy in.
scp $SSH_ARGS "$ROOT/service/init-hook" "$IPK" "root@$TV_HOST:/tmp/"
scp $SSH_ARGS "$ROOT/service/wam-tuning" "root@$TV_HOST:/tmp/tobevpn-wam-tuning.hook"

IPK_NAME="$(basename "$IPK")"
ssh $SSH_ARGS "root@$TV_HOST" "
    /media/developer/tobevpn/service/stop.sh >/dev/null 2>&1 || true
    mkdir -p /media/developer/tobevpn /var/lib/webosbrew/init.d
    cp -R /tmp/tobevpn-install/* /media/developer/tobevpn/
    cp /tmp/init-hook /var/lib/webosbrew/init.d/30-tobevpn
    cp /tmp/tobevpn-wam-tuning.hook /var/lib/webosbrew/init.d/40-wam-tuning
    chmod 755 /var/lib/webosbrew/init.d/30-tobevpn /var/lib/webosbrew/init.d/40-wam-tuning /media/developer/tobevpn/service/*.sh /media/developer/tobevpn/service/*.js /media/developer/tobevpn/bin/*
    chmod 600 /media/developer/tobevpn/config.json
    nohup /media/developer/tobevpn/service/start.sh >/dev/null 2>&1 &
    i=0
    while [ \"\$i\" -lt 20 ]; do
        /usr/bin/curl -sS --max-time 2 http://127.0.0.1:18765/api/status >/dev/null 2>&1 && break
        i=\$((i+1))
        sleep 1
    done
    /usr/bin/curl -sS --max-time 3 http://127.0.0.1:18765/api/status >/dev/null
"

ssh -tt $SSH_ARGS "root@$TV_HOST" \
    "luna-send -n 20 -w 45000 -f luna://com.webos.appInstallService/dev/install '{\"id\":\"testing\",\"ipkUrl\":\"/tmp/$IPK_NAME\",\"subscribe\":true}'"
