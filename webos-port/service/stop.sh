#!/bin/sh
BASE=/media/developer/tobevpn
PIDFILE="$BASE/state/service.pid"
NODE_PIDFILE="$BASE/state/node.pid"

if [ -f "$PIDFILE" ]; then
    PID="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null || true
    fi
fi

if [ -f "$NODE_PIDFILE" ]; then
    NODE_PID="$(cat "$NODE_PIDFILE" 2>/dev/null)"
    if [ -n "$NODE_PID" ]; then
        kill "$NODE_PID" 2>/dev/null || true
    fi
fi

i=0
while [ "$i" -lt 5 ]; do
    NODE_PID="$(cat "$NODE_PIDFILE" 2>/dev/null || true)"
    [ -z "$NODE_PID" ] && break
    kill -0 "$NODE_PID" 2>/dev/null || break
    sleep 1
    i=$((i+1))
done
[ -n "${NODE_PID:-}" ] && kill -KILL "$NODE_PID" 2>/dev/null || true

for PREF in 20100 20020 20010 20006 20005; do
    while /sbin/ip rule del pref "$PREF" 2>/dev/null; do :; done
done
/sbin/ip route flush table 20 2>/dev/null || true
/sbin/ip link del tobe0 2>/dev/null || true
rm -f "$PIDFILE" "$NODE_PIDFILE"
