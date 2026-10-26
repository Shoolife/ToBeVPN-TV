# ToBeVPN for LG webOS

This directory contains the webOS TV port of the Android TV application.

- `app/` is the ES5 webOS remote-control UI.
- `service/` is a root-only Node.js controller for device pairing, subscriptions,
  Xray, TUN creation and reversible policy routing.
- `vendor/vendor.lock` pins the official ARMv7 builds of Xray and
  hev-socks5-tunnel; `scripts/fetch-vendor.sh` downloads them and checks
  their sha256 (the binaries are not stored in git).
- `scripts/build.sh` creates the IPK. It needs `ares-package`
  (`@webos-tools/cli`) and `BOT_API_URL` (or `bot.api.url` in
  `local.properties`), and refuses to build when the webOS version differs
  from the Android TV `versionName`: one `v*-tv` tag ships both.
- GitHub Actions builds the IPK on every tag and attaches
  `ToBeVPN-TV-<version>-webos.ipk` to the release, where the in-app updater
  finds it.
- `scripts/install.sh` installs both the IPK and the native service on the TV.

The service binds only to `127.0.0.1:18765`. Account tokens and full server
links are stored with mode `0600` in `/media/developer/tobevpn/state`; they are
never returned to the web UI. Routes use policy table 20 and preserve the TV's
LAN plus the selected VPN endpoint. Disconnect and the supervisor exit handler
remove all ToBeVPN rules.

To stop and restore normal routing manually:

```sh
/media/developer/tobevpn/service/stop.sh
```

## WebAppMgr tuning

`service/wam-tuning` is installed as `/var/lib/webosbrew/init.d/40-wam-tuning`.
LG starts WebAppMgr with switches meant for 1 GB devices that drop the painted
tiles of hidden pages and disable V8's optimising JIT, which made every screen
change re-rasterise a full 1920x1080 page. The hook bind-mounts an edited copy
of `/etc/wam/plugins/conf.sh` (sourced by `/etc/init/WebAppMgr.conf` after the
switches are built) and restarts WebAppMgr once. The system partition is not
modified. To undo: delete the hook and reboot, or create
`/var/lib/webosbrew/wam-tuning.disable` and reboot.
