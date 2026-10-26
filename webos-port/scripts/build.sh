#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/stage/com.tobevpn.app"
# ares-package from @webos-tools/cli: $ARES_PACKAGE, then PATH (CI installs
# it globally), then the local developer install.
CLI="${ARES_PACKAGE:-$(command -v ares-package || echo /home/ivan/.local-webos-cli/node_modules/.bin/ares-package)}"

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/app/appinfo.json")"
SERVICE_VERSION="$(sed -n "s/^var APP_VERSION = .* '\([0-9][^']*\)';/\1/p" "$ROOT/service/tobevpn_service.js")"
# The in-app updater compares GitHub tags with the service's APP_VERSION; the
# package version is the same number without the "-tv" suffix.
if [ "${SERVICE_VERSION%%-*}" != "$VERSION" ]; then
    echo "appinfo.json version $VERSION does not match service APP_VERSION $SERVICE_VERSION" >&2
    exit 1
fi
# One tag ships both TV builds (v1.0.35-tv): the Android TV versionName and
# the webOS version must move together, or the TV updater would offer an
# IPK that is not the version it claims.
PROJECT="$(CDPATH= cd -- "$ROOT/.." && pwd)"
ANDROID_VERSION="$(sed -n 's/^ *versionName = "\([^"]*\)".*/\1/p' "$PROJECT/app/build.gradle.kts" | head -1)"
if [ "$ANDROID_VERSION" != "$SERVICE_VERSION" ]; then
    echo "service APP_VERSION $SERVICE_VERSION does not match Android TV versionName $ANDROID_VERSION" >&2
    exit 1
fi
# The versions the app reports in "About" must be the binaries packed.
LOCK="$ROOT/vendor/vendor.lock"
if ! grep -q "xray: '$(sed -n 's/^xray_version=v//p' "$LOCK")', tunnel: '$(sed -n 's/^tunnel_version=//p' "$LOCK")'" "$ROOT/service/tobevpn_service.js"; then
    echo "service versions do not match vendor/vendor.lock" >&2
    exit 1
fi
"$ROOT/scripts/fetch-vendor.sh" >&2

# The package carries a copy of the service: after an in-app update the
# running service replaces itself with it (Updater.applyServiceBundle).
rm -rf "$DIST/stage"
mkdir -p "$STAGE/service"
cp -R "$ROOT/app/." "$STAGE/"
cp "$ROOT/service/tobevpn_service.js" "$ROOT/service/start.sh" "$ROOT/service/stop.sh" "$STAGE/service/"

# setup/: everything the first start needs to install the service by itself
# (setup.sh runs as root through Homebrew Channel; see app.js ensureService).
# CI passes BOT_API_URL from the repository secret; locally it comes from
# local.properties, like the Android build.
BOT_API_URL="${BOT_API_URL:-$(sed -n 's/^bot\.api\.url=//p' "$PROJECT/local.properties" 2>/dev/null | tail -1)}"
if [ -z "$BOT_API_URL" ]; then
    echo "BOT_API_URL is not set and bot.api.url is missing in local.properties" >&2
    exit 1
fi
SETUP="$STAGE/setup"
mkdir -p "$SETUP/bin" "$SETUP/service"
cp "$ROOT/vendor/xray" "$SETUP/bin/xray"
cp "$ROOT/vendor/hev-socks5-tunnel-linux-arm32hf" "$SETUP/bin/hev-socks5-tunnel"
cp "$ROOT/service/tobevpn_service.js" "$ROOT/service/start.sh" "$ROOT/service/stop.sh" "$SETUP/service/"
cp "$ROOT/service/setup.sh" "$ROOT/service/init-hook" "$SETUP/"
printf '%s' "$SERVICE_VERSION" > "$SETUP/version"
printf '{"bot_api_url":"%s"}\n' "$BOT_API_URL" > "$SETUP/config.base.json"
chmod 755 "$SETUP/setup.sh" "$SETUP/init-hook" "$SETUP/bin/xray" "$SETUP/bin/hev-socks5-tunnel"
printf 'window.TOBEVPN_BUILD = { service: "%s" };\n' "$SERVICE_VERSION" > "$STAGE/build-info.js"

mkdir -p "$DIST"
"$CLI" "$STAGE" -o "$DIST" >&2

IPK="$DIST/com.tobevpn.app_${VERSION}_all.ipk"
test -f "$IPK"
# Name of the GitHub release asset the updater looks for.
cp "$IPK" "$DIST/ToBeVPN-TV-${SERVICE_VERSION}-webos.ipk"
echo "$IPK"
