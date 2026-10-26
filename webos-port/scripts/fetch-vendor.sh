#!/bin/sh
# Downloads the ARMv7 Xray and hev-socks5-tunnel builds listed in
# vendor/vendor.lock and verifies their sha256. Files already present with
# the right digest are kept, so it is cheap to run before every build.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
LOCK="$VENDOR/vendor.lock"

lock() { sed -n "s/^$1=//p" "$LOCK"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
has() { [ -f "$1" ] && [ "$(sha "$1")" = "$2" ]; }
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

XRAY="$VENDOR/xray"
if ! has "$XRAY" "$(lock xray_sha256)"; then
    ZIP="$VENDOR/Xray-linux-arm32-v7a.zip"
    has "$ZIP" "$(lock xray_zip_sha256)" || fetch "$(lock xray_url)" "$ZIP"
    if ! has "$ZIP" "$(lock xray_zip_sha256)"; then
        echo "Xray archive checksum mismatch" >&2
        exit 1
    fi
    unzip -p "$ZIP" xray > "$XRAY"
    if ! has "$XRAY" "$(lock xray_sha256)"; then
        echo "xray binary checksum mismatch" >&2
        exit 1
    fi
fi

TUNNEL="$VENDOR/hev-socks5-tunnel-linux-arm32hf"
if ! has "$TUNNEL" "$(lock tunnel_sha256)"; then
    fetch "$(lock tunnel_url)" "$TUNNEL"
    if ! has "$TUNNEL" "$(lock tunnel_sha256)"; then
        echo "hev-socks5-tunnel checksum mismatch" >&2
        exit 1
    fi
fi

chmod 755 "$XRAY" "$TUNNEL"
echo "vendor: xray $(lock xray_version), hev-socks5-tunnel $(lock tunnel_version)"
