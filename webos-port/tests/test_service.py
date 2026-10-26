import importlib.util
import json
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "service" / "tobevpn_service.py"
SPEC = importlib.util.spec_from_file_location("tobevpn_service", str(MODULE_PATH))
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


def test_plain_and_base64_profiles():
    link = "vless://00000000-1111-2222-3333-444444444444@example.com:443?security=reality&type=tcp#Test"
    assert SERVICE.parse_profile_links(link) == [link]
    encoded = __import__("base64").b64encode(link.encode()).decode()
    assert SERVICE.parse_profile_links(encoded) == [link]


def test_vless_reality_config():
    link = (
        "vless://00000000-1111-2222-3333-444444444444@example.com:443"
        "?security=reality&type=xhttp&sni=cdn.example.com&fp=chrome&pbk=public&sid=abcd"
        "&path=%2Fvpn&mode=auto#Moscow"
    )
    server = SERVICE.parse_server(link)
    assert server["name"] == "Moscow"
    assert server["network"] == "xhttp"
    config = SERVICE.build_xray_config(server, "203.0.113.4")
    outbound = config["outbounds"][0]
    assert outbound["settings"]["vnext"][0]["address"] == "203.0.113.4"
    assert outbound["streamSettings"]["realitySettings"]["serverName"] == "cdn.example.com"
    assert outbound["streamSettings"]["xhttpSettings"]["path"] == "/vpn"


def test_hysteria_config():
    server = SERVICE.parse_server(
        "hysteria2://secret@example.com:443?sni=edge.example.com&obfs=salamander&obfs-password=cat#Fast"
    )
    config = SERVICE.build_xray_config(server, "203.0.113.8")
    outbound = config["outbounds"][0]
    assert outbound["protocol"] == "hysteria"
    assert outbound["streamSettings"]["hysteriaSettings"]["auth"] == "secret"
    json.dumps(config)


if __name__ == "__main__":
    test_plain_and_base64_profiles()
    test_vless_reality_config()
    test_hysteria_config()
    print("3 tests passed")
