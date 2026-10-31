package com.tobevpn.tv.data.repository

import com.tobevpn.tv.data.local.PrefsDataStore
import com.tobevpn.tv.data.local.dao.ServerDao
import com.tobevpn.tv.data.local.dao.SessionDao
import com.tobevpn.tv.data.local.entity.ServerEntity
import com.tobevpn.tv.data.remote.BotApi
import com.tobevpn.tv.data.remote.SubscriptionPinger
import com.tobevpn.tv.domain.model.Server
import com.tobevpn.tv.domain.model.ServerProtocol
import com.tobevpn.tv.presentation.serverCountryCodeForUi
import com.tobevpn.tv.util.SafeDiagnostics
import com.tobevpn.tv.vpn.Hysteria2UrlParser
import com.tobevpn.tv.vpn.VlessUrlParser
import java.net.InetAddress
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

@Singleton
class VpnRepository @Inject constructor(
    private val serverDao: ServerDao,
    private val sessionDao: SessionDao,
    private val botApi: BotApi,
    private val prefsDataStore: PrefsDataStore,
    private val subscriptionPinger: SubscriptionPinger,
) {
    private val enrichmentScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val refreshGeneration = AtomicLong(0L)

    fun observeServers(): Flow<List<Server>> {
        return serverDao.observeAll().map { entities ->
            entities.map { it.toDomain() }.filterNot { it.isSentinel }
        }
    }

    suspend fun refreshServers(forceRefresh: Boolean = false): Result<List<Server>> {
        return try {
            val shortUuid = sessionDao.getSession()?.shortUuid
                ?: run {
                    clearServerCache()
                    return Result.failure(Exception("No subscription"))
                }

            val subscriptionUrl = prefsDataStore.getCachedSubscriptionUrl(shortUuid)
            val profile = subscriptionPinger.fetchProfile(
                subscriptionUrl = subscriptionUrl,
                subscriptionKey = shortUuid,
            ) ?: throw IllegalStateException("Subscription profile unavailable")
            prefsDataStore.setSubscriptionUsageBlocked(shortUuid, profile.isUsageBlocked)
            prefsDataStore.setUpdateRequired(profile.isUpdateRequired)
            if (profile.isUsageBlocked) {
                clearServerCache()
                return Result.failure(Exception("Subscription access blocked"))
            }
            if (profile.links.isNotEmpty()) {
                return updateServersFromLinks(shortUuid, profile.links)
            }
            if (profile.isSuccessful) {
                keepOwnedCacheOnRefreshMiss(shortUuid)?.let { return Result.success(it) }
                clearServerCache()
                return Result.failure(Exception("No servers available"))
            }
            throw IllegalStateException("Subscription profile unavailable")
        } catch (cancelled: CancellationException) {
            // The profile request is cancellable now (OkHttpAwait): leaving
            // the screen must stop here, not fall back to the cache.
            throw cancelled
        } catch (e: Exception) {
            SafeDiagnostics.warn(TAG, "Server refresh failed; checking local cache: ${SafeDiagnostics.failureCategory(e)}")
            val shortUuid = sessionDao.getSession()?.shortUuid
            val cached = shortUuid?.let { getOwnedCachedServers(it) }.orEmpty()
            if (cached.isNotEmpty()) {
                Result.success(cached)
            } else {
                clearServerCache()
                Result.failure(e)
            }
        }
    }

    suspend fun updateServersFromLinks(
        shortUuid: String,
        links: List<String>,
    ): Result<List<Server>> {
        if (links.isEmpty()) {
            keepOwnedCacheOnRefreshMiss(shortUuid)?.let { return Result.success(it) }
            clearServerCache()
            return Result.failure(Exception("No servers available"))
        }

        val parsedServers = links.mapNotNull { link ->
            VlessUrlParser.parse(link) ?: Hysteria2UrlParser.parse(link)
        }
        val servers = parsedServers.filterNot { it.isSentinel }
        if (servers.isEmpty()) {
            if (parsedServers.none { it.isSentinel }) {
                keepOwnedCacheOnRefreshMiss(shortUuid)?.let { return Result.success(it) }
            }
            clearServerCache()
            return Result.failure(Exception("No servers available"))
        }

        val cachedServers = serverDao.getAll()
        val cachedById = cachedServers.associateBy { it.id }
        val cachedCountryByName = cachedServers
            .filter { it.country.isNotBlank() }
            .associateBy({ normalizedServerName(it.name) }, ServerEntity::country)
        val cachedCountryByAddress = cachedServers
            .filter { it.country.isNotBlank() }
            .associateBy({ it.address.lowercase(Locale.ROOT) }, ServerEntity::country)
        val stableServers = keepStableServerOrder(
            servers = servers,
            cachedServers = cachedServers,
        )
        val entities = stableServers.mapIndexed { index, server ->
            val id = serverId(server)
            val cached = cachedById[id]
            val cachedCountry = cached?.country?.takeIf(String::isNotBlank)
                ?: cachedCountryByName[normalizedServerName(server.name)]
                ?: cachedCountryByAddress[server.address.lowercase(Locale.ROOT)]
            server.toEntity(
                country = resolveRefreshedServerCountry(
                    serverName = server.name,
                    freshCountry = null,
                    fallbackCountry = cachedCountry,
                ),
                isOnline = cached?.isOnline ?: true,
                sortOrder = index,
            )
        }
        val generation = refreshGeneration.incrementAndGet()
        serverDao.replaceAll(entities)
        prefsDataStore.setServerCacheOwner(shortUuid)
        enrichMetadataInBackground(
            shortUuid = shortUuid,
            generation = generation,
            servers = stableServers,
            initialEntities = entities,
        )
        return Result.success(entities.map { it.toDomain() })
    }

    private fun enrichMetadataInBackground(
        shortUuid: String,
        generation: Long,
        servers: List<Server>,
        initialEntities: List<ServerEntity>,
    ) {
        enrichmentScope.launch {
            try {
                val nodes = botApi.getNodes().response
                val countryByAddress = nodes.associate { it.address to it.countryCode }
                val disabledNodeIps = nodes
                    .filter { it.isDisabled || !it.isConnected }
                    .map { it.address }
                    .toSet()
                val initialById = initialEntities.associateBy(ServerEntity::id)

                val enriched = coroutineScope {
                    servers.mapIndexed { index, server ->
                        async {
                            val resolvedIp = try {
                                InetAddress.getByName(server.address).hostAddress
                            } catch (_: Exception) {
                                server.address
                            }
                            val freshCountry = countryByAddress[server.address]
                                ?.takeIf(String::isNotBlank)
                                ?: countryByAddress[resolvedIp]?.takeIf(String::isNotBlank)
                            server.toEntity(
                                country = resolveRefreshedServerCountry(
                                    serverName = server.name,
                                    freshCountry = freshCountry,
                                    fallbackCountry = initialById[serverId(server)]?.country,
                                ),
                                isOnline = resolvedIp !in disabledNodeIps,
                                sortOrder = index,
                            )
                        }
                    }.awaitAll()
                }

                val currentShortUuid = sessionDao.getSession()?.shortUuid
                if (refreshGeneration.get() == generation && currentShortUuid == shortUuid) {
                    serverDao.replaceAll(enriched)
                    prefsDataStore.setServerCacheOwner(shortUuid)
                }
            } catch (error: Exception) {
                SafeDiagnostics.warn(TAG, "Node metadata refresh failed: ${SafeDiagnostics.failureCategory(error)}")
            }
        }
    }

    private suspend fun clearServerCache() {
        refreshGeneration.incrementAndGet()
        serverDao.deleteAll()
        prefsDataStore.clearServerCacheOwner()
    }

    private suspend fun getOwnedCachedServers(shortUuid: String): List<Server> {
        if (!prefsDataStore.isServerCacheOwner(shortUuid)) return emptyList()
        return serverDao.getAll().map { it.toDomain() }.filterNot { it.isSentinel }
    }

    private suspend fun keepOwnedCacheOnRefreshMiss(shortUuid: String): List<Server>? {
        val session = sessionDao.getSession()
        if (session?.shortUuid != shortUuid) return null
        if (session.userPlan == "EXPIRED") return null
        if (prefsDataStore.isSubscriptionUsageBlocked(shortUuid)) return null
        return getOwnedCachedServers(shortUuid).takeIf { it.isNotEmpty() }
    }

    private fun keepStableServerOrder(
        servers: List<Server>,
        cachedServers: List<ServerEntity>,
    ): List<Server> {
        if (cachedServers.isEmpty()) {
            return servers.sortedWith(
                compareBy<Server> { serverNameParts(it.name).base }
                    .thenBy { serverNameParts(it.name).number ?: Int.MAX_VALUE }
                    .thenBy { it.name.lowercase(Locale.ROOT) }
                    .thenBy { serverId(it) },
            )
        }
        val cachedPositionById = cachedServers
            .mapIndexed { index, entity -> entity.id to index }
            .toMap()
        val cachedGroupPositionByName = cachedServers
            .mapIndexed { index, entity -> serverNameParts(entity.name).base to index }
            .groupBy({ it.first }, { it.second })
            .mapValues { (_, positions) -> positions.min() }

        return servers
            .mapIndexed { profileIndex, server ->
                val nameParts = serverNameParts(server.name)
                OrderedServer(
                    server = server,
                    cachedPosition = cachedPositionById[serverId(server)],
                    cachedGroupPosition = cachedGroupPositionByName[nameParts.base],
                    nameParts = nameParts,
                    profileIndex = profileIndex,
                )
            }
            .sortedWith(
                compareBy<OrderedServer> {
                    if (it.nameParts.number != null) {
                        it.cachedGroupPosition ?: it.cachedPosition ?: Int.MAX_VALUE
                    } else {
                        it.cachedPosition ?: it.cachedGroupPosition ?: Int.MAX_VALUE
                    }
                }
                    .thenBy { it.nameParts.base }
                    .thenBy { it.nameParts.number ?: Int.MAX_VALUE }
                    .thenBy { it.server.name.lowercase(Locale.ROOT) }
                    .thenBy { serverId(it.server) }
                    .thenBy { it.profileIndex },
            )
            .map { it.server }
    }

    private fun serverNameParts(name: String): ServerNameParts {
        val normalized = normalizedServerName(name)
        val match = TRAILING_NUMBER_REGEX.matchEntire(normalized)
        return if (match != null) {
            ServerNameParts(
                base = match.groupValues[1].trim(),
                number = match.groupValues[2].toIntOrNull(),
            )
        } else {
            ServerNameParts(base = normalized, number = null)
        }
    }

    suspend fun getServers(): List<Server> {
        return serverDao.getAll().map { it.toDomain() }.filterNot { it.isSentinel }
    }

    suspend fun clearServers() {
        clearServerCache()
    }

    suspend fun clearCachedServers() {
        clearServerCache()
    }

    // Hysteria2 often shares host:port with a VLESS inbound (UDP vs TCP 443);
    // the prefix keeps the two apart, and VLESS ids stay as they were so a
    // saved selection survives the update.
    private fun serverId(server: Server) =
        (if (server.protocol == ServerProtocol.HYSTERIA2) "hy2:" else "") +
            "${server.address}:${server.port}:${server.sni}"

    private fun normalizedServerName(name: String): String = name
        .trim()
        .replace(Regex("\\s+"), " ")
        .lowercase(Locale.ROOT)

    private fun Server.toEntity(
        country: String,
        isOnline: Boolean,
        sortOrder: Int,
    ) = ServerEntity(
        id = serverId(this),
        name = name,
        address = address,
        port = port,
        uuid = uuid,
        flow = flow,
        security = security,
        sni = sni,
        fingerprint = fingerprint,
        publicKey = publicKey,
        shortId = shortId,
        network = network,
        path = path,
        host = host,
        alpn = alpn,
        headerType = headerType,
        serviceName = serviceName,
        extra = extra,
        mode = mode,
        spx = spx,
        protocol = protocol.name,
        obfsPassword = obfsPassword,
        pinSha256 = pinSha256,
        portHopping = portHopping,
        echConfigList = echConfigList,
        finalMask = finalMask,
        country = country,
        isOnline = isOnline,
        sortOrder = sortOrder,
    )

    private fun ServerEntity.toDomain() = Server(
        id = id,
        name = name,
        address = address,
        port = port,
        uuid = uuid,
        flow = flow,
        security = security,
        sni = sni,
        fingerprint = fingerprint,
        publicKey = publicKey,
        shortId = shortId,
        network = network,
        path = path,
        host = host,
        alpn = alpn,
        headerType = headerType,
        serviceName = serviceName,
        extra = extra,
        mode = mode,
        spx = spx,
        protocol = ServerProtocol.entries.firstOrNull { it.name == protocol } ?: ServerProtocol.VLESS,
        obfsPassword = obfsPassword,
        pinSha256 = pinSha256,
        portHopping = portHopping,
        echConfigList = echConfigList,
        finalMask = finalMask,
        country = country,
        isOnline = isOnline,
    )

    private companion object {
        const val TAG = "VpnRepository"
        val TRAILING_NUMBER_REGEX = Regex("""^(.*?)[\s#_-]+(\d+)$""")
    }

    private data class OrderedServer(
        val server: Server,
        val cachedPosition: Int?,
        val cachedGroupPosition: Int?,
        val nameParts: ServerNameParts,
        val profileIndex: Int,
    )

    private data class ServerNameParts(
        val base: String,
        val number: Int?,
    )
}

/**
 * Keep phone and TV flag resolution identical. A refresh is shown before the
 * optional node metadata request completes, so an empty response must not
 * replace a known flag with the globe placeholder.
 */
internal fun resolveRefreshedServerCountry(
    serverName: String,
    freshCountry: String?,
    fallbackCountry: String?,
): String {
    val freshResolved = serverCountryCodeForUi(
        countryCode = freshCountry.orEmpty(),
        serverName = serverName,
    )
    if (freshResolved.isNotBlank()) return freshResolved
    return serverCountryCodeForUi(
        countryCode = fallbackCountry.orEmpty(),
        serverName = serverName,
    )
}
