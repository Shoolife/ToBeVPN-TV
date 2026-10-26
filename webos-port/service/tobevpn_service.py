#!/usr/bin/env python
from __future__ import print_function

import base64
import errno
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

try:
    from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler
    from SocketServer import ThreadingMixIn
    from urlparse import urlsplit, parse_qs
    from urllib import unquote
except ImportError:
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from socketserver import ThreadingMixIn
    from urllib.parse import urlsplit, parse_qs, unquote


BASE_DIR = os.environ.get("TOBEVPN_DIR", "/media/developer/tobevpn")
STATE_DIR = os.path.join(BASE_DIR, "state")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
SESSION_PATH = os.path.join(STATE_DIR, "session.json")
SERVERS_PATH = os.path.join(STATE_DIR, "servers.json")
XRAY_CONFIG_PATH = os.path.join(STATE_DIR, "xray.json")
HEV_CONFIG_PATH = os.path.join(STATE_DIR, "hev.yml")
LOG_PATH = os.path.join(STATE_DIR, "service.log")
XRAY_LOG_PATH = os.path.join(STATE_DIR, "xray.log")
HEV_LOG_PATH = os.path.join(STATE_DIR, "hev.log")
XRAY_BIN = os.path.join(BASE_DIR, "bin", "xray")
HEV_BIN = os.path.join(BASE_DIR, "bin", "hev-socks5-tunnel")
IP_BIN = "/sbin/ip"
SOCKS_PORT = 28080
RULE_LAN_PREF = "20010"
RULE_SERVER_PREF = "20020"
RULE_TUN_PREF = "20100"
ROUTE_TABLE = "20"


class ServiceError(Exception):
    pass


def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)


def read_json(path, default):
    try:
        with open(path, "rb") as handle:
            return json.loads(handle.read().decode("utf-8"))
    except Exception:
        return default


def write_json(path, value, mode=0o600):
    data = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    if not isinstance(data, bytes):
        data = data.encode("utf-8")
    tmp = path + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.write(b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, mode)
    os.rename(tmp, path)


def log(message):
    ensure_dir(STATE_DIR)
    safe = re.sub(r"(?i)(access_token|refresh_token|authorization)[^,\s]*", r"\1=<redacted>", str(message))
    line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), safe)
    try:
        with open(LOG_PATH, "ab") as handle:
            handle.write(line.encode("utf-8"))
    except Exception:
        pass


def run_quiet(args, timeout=None):
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if timeout is None:
        out, err = proc.communicate()
    else:
        started = time.time()
        while proc.poll() is None and time.time() - started < timeout:
            time.sleep(0.1)
        if proc.poll() is None:
            proc.kill()
            proc.wait()
            raise ServiceError("Command timed out")
        out, err = proc.communicate()
    return proc.returncode, out, err


def first(query, key, default=""):
    value = query.get(key, [default])
    return value[0] if value else default


def normalized_network(raw):
    value = (raw or "").strip().lower()
    if value in ("", "raw", "tcp"):
        return "tcp"
    if value in ("websocket", "ws"):
        return "ws"
    if value in ("splithttp", "xhttp"):
        return "xhttp"
    return value


def decode_text(raw):
    if isinstance(raw, bytes):
        return raw.decode("utf-8", "replace")
    return raw


def parse_profile_links(body):
    body = decode_text(body).strip()
    pattern = re.compile(r"(?:vless|hysteria2|hy2)://[^\s<>\"']+", re.I)
    links = pattern.findall(body)
    if links:
        return list(dict((link, True) for link in links).keys())
    compact = re.sub(r"\s+", "", body)
    if not compact:
        return []
    compact += "=" * ((4 - len(compact) % 4) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            decoded = decode_text(decoder(compact))
            links = pattern.findall(decoded)
            if links:
                return list(dict((link, True) for link in links).keys())
        except Exception:
            pass
    return []


def parse_server(link):
    raw = decode_text(link).strip()
    lower = raw.lower()
    if lower.startswith("vless://"):
        return parse_vless(raw)
    if lower.startswith("hysteria2://") or lower.startswith("hy2://"):
        return parse_hysteria2(raw)
    raise ServiceError("Unsupported server protocol")


def parse_vless(link):
    parsed = urlsplit(link)
    if not parsed.username or not parsed.hostname:
        raise ServiceError("Invalid VLESS link")
    query = parse_qs(parsed.query, keep_blank_values=True)
    fingerprint = first(query, "fp", "chrome").strip().lower() or "chrome"
    if fingerprint in (
        "android", "helloandroid_11_okhttp", "hellochrome_58", "hellochrome_62",
        "hellofirefox_55", "hellofirefox_56", "helloios_11_1",
    ):
        fingerprint = "chrome"
    extra = first(query, "extra", "")
    if extra.strip() == "null":
        extra = ""
    return {
        "protocol": "vless",
        "name": unquote(parsed.fragment or parsed.hostname),
        "address": parsed.hostname,
        "port": parsed.port or 443,
        "uuid": unquote(parsed.username),
        "flow": first(query, "flow"),
        "security": first(query, "security", "none").strip().lower() or "none",
        "sni": first(query, "sni"),
        "fingerprint": fingerprint,
        "public_key": first(query, "pbk"),
        "short_id": first(query, "sid"),
        "network": normalized_network(first(query, "type")),
        "path": first(query, "path"),
        "host": first(query, "host"),
        "alpn": first(query, "alpn"),
        "header_type": first(query, "headerType").strip().lower(),
        "service_name": first(query, "serviceName"),
        "extra": extra,
        "mode": first(query, "mode").strip().lower(),
        "spx": first(query, "spx"),
        "link": link,
    }


def parse_hysteria2(link):
    parsed = urlsplit(link)
    if not parsed.username or not parsed.hostname:
        raise ServiceError("Invalid Hysteria2 link")
    query = parse_qs(parsed.query, keep_blank_values=True)
    pin = first(query, "pinSHA256") or first(query, "pinsha256")
    pin = re.sub(r"[:\s]", "", pin).lower()
    if not re.match(r"^[0-9a-f]{64}$", pin):
        pin = ""
    obfs = first(query, "obfs").strip().lower()
    return {
        "protocol": "hysteria2",
        "name": unquote(parsed.fragment or parsed.hostname),
        "address": parsed.hostname,
        "port": parsed.port or 443,
        "uuid": unquote(parsed.username),
        "sni": first(query, "sni"),
        "alpn": first(query, "alpn", "h3") or "h3",
        "obfs_password": first(query, "obfs-password") if obfs in ("", "salamander") else "",
        "pin_sha256": pin,
        "port_hopping": first(query, "mport"),
        "ech": first(query, "ech"),
        "link": link,
    }


def public_server(server, index):
    return {
        "index": index,
        "name": server.get("name") or server.get("address"),
        "protocol": "Hysteria2" if server.get("protocol") == "hysteria2" else "VLESS",
        "address": server.get("address"),
        "network": server.get("network", "hysteria"),
    }


def build_xray_config(server, address_ip):
    inbounds = [{
        "tag": "socks",
        "listen": "127.0.0.1",
        "port": SOCKS_PORT,
        "protocol": "socks",
        "settings": {"auth": "noauth", "udp": True, "userLevel": 8},
        "sniffing": {"enabled": True, "destOverride": ["http", "tls"], "routeOnly": False},
    }]
    if server["protocol"] == "hysteria2":
        alpn = [part.strip() for part in server.get("alpn", "h3").split(",") if part.strip()]
        tls = {"serverName": server.get("sni") or server["address"], "alpn": alpn or ["h3"]}
        if server.get("pin_sha256"):
            tls["pinnedPeerCertSha256"] = server["pin_sha256"]
        if server.get("ech"):
            tls["echConfigList"] = server["ech"]
        hysteria = {"version": 2, "auth": server["uuid"]}
        masks = []
        if server.get("port_hopping"):
            masks.append({"type": "udphop", "settings": {"mode": "intervalRemote", "remotePorts": server["port_hopping"]}})
        if server.get("obfs_password"):
            masks.append({"type": "salamander", "settings": {"password": server["obfs_password"]}})
        if masks:
            hysteria["finalmask"] = {"udp": masks}
        proxy = {
            "tag": "proxy", "protocol": "hysteria",
            "settings": {"version": 2, "address": address_ip, "port": server["port"]},
            "streamSettings": {"network": "hysteria", "security": "tls", "tlsSettings": tls, "hysteriaSettings": hysteria},
        }
    else:
        stream = {"network": server["network"], "security": server["security"]}
        if server["network"] == "xhttp":
            settings = {}
            if server.get("path"):
                settings["path"] = server["path"]
            if server.get("host"):
                settings["host"] = server["host"]
            if server.get("mode"):
                settings["mode"] = server["mode"]
            if server.get("extra"):
                try:
                    settings["extra"] = json.loads(server["extra"])
                except Exception:
                    pass
            stream["xhttpSettings"] = settings
        elif server["network"] == "ws":
            settings = {}
            if server.get("path"):
                settings["path"] = server["path"]
            if server.get("host"):
                settings["host"] = server["host"]
                settings["headers"] = {"Host": server["host"]}
            stream["wsSettings"] = settings
        elif server["network"] == "grpc":
            settings = {"serviceName": server.get("service_name", ""), "multiMode": server.get("mode") == "multi"}
            if server.get("host"):
                settings["authority"] = server["host"]
            stream["grpcSettings"] = settings
        else:
            header_type = "http" if server.get("header_type") == "http" else "none"
            header = {"type": header_type}
            if header_type == "http":
                request = {}
                if server.get("path"):
                    request["path"] = [server["path"]]
                if server.get("host"):
                    request["headers"] = {"Host": [server["host"]]}
                header["request"] = request
                header["response"] = {}
            stream["tcpSettings"] = {"header": header}
        if server["security"] == "reality":
            stream["realitySettings"] = {
                "allowInsecure": False,
                "serverName": server.get("sni", ""),
                "fingerprint": server.get("fingerprint", "chrome"),
                "publicKey": server.get("public_key", ""),
                "shortId": server.get("short_id", ""),
                "spiderX": server.get("spx") or "/",
            }
        elif server["security"] == "tls":
            tls = {
                "allowInsecure": False,
                "serverName": server.get("sni", ""),
                "fingerprint": server.get("fingerprint", "chrome"),
            }
            alpn = [part.strip() for part in server.get("alpn", "").split(",") if part.strip()]
            if alpn:
                tls["alpn"] = alpn
            stream["tlsSettings"] = tls
        user = {"id": server["uuid"], "level": 8, "encryption": "none"}
        if server.get("flow"):
            user["flow"] = server["flow"]
        proxy = {
            "tag": "proxy", "protocol": "vless",
            "settings": {"vnext": [{"address": address_ip, "port": server["port"], "users": [user]}]},
            "streamSettings": stream,
        }
        if server["network"] != "xhttp":
            proxy["mux"] = {"enabled": False, "concurrency": -1}
    return {
        "log": {"loglevel": "warning"},
        "inbounds": inbounds,
        "outbounds": [proxy, {"tag": "direct", "protocol": "freedom", "settings": {"domainStrategy": "UseIP"}}, {"tag": "block", "protocol": "blackhole"}],
        "dns": {"servers": ["1.1.1.1", "8.8.8.8"], "queryStrategy": "UseIPv4"},
        "routing": {"domainStrategy": "AsIs", "rules": []},
    }


class ToBeVpnService(object):
    def __init__(self):
        ensure_dir(STATE_DIR)
        self.config = read_json(CONFIG_PATH, {})
        self.session = read_json(SESSION_PATH, {})
        self.servers = read_json(SERVERS_PATH, [])
        self.lock = threading.RLock()
        self.xray = None
        self.hev = None
        self.xray_log = None
        self.hev_log = None
        self.connected_index = None
        self.connected_name = None
        self.server_ips = []
        self.last_error = ""
        self._cleanup_routes()

    def _save_session(self):
        write_json(SESSION_PATH, self.session)

    def _save_servers(self):
        write_json(SERVERS_PATH, self.servers)

    def _curl(self, method, url, payload=None, bearer=None, headers=None, timeout=20):
        args = ["/usr/bin/curl", "-sS", "--connect-timeout", "8", "--max-time", str(timeout), "-X", method]
        args += ["-H", "Accept: application/json"]
        if bearer:
            args += ["-H", "Authorization: Bearer " + bearer]
        for key, value in (headers or {}).items():
            args += ["-H", "%s: %s" % (key, value)]
        if payload is not None:
            encoded = json.dumps(payload, separators=(",", ":"))
            args += ["-H", "Content-Type: application/json", "--data-binary", encoded]
        args += ["-w", "\n__TOBEVPN_HTTP__:%{http_code}", url]
        code, out, err = run_quiet(args, timeout + 2)
        if code != 0:
            raise ServiceError("Network request failed")
        text = decode_text(out)
        marker = "\n__TOBEVPN_HTTP__:"
        if marker not in text:
            raise ServiceError("Invalid network response")
        body, status = text.rsplit(marker, 1)
        try:
            parsed = json.loads(body) if body.strip() else {}
        except Exception:
            parsed = {"raw": body}
        return int(status.strip()), parsed

    def _api_url(self, path):
        base = self.config.get("bot_api_url", "").rstrip("/")
        if not base:
            raise ServiceError("Backend is not configured")
        return base + "/" + path.lstrip("/")

    def bootstrap(self):
        with self.lock:
            device_id = self.session.get("device_id") or self.config.get("device_id")
            if not device_id:
                device_id = "%032x" % int.from_bytes(os.urandom(16), byteorder="big") if sys.version_info[0] >= 3 else os.urandom(16).encode("hex")
            status, response = self._curl("POST", self._api_url("api/device/bootstrap"), {
                "device_id": device_id,
                "platform": "android_tv",
            })
            data = response.get("data") or {}
            if status >= 300 or not data.get("access_token"):
                raise ServiceError(response.get("message") or "Device bootstrap failed")
            now = int(time.time())
            previous = dict(self.session)
            self.session.update({
                "device_id": data.get("device_id") or device_id,
                "access_token": data["access_token"],
                "refresh_token": data.get("refresh_token", ""),
                "access_expires_at": now + int(data.get("expires_in", 1800)),
                "refresh_expires_at": now + int(data.get("refresh_expires_in", 7776000)),
            })
            linked = bool(data.get("is_linked") and data.get("telegram_id"))
            if linked:
                self.session.update({
                    "is_linked": True,
                    "telegram_id": data.get("telegram_id"),
                    "panel_user_uuid": data.get("panel_user_uuid"),
                    "short_uuid": data.get("short_uuid"),
                })
            elif previous.get("is_linked"):
                for key in ("is_linked", "telegram_id", "panel_user_uuid", "short_uuid", "subscription_url"):
                    if key in previous:
                        self.session[key] = previous[key]
            else:
                self.session["is_linked"] = False
            self._save_session()
            return self.public_status()

    def refresh(self):
        refresh_token = self.session.get("refresh_token")
        if not refresh_token:
            return self.bootstrap()
        status, response = self._curl("POST", self._api_url("api/device/refresh"), {"refresh_token": refresh_token})
        data = response.get("data") or {}
        if status >= 300 or not data.get("access_token"):
            return self.bootstrap()
        now = int(time.time())
        self.session["access_token"] = data["access_token"]
        self.session["refresh_token"] = data.get("refresh_token", refresh_token)
        self.session["access_expires_at"] = now + int(data.get("expires_in", 1800))
        self.session["refresh_expires_at"] = now + int(data.get("refresh_expires_in", 7776000))
        self._save_session()
        return self.public_status()

    def access_token(self):
        if not self.session.get("access_token"):
            self.bootstrap()
        elif int(self.session.get("access_expires_at", 0)) <= int(time.time()) + 10:
            self.refresh()
        return self.session.get("access_token")

    def api(self, method, path, payload=None, retry=True):
        status, response = self._curl(method, self._api_url(path), payload, self.access_token())
        if status in (401, 403) and retry:
            self.bootstrap()
            return self.api(method, path, payload, False)
        return status, response

    def create_pair(self):
        with self.lock:
            self.bootstrap()
            status, response = self.api("POST", "api/tv/pair/create", {})
            data = response.get("data") or {}
            if status >= 300 or not response.get("success") or not data.get("code"):
                raise ServiceError(response.get("message") or "Could not create pairing code")
            self.session["pair_code"] = data["code"]
            self.session["pair_expires_at"] = int(time.time()) + int(data.get("expires_in", 300))
            self._save_session()
            return {"code": data["code"], "expires_in": data.get("expires_in", 300), "deep_link": "tobevpn://pair?code=" + data["code"]}

    def pair_status(self, code=None):
        with self.lock:
            code = code or self.session.get("pair_code")
            if not code:
                raise ServiceError("Pairing has not started")
            status, response = self.api("GET", "api/tv/pair/status?code=" + code)
            data = response.get("data") or {}
            if status >= 300 or not response.get("success"):
                raise ServiceError(response.get("message") or "Could not check pairing")
            state = data.get("status", "pending")
            if state == "completed":
                self.session.update({
                    "is_linked": True,
                    "telegram_id": data.get("telegram_id"),
                    "short_uuid": data.get("short_uuid") or self.session.get("short_uuid"),
                    "panel_user_uuid": data.get("panel_user_uuid") or self.session.get("panel_user_uuid"),
                })
                self._save_session()
                self.bootstrap()
                self.resolve_subscription_url()
                self.refresh_profile()
            return {"status": state, "linked": bool(self.session.get("is_linked")), "servers": len(self.servers)}

    def resolve_subscription_url(self):
        telegram_id = self.session.get("telegram_id")
        if not telegram_id:
            return None
        status, response = self.api("GET", "api/panel/user-by-telegram/%s" % telegram_id)
        users = response.get("response") if isinstance(response, dict) else None
        if status >= 300 or not isinstance(users, list) or not users:
            return None
        preferred_uuid = self.session.get("panel_user_uuid")
        preferred_short = self.session.get("short_uuid")
        chosen = None
        for user in users:
            if preferred_uuid and user.get("uuid") == preferred_uuid:
                chosen = user
                break
        if chosen is None:
            for user in users:
                if preferred_short and user.get("short_uuid") == preferred_short:
                    chosen = user
                    break
        if chosen is None:
            active = [user for user in users if str(user.get("status", "")).upper() == "ACTIVE"]
            chosen = (active or users)[0]
        self.session["panel_user_uuid"] = chosen.get("uuid")
        self.session["short_uuid"] = chosen.get("short_uuid")
        self.session["subscription_url"] = chosen.get("subscription_url")
        self._save_session()
        return self.session.get("subscription_url")

    def refresh_profile(self):
        with self.lock:
            url = self.session.get("subscription_url") or self.resolve_subscription_url()
            if not url:
                raise ServiceError("Subscription URL is unavailable")
            headers = {
                "x-hwid": self.session.get("device_id", ""),
                "x-device-os": "Android TV",
                "x-ver-os": self.config.get("webos_version", "3.9"),
                "x-device-model": self.config.get("device_model", "LG TV"),
                "User-Agent": self.config.get("user_agent", "ToBeVPN/1.0.35/webos/1"),
            }
            args = ["/usr/bin/curl", "-sS", "--connect-timeout", "8", "--max-time", "20"]
            for key, value in headers.items():
                args += ["-H", "%s: %s" % (key, value)]
            args += ["-w", "\n__TOBEVPN_HTTP__:%{http_code}", url]
            code, out, err = run_quiet(args, 22)
            if code != 0:
                raise ServiceError("Could not download server profile")
            text = decode_text(out)
            marker = "\n__TOBEVPN_HTTP__:"
            if marker not in text:
                raise ServiceError("Invalid server profile response")
            body, status = text.rsplit(marker, 1)
            if int(status.strip()) >= 300:
                raise ServiceError("Server profile returned HTTP %s" % status.strip())
            parsed = []
            for link in parse_profile_links(body):
                try:
                    server = parse_server(link)
                    if server.get("uuid") == "00000000-0000-0000-0000-000000000000":
                        continue
                    if server.get("address") in ("", "127.0.0.1", "0.0.0.0"):
                        continue
                    parsed.append(server)
                except Exception:
                    pass
            if not parsed:
                raise ServiceError("No compatible servers in subscription")
            self.servers = parsed
            self._save_servers()
            return {"servers": [public_server(server, index) for index, server in enumerate(self.servers)]}

    def _resolve_server(self, hostname):
        try:
            socket.inet_aton(hostname)
            return [hostname]
        except socket.error:
            pass
        try:
            values = socket.gethostbyname_ex(hostname)[2]
        except Exception:
            values = []
        values = list(dict((value, True) for value in values).keys())
        if not values:
            raise ServiceError("Could not resolve VPN server")
        return values

    def _wait_port(self, port, seconds):
        until = time.time() + seconds
        while time.time() < until:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.4)
            try:
                sock.connect(("127.0.0.1", port))
                sock.close()
                return True
            except Exception:
                sock.close()
                time.sleep(0.2)
        return False

    def _wait_interface(self, name, seconds):
        until = time.time() + seconds
        while time.time() < until:
            code, out, err = run_quiet([IP_BIN, "link", "show", name])
            if code == 0:
                return True
            time.sleep(0.2)
        return False

    def _lan_routes(self):
        code, out, err = run_quiet([IP_BIN, "-4", "route", "show", "dev", "wlan0", "scope", "link"])
        routes = []
        if code == 0:
            for line in decode_text(out).splitlines():
                first_part = line.split()[0] if line.split() else ""
                if "/" in first_part and first_part != "default":
                    routes.append(first_part)
        return routes or ["192.168.0.0/16"]

    def _delete_rule_pref(self, pref):
        for unused in range(4):
            code, out, err = run_quiet([IP_BIN, "rule", "del", "pref", pref])
            if code != 0:
                break

    def _cleanup_routes(self):
        for pref in (RULE_TUN_PREF, RULE_SERVER_PREF, RULE_LAN_PREF):
            self._delete_rule_pref(pref)
        run_quiet([IP_BIN, "route", "flush", "table", ROUTE_TABLE])
        run_quiet([IP_BIN, "link", "del", "tobe0"])

    def _install_routes(self, server_ips):
        self._cleanup_routes()
        code, out, err = run_quiet([IP_BIN, "route", "replace", "default", "dev", "tobe0", "table", ROUTE_TABLE])
        if code != 0:
            raise ServiceError("Could not create VPN route")
        for lan in self._lan_routes():
            code, out, err = run_quiet([IP_BIN, "rule", "add", "to", lan, "lookup", "main", "pref", RULE_LAN_PREF])
            if code != 0:
                raise ServiceError("Could not preserve local network route")
        for server_ip in server_ips:
            code, out, err = run_quiet([IP_BIN, "rule", "add", "to", server_ip + "/32", "lookup", "main", "pref", RULE_SERVER_PREF])
            if code != 0:
                raise ServiceError("Could not preserve VPN server route")
        code, out, err = run_quiet([IP_BIN, "rule", "add", "lookup", ROUTE_TABLE, "pref", RULE_TUN_PREF])
        if code != 0:
            raise ServiceError("Could not enable VPN route")

    def _open_process_log(self, path):
        return open(path, "ab", 0)

    def connect(self, index):
        with self.lock:
            if not self.servers:
                self.refresh_profile()
            try:
                index = int(index)
                server = self.servers[index]
            except Exception:
                raise ServiceError("Unknown server")
            self.disconnect()
            server_ips = self._resolve_server(server["address"])
            config = build_xray_config(server, server_ips[0])
            write_json(XRAY_CONFIG_PATH, config)
            test_code, out, err = run_quiet([XRAY_BIN, "run", "-test", "-c", XRAY_CONFIG_PATH], 10)
            if test_code != 0:
                log("Xray config rejected")
                raise ServiceError("VPN server configuration is not supported")
            try:
                self.xray_log = self._open_process_log(XRAY_LOG_PATH)
                self.xray = subprocess.Popen([XRAY_BIN, "run", "-c", XRAY_CONFIG_PATH], stdout=self.xray_log, stderr=self.xray_log, close_fds=True)
                if not self._wait_port(SOCKS_PORT, 8) or self.xray.poll() is not None:
                    raise ServiceError("Xray did not start")
                hev_text = """misc:\n  log-level: 'warn'\n  task-stack-size: 24576\n  tcp-buffer-size: 4096\n  max-session-count: 768\ntunnel:\n  name: 'tobe0'\n  mtu: 1500\n  ipv4: '198.18.0.1'\n  ipv6: ''\n  icmp: 'reply'\nsocks5:\n  address: '127.0.0.1'\n  port: %d\n  udp: 'udp'\n""" % SOCKS_PORT
                with open(HEV_CONFIG_PATH, "wb") as handle:
                    handle.write(hev_text.encode("utf-8"))
                os.chmod(HEV_CONFIG_PATH, 0o600)
                self.hev_log = self._open_process_log(HEV_LOG_PATH)
                self.hev = subprocess.Popen([HEV_BIN, HEV_CONFIG_PATH], stdout=self.hev_log, stderr=self.hev_log, close_fds=True)
                if not self._wait_interface("tobe0", 8) or self.hev.poll() is not None:
                    raise ServiceError("TUN interface did not start")
                self._install_routes(server_ips)
                time.sleep(1)
                if self.xray.poll() is not None or self.hev.poll() is not None:
                    raise ServiceError("VPN process stopped unexpectedly")
                self.connected_index = index
                self.connected_name = server.get("name") or server.get("address")
                self.server_ips = server_ips
                self.last_error = ""
                log("Connected to server index %d" % index)
                return self.public_status()
            except Exception as error:
                self.last_error = str(error)
                self.disconnect(preserve_error=True)
                raise

    def disconnect(self, preserve_error=False):
        with self.lock:
            self._cleanup_routes()
            for process in (self.hev, self.xray):
                if process is not None and process.poll() is None:
                    try:
                        process.terminate()
                    except Exception:
                        pass
            until = time.time() + 3
            while time.time() < until and any(proc is not None and proc.poll() is None for proc in (self.hev, self.xray)):
                time.sleep(0.1)
            for process in (self.hev, self.xray):
                if process is not None and process.poll() is None:
                    try:
                        process.kill()
                    except Exception:
                        pass
            self.hev = None
            self.xray = None
            for handle_name in ("hev_log", "xray_log"):
                handle = getattr(self, handle_name)
                if handle:
                    try:
                        handle.close()
                    except Exception:
                        pass
                setattr(self, handle_name, None)
            self.connected_index = None
            self.connected_name = None
            self.server_ips = []
            if not preserve_error:
                self.last_error = ""
            return self.public_status()

    def public_status(self):
        if self.xray is not None and self.xray.poll() is not None:
            self.last_error = "Xray stopped unexpectedly"
            self.disconnect(preserve_error=True)
        if self.hev is not None and self.hev.poll() is not None:
            self.last_error = "TUN stopped unexpectedly"
            self.disconnect(preserve_error=True)
        return {
            "ready": True,
            "linked": bool(self.session.get("is_linked")),
            "pair_code": self.session.get("pair_code") if int(self.session.get("pair_expires_at", 0)) > int(time.time()) else None,
            "servers": [public_server(server, index) for index, server in enumerate(self.servers)],
            "connected": self.connected_index is not None,
            "connected_index": self.connected_index,
            "connected_name": self.connected_name,
            "error": self.last_error,
        }


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "ToBeVPN-webOS/1.0"

    def log_message(self, fmt, *args):
        return

    def _headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._headers(status)
        self.wfile.write(payload)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        return json.loads(decode_text(self.rfile.read(min(length, 65536))))

    def do_OPTIONS(self):
        self._headers(204)

    def do_GET(self):
        try:
            if self.path == "/api/status":
                return self._json(APP.public_status())
            if self.path.startswith("/api/pair/status"):
                query = parse_qs(urlsplit(self.path).query)
                return self._json(APP.pair_status(first(query, "code") or None))
            if self.path == "/api/profile":
                return self._json(APP.refresh_profile())
            return self._json({"error": "Not found"}, 404)
        except Exception as error:
            log("GET failed: %s" % error)
            return self._json({"error": str(error)}, 500)

    def do_POST(self):
        try:
            body = self._body()
            if self.path == "/api/bootstrap":
                return self._json(APP.bootstrap())
            if self.path == "/api/pair":
                return self._json(APP.create_pair())
            if self.path == "/api/profile":
                return self._json(APP.refresh_profile())
            if self.path == "/api/connect":
                return self._json(APP.connect(body.get("index", 0)))
            if self.path == "/api/disconnect":
                return self._json(APP.disconnect())
            return self._json({"error": "Not found"}, 404)
        except Exception as error:
            log("POST failed: %s" % error)
            return self._json({"error": str(error)}, 500)


APP = None
HTTPD = None


def shutdown(signum=None, frame=None):
    if APP is not None:
        try:
            APP.disconnect()
        except Exception:
            pass
    if HTTPD is not None:
        threading.Thread(target=HTTPD.shutdown).start()


def main():
    global APP, HTTPD
    ensure_dir(STATE_DIR)
    os.umask(0o077)
    APP = ToBeVpnService()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    HTTPD = ThreadedHTTPServer(("127.0.0.1", 18765), RequestHandler)
    log("Service listening on 127.0.0.1:18765")
    try:
        HTTPD.serve_forever()
    finally:
        APP.disconnect()
        HTTPD.server_close()


if __name__ == "__main__":
    main()
