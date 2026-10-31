package com.tobevpn.tv.domain.model

import java.util.Locale

data class Server(
    val id: String,
    val name: String,
    val address: String,
    val port: Int,
    /**
     * The profile's credential: the VLESS user id, or the Hysteria2 auth
     * password. One field keeps sentinel detection and config comparison
     * protocol-neutral.
     */
    val uuid: String,
    val flow: String = "",
    val security: String = "reality",
    val sni: String = "",
    val fingerprint: String = "chrome",
    val publicKey: String = "",
    val shortId: String = "",
    val network: String = "tcp",
    val path: String = "",
    val host: String = "",
    val alpn: String = "",
    val headerType: String = "",
    val serviceName: String = "",
    val extra: String = "",
    val mode: String = "",
    val spx: String = "",
    val protocol: ServerProtocol = ServerProtocol.VLESS,
    /** Hysteria2 salamander obfuscation password; empty = no obfuscation. */
    val obfsPassword: String = "",
    /** Hysteria2 pinned certificate SHA-256 (hex); empty = verify by name. */
    val pinSha256: String = "",
    /** Hysteria2 port-hopping range ("20000-50000"); empty = single port. */
    val portHopping: String = "",
    /** TLS Encrypted Client Hello config list (base64), from the link's ech=. */
    val echConfigList: String = "",
    /**
     * Xray finalmask object (compact JSON) from the link's fm=, the format
     * v2rayN shares; replaces streamSettings.finalmask. Empty = none.
     */
    val finalMask: String = "",
    val country: String = "",
    val isOnline: Boolean = true,
    val ping: Long = -1,
) {
    /**
     * Identity of the complete profile, for server check results. [id] is
     * address:port:sni and repeats: different servers can share one endpoint,
     * and a result keyed by it could be shown for the wrong server.
     */
    val probeKey: String
        get() = listOf(
            address, port, uuid, flow, security, sni, fingerprint,
            publicKey, shortId, network, path, host, alpn, headerType,
            serviceName, extra, mode, spx, protocol.name, obfsPassword,
            pinSha256, portHopping, echConfigList, finalMask,
        ).joinToString("|")

    /**
     * True for the panel's "subscription expired" placeholder server. Its
     * uuid is all-zeros and the address points nowhere — handing it to xray
     * would SIGSEGV the native loop, so it must never become the selected /
     * connected server.
     */
    val isSentinel: Boolean
        get() = uuid == "00000000-0000-0000-0000-000000000000" ||
            address.isBlank() ||
            address == "127.0.0.1" ||
            address == "0.0.0.0" ||
            name.contains("ИСТЕКЛА", ignoreCase = true) ||
            name.contains("EXPIRED", ignoreCase = true) ||
            name.contains("истекла", ignoreCase = true)

    /** REALITY needs a TLS 1.3-capable ClientHello fingerprint. */
    val isXrayCompatible: Boolean
        get() = !security.trim().equals("reality", ignoreCase = true) ||
            fingerprint.trim().lowercase(Locale.ROOT) !in TLS12_ONLY_REALITY_FINGERPRINTS

    /** Fingerprint actually passed to Xray; legacy TLS 1.2 aliases are repaired. */
    val effectiveFingerprint: String
        get() {
            val requested = fingerprint.trim().ifBlank { DEFAULT_FINGERPRINT }
            return if (isXrayCompatible) requested else DEFAULT_FINGERPRINT
        }

    val isFingerprintRepaired: Boolean
        get() = !isXrayCompatible

    /**
     * Panel online metadata can lag behind real VLESS/Reality reachability.
     * Only sentinel/expired placeholders are not connectable; probes and
     * Xray decide whether a normal server is actually reachable.
     */
    val isAvailable: Boolean
        get() = !isSentinel

    /** The server can be selected unless it is a panel placeholder. */
    val isSelectable: Boolean
        get() = isAvailable

    /**
     * Compares only fields that affect the XRay outbound. Country, online
     * metadata and ping can change without requiring a tunnel restart.
     */
    fun hasSameVpnConfig(other: Server): Boolean =
        address == other.address &&
            port == other.port &&
            uuid == other.uuid &&
            flow == other.flow &&
            security == other.security &&
            sni == other.sni &&
            fingerprint == other.fingerprint &&
            publicKey == other.publicKey &&
            shortId == other.shortId &&
            network == other.network &&
            path == other.path &&
            host == other.host &&
            alpn == other.alpn &&
            headerType == other.headerType &&
            serviceName == other.serviceName &&
            extra == other.extra &&
            mode == other.mode &&
            spx == other.spx &&
            protocol == other.protocol &&
            obfsPassword == other.obfsPassword &&
            pinSha256 == other.pinSha256 &&
            portHopping == other.portHopping &&
            echConfigList == other.echConfigList &&
            finalMask == other.finalMask

    private companion object {
        const val DEFAULT_FINGERPRINT = "chrome"
        val TLS12_ONLY_REALITY_FINGERPRINTS = setOf(
            "android",
            "helloandroid_11_okhttp",
            "hellochrome_58",
            "hellochrome_62",
            "hellofirefox_55",
            "hellofirefox_56",
            "helloios_11_1",
        )
    }
}

/** Proxy protocol of a profile, as shown under the server name. */
enum class ServerProtocol(val displayName: String) {
    VLESS("VLESS"),
    HYSTERIA2("Hysteria2"),
}
