#!/bin/sh
BASE=/media/developer/tobevpn
STATE="$BASE/state"
PIDFILE="$STATE/service.pid"
NODE_PIDFILE="$STATE/node.pid"
LOG="$STATE/supervisor.log"

mkdir -p "$STATE"
chmod 700 "$STATE"

if [ -f "$PIDFILE" ]; then
    OLD_PID="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        exit 0
    fi
    rm -f "$PIDFILE"
fi

cleanup() {
    /sbin/ip rule del pref 20100 2>/dev/null || true
    /sbin/ip rule del pref 20020 2>/dev/null || true
    /sbin/ip rule del pref 20010 2>/dev/null || true
    /sbin/ip route flush table 20 2>/dev/null || true
    /sbin/ip link del tobe0 2>/dev/null || true
    rm -f "$PIDFILE" "$NODE_PIDFILE"
}

trap cleanup EXIT INT TERM
echo $$ > "$PIDFILE"
/usr/bin/node "$BASE/service/tobevpn_service.js" >> "$LOG" 2>&1 &
CHILD=$!
echo "$CHILD" > "$NODE_PIDFILE"
trap 'kill "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null; cleanup; exit 0' INT TERM
wait "$CHILD"
