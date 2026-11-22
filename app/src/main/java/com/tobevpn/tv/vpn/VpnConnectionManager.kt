package com.tobevpn.tv.vpn

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import com.tobevpn.tv.BuildConfig
import com.tobevpn.tv.R
import com.tobevpn.tv.data.local.PrefsDataStore
import com.tobevpn.tv.data.local.dao.SessionDao
import com.tobevpn.tv.data.local.dao.TrafficLogDao
import com.tobevpn.tv.data.local.entity.TrafficLogEntity
import com.tobevpn.tv.data.repository.AppFilterRepository
import com.tobevpn.tv.data.repository.AuthRepository
import com.tobevpn.tv.data.repository.ServerProfileProbeRepository
import com.tobevpn.tv.data.repository.ServerQualityRepository
import com.tobevpn.tv.data.repository.UsageRepository
import com.tobevpn.tv.data.repository.VpnRepository
import com.tobevpn.tv.domain.model.AppFilterMode
import com.tobevpn.tv.domain.model.ConnectionState
import com.tobevpn.tv.domain.model.RealityFingerprintPolicy
import com.tobevpn.tv.domain.model.Server
import com.tobevpn.tv.domain.model.UsageInfo
import com.tobevpn.tv.presentation.servers.isSelectedServer
import com.tobevpn.tv.presentation.servers.serverSelectionKey
import com.tobevpn.tv.presentation.servers.stableServerId
import com.tobevpn.tv.util.SafeDiagnostics
import com.tobevpn.tv.util.diagnosticServerDescriptor
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

@Singleton
class VpnConnectionManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val usageRepository: UsageRepository,
    private val prefsDataStore: PrefsDataStore,
    private val sessionDao: SessionDao,
    private val trafficLogDao: TrafficLogDao,
    private val authRepository: AuthRepository,
    private val vpnRepository: VpnRepository,
    private val serverQualityRepository: ServerQualityRepository,
    private val serverProfileProbeRepository: ServerProfileProbeRepository,
    private val appFilterRepository: AppFilterRepository,
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val mutex = Mutex()
    private val statsMutex = Mutex()
    private val tunnelMaintenanceMutex = Mutex()
    private val tunnelProbeMutex = Mutex()

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _currentServer = MutableStateFlow<Server?>(null)
    val currentServer: StateFlow<Server?> = _currentServer.asStateFlow()

    val usageInfo: StateFlow<UsageInfo> = usageRepository.observeUsage()
        .stateIn(scope, SharingStarted.Eagerly, UsageInfo())

    private val _sessionTimeSeconds = MutableStateFlow(0L)
    val sessionTimeSeconds: StateFlow<Long> = _sessionTimeSeconds.asStateFlow()

    private val _sessionBytes = MutableStateFlow(0L)
    val sessionBytes: StateFlow<Long> = _sessionBytes.asStateFlow()

    private var usageTrackingJob: Job? = null
    private val healthJobLock = Any()
    private var healthCheckJob: Job? = null
    private val recoveryJobLock = Any()
    private var recoveryJob: Job? = null
    private val networkResumeLock = Any()
    private var networkResumeCallback: ConnectivityManager.NetworkCallback? = null
    private var networkResumeTimeoutJob: Job? = null
    private val networkResumeRateLimiter = NetworkResumeRateLimiter(
        maxAttempts = NETWORK_RESUME_MAX_ATTEMPTS,
        windowMs = NETWORK_RESUME_RATE_LIMIT_WINDOW_MS,
    )
    private val recentTunnelFailures = RecentTunnelFailureRegistry()
    private val activeTunnelProbeCall = AtomicReference<Call?>(null)
    private var connectionStartTime = 0L
    private var sessionBytesAccumulated = 0L
    private var sessionStartUsageBytes = 0L
    private var diagnosticIntervalStartedAtMs = 0L
    private var diagnosticIntervalUplinkBytes = 0L
    private var diagnosticIntervalDownlinkBytes = 0L
    private var trafficQualityConfirmed = false
    private var lastTunnelDownlinkElapsedMs = 0L
    private val downlinkEvidenceAccumulator = DownlinkEvidenceAccumulator()
    private val probeDownlinkEvidenceGate = ProbeDownlinkEvidenceGate()
    private var qualityDownlinkBytesAccumulated = 0L
    private var confirmedConnectionSuccessKey: String? = null
    private var watchdogRecoveryAttempts = 0
    private val watchdogRecoveryExcludedServers = linkedMapOf<String, Server>()
    private val attemptedRealityFingerprints = linkedSetOf<String>()

    @Volatile
    private var fingerprintAttemptServerKey: String? = null

    @Volatile
    private var activeRealityFingerprint: String? = null
    // Monotonic counter to invalidate stale operations
    private var connectionGeneration = 0
    private val latestConnectionGeneration = AtomicInteger(0)
    // Updated synchronously when the user starts, switches, or stops so a
    // coroutine delayed by network preparation cannot later revive old intent.
    private val requestedOperation = AtomicInteger(0)
    private val permittedServiceStartGeneration = AtomicInteger(-1)

    private val tunnelProbeClient = OkHttpClient.Builder()
        .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", VpnConfig.LOCAL_SOCKS_PORT)))
        .connectionPool(ConnectionPool(0, 1, TimeUnit.MILLISECONDS))
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    init {
        SafeDiagnostics.installStateSnapshotProvider(::diagnosticStateSnapshot)
        scope.launch {
            try {
                usageRepository.ensureInitialized()
            } catch (error: Exception) {
                SafeDiagnostics.warn(TAG, "Usage init failed: ${SafeDiagnostics.failureCategory(error)}")
            }
        }
        scope.launch { reportTunnelKilledWithApp() }
        scope.launch {
            try {
                observeAppFilterAndReconnect()
            } catch (error: Exception) {
                SafeDiagnostics.warn(TAG, "App filter observer failed: ${SafeDiagnostics.failureCategory(error)}")
            }
        }
    }

    /**
     * The app process died while the tunnel was up (the TV killed the whole
     * app, so the service could not report it). Shown once, on the next start
     * in the same boot and build: a reboot or an update ends the VPN too and
     * is not the TV's background killer.
     */
    private suspend fun reportTunnelKilledWithApp() {
        val marker = runCatching { prefsDataStore.getActiveTunnelMarker() }.getOrNull() ?: return
        runCatching { prefsDataStore.setActiveTunnelMarker(null) }
        if (marker != activeTunnelMarker()) return
        mutex.withLock {
            if (_connectionState.value is ConnectionState.Disconnected) {
                SafeDiagnostics.warn(TAG, "VPN ended with the app process: STOPPED_BY_SYSTEM")
                _connectionState.value = stoppedBySystemError()
            }
        }
    }

    private fun activeTunnelMarker(): String {
        val bootCount = runCatching {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
        }.getOrDefault(-1)
        return "$bootCount|${BuildConfig.VERSION_CODE}"
    }

    private fun stoppedBySystemError() = ConnectionState.Error(
        message = context.getString(R.string.error_vpn_stopped_by_system),
        stoppedBySystem = true,
    )

    private fun rememberTunnelActive(active: Boolean) {
        val marker = if (active) activeTunnelMarker() else null
        scope.launch { runCatching { prefsDataStore.setActiveTunnelMarker(marker) } }
    }

    /** Privacy-safe state captured with crashes and diagnostic boundaries. */
    internal fun diagnosticStateSnapshot(): String {
        val stateName = when (_connectionState.value) {
            is ConnectionState.Disconnected -> "DISCONNECTED"
            is ConnectionState.Connecting -> "CONNECTING"
            is ConnectionState.Connected -> "CONNECTED"
            is ConnectionState.Error -> "ERROR"
        }
        val server = _currentServer.value
        val sessionSeconds = if (connectionStartTime > 0L) {
            ((System.currentTimeMillis() - connectionStartTime) / 1_000L).coerceAtLeast(0L)
        } else {
            0L
        }
        return buildString {
            append("state=").append(stateName)
            append(" generation=").append(latestConnectionGeneration.get())
            append(" xray_running=").append(XRayCore.isRunning)
            append(" own_vpn_network=").append(isOwnVpnNetworkActive())
            append(" own_vpn_system_check=").append(ownVpnNetworkValidation())
            append(" server_selected=").append(server != null)
            append(" server_security=").append(server?.security?.ifBlank { "NONE" } ?: "NONE")
            append(" server_transport=").append(server?.network?.ifBlank { "NONE" } ?: "NONE")
            append(' ').append(server?.let(::activeServerDiagnosticDescriptor) ?: "server_ref=NONE")
            append(" session_s=").append(sessionSeconds)
            append(" session_kib=").append(sessionBytesAccumulated / 1024L)
            append(" downlink_evidence=").append(lastTunnelDownlinkElapsedMs > 0L)
            append(" auto_recovery_attempts=").append(watchdogRecoveryAttempts)
            append(" waiting_network=").append(networkResumeCallback != null)
        }
    }

    @OptIn(kotlinx.coroutines.FlowPreview::class)
    private suspend fun observeAppFilterAndReconnect() {
        val filterEmptyMsg = context.getString(R.string.app_filter_empty_warning)
        appFilterRepository.observeState()
            .distinctUntilChanged()
            .drop(1)
            .onEach {
                val pre = _connectionState.value
                if (pre is ConnectionState.Error && pre.message == filterEmptyMsg) {
                    _connectionState.value = ConnectionState.Disconnected
                }
            }
            // A delay inside collect processes every checkbox change. A real
            // debounce collapses a D-pad burst into a single reconnect.
            .debounce(600)
            .collect { state ->
                val current = _connectionState.value
                if (current !is ConnectionState.Connected && current !is ConnectionState.Connecting) {
                    return@collect
                }
                val server = _currentServer.value ?: return@collect
                if (state.mode == AppFilterMode.WHITELIST && state.selectedPackages.isEmpty()) {
                    stopVpn()
                    return@collect
                }
                switchServer(server)
            }
    }

    private suspend fun isPaidUser(): Boolean {
        val session = sessionDao.getSession() ?: return false
        return (session.userPlan == "PAID" || session.userPlan == "ADMIN") &&
            session.authState == "AUTHENTICATED"
    }


    fun startVpn(server: Server, onAttemptHandled: (() -> Unit)? = null) {
        SafeDiagnostics.info(
            TAG,
            "VPN connect requested: ${diagnosticServerDescriptor(server)}",
        )
        cancelPendingNetworkResume("CONNECT_REQUEST")
        cancelPendingRecovery("CONNECT_REQUEST")
        startVpnInternal(
            server = server,
            resetWatchdogRecovery = true,
            request = requestedOperation.incrementAndGet(),
            onAttemptHandled = onAttemptHandled,
        )
    }

    private fun startVpnInternal(
        server: Server,
        resetWatchdogRecovery: Boolean,
        request: Int,
        preserveServerSelection: Boolean = false,
        onAttemptHandled: (() -> Unit)? = null,
    ) {
        scope.launch {
            val gen: Int
            mutex.withLock {
                if (request != requestedOperation.get()) {
                    onAttemptHandled?.invoke()
                    return@launch
                }
                val current = _connectionState.value
                if (current is ConnectionState.Connecting || current is ConnectionState.Connected) {
                    onAttemptHandled?.invoke()
                    return@launch
                }

                if (prefsDataStore.isUpdateRequired()) {
                    SafeDiagnostics.warn(TAG, "VPN connect blocked: MINIMUM_APP_VERSION")
                    onAttemptHandled?.invoke()
                    return@launch
                }

                // Hard guard against the panel's "subscription expired"
                // placeholder server. xray's native loop would SIGSEGV on
                // its all-zeros uuid / blank address; surface a friendly
                // error instead and bail before the service is even
                // started.
                if (server.isSentinel) {
                    SafeDiagnostics.warn(TAG, "VPN connect blocked: SUBSCRIPTION_EXPIRED")
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.error_subscription_expired)
                    )
                    onAttemptHandled?.invoke()
                    return@launch
                }
                if (!server.isAvailable && !prefsDataStore.isAutomaticServerSelection()) {
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.servers_empty)
                    )
                    onAttemptHandled?.invoke()
                    return@launch
                }

                if (!isPaidUser() && usageRepository.isExhausted()) {
                    SafeDiagnostics.warn(TAG, "VPN connect blocked: USAGE_LIMIT")
                    _connectionState.value = ConnectionState.Error(context.getString(R.string.vpn_error_limit_exhausted))
                    onAttemptHandled?.invoke()
                    return@launch
                }

                val filterCheck = appFilterRepository.getSnapshot()
                if (filterCheck.mode == AppFilterMode.WHITELIST && filterCheck.selectedPackages.isEmpty()) {
                    SafeDiagnostics.warn(TAG, "VPN connect blocked: APP_FILTER_EMPTY")
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.app_filter_empty_warning),
                    )
                    onAttemptHandled?.invoke()
                    return@launch
                }

                gen = advanceGeneration()
                if (resetWatchdogRecovery) {
                    watchdogRecoveryAttempts = 0
                    watchdogRecoveryExcludedServers.clear()
                }
                resetRealityFingerprintAttempts(server)
                _currentServer.value = server
                _connectionState.value = ConnectionState.Connecting
                permittedServiceStartGeneration.set(gen)
                SafeDiagnostics.trace(TAG, "VPN state changed: CONNECTING generation=$gen")
                onAttemptHandled?.invoke()
            }

            // The subscription response can carry a server-side access block.
            // Always await this check before starting a new tunnel.
            if (rejectBlockedConnection(request, gen)) return@launch

            val serverToStart = refreshServerAfterAccessCheck(
                server = server,
                preserveServerSelection = preserveServerSelection,
            ) ?: run {
                performStop(
                    errorMessage = context.getString(R.string.servers_empty),
                    request = request,
                    expectedGeneration = gen,
                )
                return@launch
            }
            if (!mayStartTunnel(request, gen)) return@launch
            val realityFingerprintToStart = mutex.withLock {
                if (request == requestedOperation.get() &&
                    gen == connectionGeneration &&
                    _connectionState.value is ConnectionState.Connecting
                ) {
                    _currentServer.value = serverToStart
                    resetRealityFingerprintAttempts(serverToStart)
                } else {
                    null
                }
            }
            if (!preserveServerSelection) persistAutomaticSelectionIfNeeded(serverToStart)
            if (!mayStartTunnel(request, gen)) return@launch

            SafeDiagnostics.info(
                TAG,
                "VPN service launch prepared: generation=$gen " +
                    diagnosticServerDescriptor(serverToStart, realityFingerprintToStart),
            )

            val intent = Intent(context, ToBeVpnService::class.java).apply {
                action = ToBeVpnService.ACTION_START
                putExtra(
                    ToBeVpnService.EXTRA_SERVER_CONFIG,
                    VpnConfig.buildConfigJson(
                        server = serverToStart,
                        realityFingerprintOverride = realityFingerprintToStart,
                    ),
                )
                putExtra(ToBeVpnService.EXTRA_GENERATION, gen)
            }
            launchTunnelService(
                intent = intent,
                request = request,
                generation = gen,
                serviceAlreadyForeground = preserveServerSelection,
            )
        }
    }

    /**
     * Android 12+ can reject a foreground-service start while the app is in
     * the background (notably during watchdog recovery). Surface an error
     * instead of crashing the whole process.
     */
    private suspend fun launchTunnelService(
        intent: Intent,
        request: Int,
        generation: Int,
        serviceAlreadyForeground: Boolean = false,
    ) {
        try {
            if (serviceAlreadyForeground) {
                context.startService(intent)
            } else {
                context.startForegroundService(intent)
            }
        } catch (error: Exception) {
            SafeDiagnostics.warn(
                TAG,
                "VPN service start rejected: ${SafeDiagnostics.failureCategory(error)}",
            )
            performStop(
                errorMessage = context.getString(R.string.error_generic),
                request = request,
                expectedGeneration = generation,
            )
        }
    }

    /**
     * Reconnects VPN to a different server without user having to
     * manually stop and start. If VPN is not currently active, just starts.
     */
    fun switchServer(server: Server, allowStaleOnRefreshMiss: Boolean = true) {
        SafeDiagnostics.info(
            TAG,
            "VPN server switch requested: ${diagnosticServerDescriptor(server)}",
        )
        cancelPendingNetworkResume("SERVER_SWITCH_REQUEST")
        cancelPendingRecovery("SERVER_SWITCH_REQUEST")
        permittedServiceStartGeneration.set(-1)
        val request = requestedOperation.incrementAndGet()
        scope.launch {
            if (server.isSentinel) {
                mutex.withLock {
                    if (request != requestedOperation.get()) return@launch
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.error_subscription_expired)
                    )
                }
                return@launch
            }
            if (!server.isAvailable && !prefsDataStore.isAutomaticServerSelection()) {
                mutex.withLock {
                    if (request != requestedOperation.get()) return@launch
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.servers_empty)
                    )
                }
                return@launch
            }

            var shouldStartDirectly = false
            var restartGeneration = -1
            mutex.withLock {
                if (request != requestedOperation.get()) return@launch
                val current = _connectionState.value
                val wasActive = current is ConnectionState.Connected || current is ConnectionState.Connecting
                if (!wasActive) {
                    shouldStartDirectly = true
                    return@withLock
                }

                restartGeneration = advanceGeneration()
                watchdogRecoveryAttempts = 0
                watchdogRecoveryExcludedServers.clear()
                resetRealityFingerprintAttempts(server)
                _currentServer.value = server
                _connectionState.value = ConnectionState.Connecting
                permittedServiceStartGeneration.set(restartGeneration)
                stopUsageTracking()
                flushPendingUsage()
                saveSessionLog()
                _sessionTimeSeconds.value = 0L
            }

            if (shouldStartDirectly) {
                startVpnInternal(server, resetWatchdogRecovery = true, request = request)
                return@launch
            }

            val stopIntent = Intent(context, ToBeVpnService::class.java).apply {
                action = ToBeVpnService.ACTION_STOP
                putExtra(ToBeVpnService.EXTRA_STOP_BEFORE_GENERATION, restartGeneration)
            }
            startServiceSafely(stopIntent)
            // Give the service a short window to close the old TUN before
            // establishing a new one, but keep UI state as Connecting the
            // whole time so the power button cannot interleave a manual
            // start/stop into this reconnect sequence.
            delay(300)

            val stillCurrent = mayStartTunnel(request, restartGeneration)
            if (!stillCurrent) return@launch

            if (rejectBlockedConnection(request, restartGeneration)) return@launch

            val serverToStart = refreshServerAfterAccessCheck(
                server = server,
                allowStaleOnRefreshMiss = allowStaleOnRefreshMiss,
            ) ?: run {
                performStop(
                    errorMessage = context.getString(R.string.servers_empty),
                    request = request,
                    expectedGeneration = restartGeneration,
                )
                return@launch
            }
            if (!mayStartTunnel(request, restartGeneration)) return@launch
            val realityFingerprintToStart = mutex.withLock {
                if (request == requestedOperation.get() &&
                    restartGeneration == connectionGeneration &&
                    _connectionState.value is ConnectionState.Connecting
                ) {
                    _currentServer.value = serverToStart
                    resetRealityFingerprintAttempts(serverToStart)
                } else {
                    null
                }
            }
            persistAutomaticSelectionIfNeeded(serverToStart)
            if (!mayStartTunnel(request, restartGeneration)) return@launch

            val startIntent = Intent(context, ToBeVpnService::class.java).apply {
                action = ToBeVpnService.ACTION_START
                putExtra(
                    ToBeVpnService.EXTRA_SERVER_CONFIG,
                    VpnConfig.buildConfigJson(
                        server = serverToStart,
                        realityFingerprintOverride = realityFingerprintToStart,
                    ),
                )
                putExtra(ToBeVpnService.EXTRA_GENERATION, restartGeneration)
            }
            launchTunnelService(startIntent, request, restartGeneration)
        }
    }

    fun stopVpn() {
        SafeDiagnostics.info(TAG, "VPN disconnect requested")
        cancelPendingNetworkResume("DISCONNECT_REQUEST")
        cancelPendingRecovery("DISCONNECT_REQUEST")
        permittedServiceStartGeneration.set(-1)
        val request = requestedOperation.incrementAndGet()
        if (_connectionState.value !is ConnectionState.Disconnected ||
            XRayCore.isRunning ||
            isOwnVpnNetworkActive()
        ) {
            ToBeVpnService.cleanupActiveInstance()
            sendStopIntent(force = true)
        }
        scope.launch { performStop(request = request) }
    }

    // allNetworks has no replacement for a one-off look at every network, and
    // activeNetwork will not do: this app's own traffic bypasses its VPN.
    @Suppress("DEPRECATION")
    fun isOwnVpnNetworkActive(): Boolean {
        val connectivityManager = context.getSystemService(ConnectivityManager::class.java)
            ?: return XRayCore.isRunning
        return connectivityManager.allNetworks.any { network ->
            val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return@any false
            if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@any false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                capabilities.ownerUid == context.applicationInfo.uid
            } else {
                true
            }
        }
    }

    /** Android's independent verdict for this app's VPN network, for logs only. */
    @Suppress("DEPRECATION")
    private fun ownVpnNetworkValidation(): String {
        val connectivityManager = context.getSystemService(ConnectivityManager::class.java)
            ?: return "UNKNOWN"
        val capabilities = connectivityManager.allNetworks
            .asSequence()
            .mapNotNull(connectivityManager::getNetworkCapabilities)
            .firstOrNull { capability ->
                capability.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                        capability.ownerUid == context.applicationInfo.uid)
            }
            ?: return "NO_VPN_NETWORK"
        return if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
            "VALIDATED"
        } else {
            "NOT_VALIDATED"
        }
    }

    fun mayServiceStart(generation: Int): Boolean =
        permittedServiceStartGeneration.get() == generation

    private suspend fun mayStartTunnel(request: Int, generation: Int): Boolean =
        mutex.withLock {
            request == requestedOperation.get() &&
                generation == connectionGeneration &&
                _connectionState.value is ConnectionState.Connecting
        }

    private suspend fun rejectBlockedConnection(request: Int, generation: Int): Boolean {
        val blocked = runCatching { authRepository.pingHwidOnly() }.getOrDefault(false)
        if (!blocked) return false
        SafeDiagnostics.warn(TAG, "VPN connect blocked: SERVER_ACCESS_RESTRICTED")
        mutex.withLock {
            if (request == requestedOperation.get() &&
                generation == connectionGeneration &&
                _connectionState.value is ConnectionState.Connecting
            ) {
                advanceGeneration()
                permittedServiceStartGeneration.set(-1)
                _connectionState.value = ConnectionState.Error(
                    context.getString(R.string.error_usage_blocked)
                )
            }
        }
        return true
    }

    private suspend fun refreshServerAfterAccessCheck(
        server: Server,
        excludedAutoServers: List<Server> = emptyList(),
        allowStaleOnRefreshMiss: Boolean = true,
        preserveServerSelection: Boolean = false,
    ): Server? {
        val automatic = if (preserveServerSelection) {
            false
        } else {
            prefsDataStore.isAutomaticServerSelection()
        }
        val refreshedResult = vpnRepository.refreshServers(forceRefresh = true)
        val resolved = refreshedResult
            .getOrNull()
            .orEmpty()
            .let { refreshed ->
                val availableServers = refreshed.filter { it.isAvailable }
                if (preserveServerSelection) {
                    availableServers.firstOrNull {
                        isSelectedServer(
                            server = it,
                            selectedId = server.id,
                            selectedKey = serverSelectionKey(server),
                        )
                    }
                } else if (automatic) {
                    // A profile the last server check carried a request
                    // through beats a bare TCP ping (same as the phone).
                    val verifiedDelays = serverProfileProbeRepository
                        .getCachedProfileDelays(availableServers)
                    serverQualityRepository.selectBestVerifiedServer(
                        servers = availableServers,
                        verifiedDelays = verifiedDelays,
                        excludedServers = excludedAutoServers,
                    ) ?: serverQualityRepository.selectBestServer(
                        servers = availableServers,
                        excludedServers = excludedAutoServers,
                        avoidEndpointServers = excludedAutoServers,
                        recentlyFailedProfiles = recentTunnelFailures.penalisedServers(
                            SystemClock.elapsedRealtime(),
                        ),
                        forceProbe = excludedAutoServers.isNotEmpty(),
                    )
                } else {
                    availableServers.firstOrNull {
                        isSelectedServer(
                            server = it,
                            selectedId = server.id,
                            selectedKey = serverSelectionKey(server),
                        )
                    }
                }
            }
        val staleAllowed = resolved == null && allowStaleOnRefreshMiss &&
            canUseStaleServerAfterRefreshMiss(server)
        val selected = resolved ?: server.takeIf { staleAllowed }
        SafeDiagnostics.trace(
            TAG,
            "VPN server revalidation: automatic=$automatic refresh_success=" +
                refreshedResult.isSuccess + " refreshed_count=" +
                refreshedResult.getOrNull().orEmpty().size + " stale_used=$staleAllowed selected=" +
                (selected?.let(::diagnosticServerDescriptor) ?: "NONE"),
        )
        return selected
    }

    private suspend fun canUseStaleServerAfterRefreshMiss(server: Server): Boolean {
        if (!server.isAvailable) return false
        val session = sessionDao.getSession() ?: return false
        if (session.userPlan == "EXPIRED") return false
        val shortUuid = session.shortUuid ?: return false
        return !prefsDataStore.isSubscriptionUsageBlocked(shortUuid)
    }

    private suspend fun persistAutomaticSelectionIfNeeded(server: Server) {
        if (!prefsDataStore.isAutomaticServerSelection()) return
        prefsDataStore.setAutomaticSelectedServer(
            id = stableServerId(server),
            key = serverSelectionKey(server),
        )
    }

    /**
     * Called only for a real physical-network handover. Keep the same selected
     * server in manual mode, reload Xray on the new underlay and serialize that
     * work against watchdog recovery.
     */
    fun handleUnderlyingNetworkHandover(generation: Int) {
        SafeDiagnostics.info(TAG, "Underlying network handover requested: generation=$generation")
        scope.launch {
            val duringStartup = when (_connectionState.value) {
                is ConnectionState.Connecting -> true
                is ConnectionState.Connected -> false
                else -> return@launch
            }
            if (!isExpectedTunnelState(generation, duringStartup)) return@launch
            if (!tunnelMaintenanceMutex.tryLock()) return@launch
            var scheduleRecovery = false
            try {
                if (!isExpectedTunnelState(generation, duringStartup)) return@launch
                cancelTunnelHealthMonitoring()
                val reloaded = ToBeVpnService.reloadActiveCore(
                    expectedGeneration = generation,
                    reason = "NETWORK_HANDOVER",
                    showConnectedNotification = !duringStartup,
                )
                if (reloaded && isExpectedTunnelState(generation, duringStartup)) {
                    if (duringStartup) {
                        startStartupTunnelValidation(generation, "NETWORK_HANDOVER")
                    } else {
                        startTunnelHealthCheck(
                            initialDelayMs = TUNNEL_HEALTH_AFTER_RELOAD_DELAY_MS,
                        )
                    }
                } else if (isExpectedTunnelState(generation, duringStartup)) {
                    scheduleRecovery = true
                }
            } finally {
                tunnelMaintenanceMutex.unlock()
            }
            if (scheduleRecovery) {
                scheduleTunnelRecovery(
                    generation = generation,
                    source = "NETWORK_HANDOVER_RELOAD_FAILED",
                    duringStartup = duringStartup,
                )
            }
        }
    }

    fun handleUnderlyingNetworkUnavailable(generation: Int) {
        SafeDiagnostics.warn(TAG, "Underlying network unavailable: generation=$generation")
        cancelPendingRecovery("UNDERLYING_NETWORK_UNAVAILABLE")
        scope.launch {
            val active = generation == latestConnectionGeneration.get() &&
                (_connectionState.value is ConnectionState.Connecting ||
                    _connectionState.value is ConnectionState.Connected)
            if (!active) return@launch
            val serverToResume = _currentServer.value
            val resumeRequest = requestedOperation.get()
            val waitingServiceKept = stopForUnderlyingNetworkTimeout(generation) ?: return@launch
            val resumeScheduled = waitingServiceKept &&
                serverToResume != null &&
                resumeRequest == requestedOperation.get() &&
                _connectionState.value == ConnectionState.Error(
                    context.getString(R.string.vpn_waiting_for_network_resume),
                ) &&
                scheduleNetworkResume(
                    server = serverToResume,
                    request = resumeRequest,
                    waitingServiceGeneration = generation,
                )
            if (waitingServiceKept && !resumeScheduled) {
                finishNetworkResumeWait(
                    request = resumeRequest,
                    waitingServiceGeneration = generation,
                )
            }
        }
    }

    private suspend fun stopForUnderlyingNetworkTimeout(generation: Int): Boolean? {
        var handled = false
        var waitingServiceKept = false
        var stopBeforeGeneration = -1
        mutex.withLock {
            if (generation != connectionGeneration ||
                (_connectionState.value !is ConnectionState.Connecting &&
                    _connectionState.value !is ConnectionState.Connected)
            ) return@withLock
            stopBeforeGeneration = advanceGeneration()
            permittedServiceStartGeneration.set(-1)
            stopUsageTracking()
            flushPendingUsage()
            saveSessionLog()
            _sessionTimeSeconds.value = 0L
            waitingServiceKept = ToBeVpnService.pauseActiveTunnelForNetworkResume(generation)
            _connectionState.value = ConnectionState.Error(
                context.getString(
                    if (waitingServiceKept) R.string.vpn_waiting_for_network_resume
                    else R.string.error_underlying_network_unavailable,
                ),
            )
            if (!waitingServiceKept) sendStopIntent(stopBeforeGeneration)
            handled = true
        }
        return waitingServiceKept.takeIf { handled }
    }

    private fun scheduleNetworkResume(
        server: Server,
        request: Int,
        waitingServiceGeneration: Int,
    ): Boolean {
        cancelPendingNetworkResume("REPLACED")
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val requestFilter = NetworkRequest.Builder()
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        lateinit var callback: ConnectivityManager.NetworkCallback
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                resumeAfterAvailableNetwork(
                    callback,
                    cm,
                    server,
                    request,
                    waitingServiceGeneration,
                )
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities,
            ) {
                resumeAfterAvailableNetwork(
                    callback,
                    cm,
                    server,
                    request,
                    waitingServiceGeneration,
                )
            }
        }
        val timeoutJob = scope.launch(start = CoroutineStart.LAZY) {
            delay(NETWORK_RESUME_WAIT_TIMEOUT_MS)
            expireNetworkResumeWait(
                callback,
                cm,
                request,
                waitingServiceGeneration,
            )
        }
        synchronized(networkResumeLock) {
            networkResumeCallback = callback
            networkResumeTimeoutJob = timeoutJob
        }
        return try {
            cm.registerNetworkCallback(requestFilter, callback)
            timeoutJob.start()
            SafeDiagnostics.info(
                TAG,
                "Foreground network wait armed: timeout_ms=$NETWORK_RESUME_WAIT_TIMEOUT_MS",
            )
            resumeAfterAvailableNetwork(
                callback,
                cm,
                server,
                request,
                waitingServiceGeneration,
            )
            true
        } catch (error: Exception) {
            SafeDiagnostics.warn(
                TAG,
                "Foreground network wait could not be armed: " +
                    SafeDiagnostics.failureCategory(error),
            )
            synchronized(networkResumeLock) {
                if (networkResumeCallback === callback) {
                    networkResumeCallback = null
                    networkResumeTimeoutJob = null
                }
            }
            timeoutJob.cancel()
            runCatching { cm.unregisterNetworkCallback(callback) }
            false
        }
    }

    private fun resumeAfterAvailableNetwork(
        callback: ConnectivityManager.NetworkCallback,
        cm: ConnectivityManager,
        server: Server,
        request: Int,
        waitingServiceGeneration: Int,
    ) {
        val availability = underlyingNetworkAvailability()
        if (!UnderlyingNetworkPolicy.canAttemptTunnelProbe(availability)) return
        val (accepted, timeoutJob) = synchronized(networkResumeLock) {
            if (networkResumeCallback !== callback) {
                false to null
            } else {
                networkResumeCallback = null
                true to networkResumeTimeoutJob.also { networkResumeTimeoutJob = null }
            }
        }
        if (!accepted) return
        timeoutJob?.cancel()
        runCatching { cm.unregisterNetworkCallback(callback) }
        scope.launch {
            val expectedError = context.getString(R.string.vpn_waiting_for_network_resume)
            val shouldResume = mutex.withLock {
                NetworkResumePolicy.shouldResume(
                    expectedRequest = request,
                    currentRequest = requestedOperation.get(),
                    hasNetworkTimeoutError =
                        _connectionState.value == ConnectionState.Error(expectedError),
                    sameServer = _currentServer.value?.hasSameVpnConfig(server) == true,
                    availability = availability,
                )
            }
            if (!shouldResume) {
                SafeDiagnostics.trace(TAG, "Network resume ignored as stale")
                ToBeVpnService.cleanupActiveInstance(waitingServiceGeneration)
                return@launch
            }
            if (!networkResumeRateLimiter.tryAcquire(SystemClock.elapsedRealtime())) {
                SafeDiagnostics.warn(TAG, "Network resume rate limit reached")
                finishNetworkResumeWait(request, waitingServiceGeneration)
                return@launch
            }
            startVpnInternal(
                server = server,
                resetWatchdogRecovery = true,
                request = request,
                preserveServerSelection = true,
            )
            SafeDiagnostics.info(
                TAG,
                "Physical network returned; VPN resume requested: " +
                    "availability=${availability.name}",
            )
            scope.launch {
                delay(NETWORK_RESUME_START_GUARD_MS)
                val rejected = mutex.withLock {
                    request == requestedOperation.get() &&
                        _connectionState.value !is ConnectionState.Connecting &&
                        _connectionState.value !is ConnectionState.Connected
                }
                if (rejected) {
                    ToBeVpnService.cleanupActiveInstance(waitingServiceGeneration)
                }
            }
        }
    }

    private suspend fun expireNetworkResumeWait(
        callback: ConnectivityManager.NetworkCallback,
        cm: ConnectivityManager,
        request: Int,
        waitingServiceGeneration: Int,
    ) {
        val expired = synchronized(networkResumeLock) {
            if (networkResumeCallback !== callback) {
                false
            } else {
                networkResumeCallback = null
                networkResumeTimeoutJob = null
                true
            }
        }
        if (!expired) return
        SafeDiagnostics.warn(TAG, "Foreground network wait expired")
        runCatching { cm.unregisterNetworkCallback(callback) }
        finishNetworkResumeWait(request, waitingServiceGeneration)
    }

    private suspend fun finishNetworkResumeWait(
        request: Int,
        waitingServiceGeneration: Int,
    ) {
        mutex.withLock {
            val waitingError = ConnectionState.Error(
                context.getString(R.string.vpn_waiting_for_network_resume),
            )
            if (request == requestedOperation.get() && _connectionState.value == waitingError) {
                _connectionState.value = ConnectionState.Error(
                    context.getString(R.string.error_underlying_network_unavailable),
                )
            }
        }
        ToBeVpnService.cleanupActiveInstance(waitingServiceGeneration)
    }

    private fun cancelPendingNetworkResume(reason: String) {
        val (callback, timeoutJob) = synchronized(networkResumeLock) {
            val currentCallback = networkResumeCallback
            val currentTimeout = networkResumeTimeoutJob
            networkResumeCallback = null
            networkResumeTimeoutJob = null
            currentCallback to currentTimeout
        }
        timeoutJob?.cancel()
        if (callback != null) {
            runCatching {
                context.getSystemService(ConnectivityManager::class.java)
                    ?.unregisterNetworkCallback(callback)
            }
        }
        if (callback != null || timeoutJob != null) {
            SafeDiagnostics.trace(TAG, "Pending network resume cancelled: reason=$reason")
        }
    }

    private fun scheduleTunnelRecovery(
        generation: Int,
        source: String,
        duringStartup: Boolean = false,
    ) {
        lateinit var job: Job
        synchronized(recoveryJobLock) {
            if (recoveryJob?.isActive == true) return
            job = scope.launch {
                try {
                    if (!tunnelMaintenanceMutex.tryLock()) return@launch
                    try {
                        recoverTunnelAfterHealthFailure(generation, source, duringStartup)
                    } finally {
                        tunnelMaintenanceMutex.unlock()
                    }
                } finally {
                    synchronized(recoveryJobLock) {
                        if (recoveryJob === job) recoveryJob = null
                    }
                }
            }
            recoveryJob = job
        }
    }

    private fun isExpectedTunnelState(generation: Int, duringStartup: Boolean): Boolean {
        if (generation != latestConnectionGeneration.get()) return false
        return if (duringStartup) {
            _connectionState.value is ConnectionState.Connecting
        } else {
            _connectionState.value is ConnectionState.Connected
        }
    }

    private fun cancelPendingRecovery(reason: String) {
        val job = synchronized(recoveryJobLock) {
            recoveryJob.also { recoveryJob = null }
        }
        job?.cancel()
        if (job != null) SafeDiagnostics.trace(TAG, "Recovery cancelled: reason=$reason")
    }

    fun showError(message: String) {
        scope.launch {
            mutex.withLock {
                if (_connectionState.value is ConnectionState.Connected ||
                    _connectionState.value is ConnectionState.Connecting
                ) {
                    return@withLock
                }
                _connectionState.value = ConnectionState.Error(message)
            }
        }
    }

    fun handleServiceDestroyed(generation: Int = -1) {
        SafeDiagnostics.warn(TAG, "VPN service destroyed: generation=$generation")
        cancelPendingRecovery("SERVICE_DESTROYED")
        scope.launch {
            var failedServer: Server? = null
            mutex.withLock {
                // A delayed destroy callback from an old service instance
                // must not tear down a newer connection attempt.
                if (generation != -1 && generation != connectionGeneration) return@launch
                val state = _connectionState.value
                val hasActiveSession = connectionStartTime > 0L ||
                    state is ConnectionState.Connected ||
                    state is ConnectionState.Connecting
                if (!hasActiveSession) return@withLock

                cancelPendingNetworkResume("SERVICE_DESTROYED")
                failedServer = _currentServer.value
                advanceGeneration()
                permittedServiceStartGeneration.set(-1)
                stopUsageTracking()
                flushPendingUsage()
                saveSessionLog()
                // Nobody asked to stop: the system destroyed the service. Say
                // so instead of a silent "Disconnected".
                _connectionState.value = stoppedBySystemError()
                rememberTunnelActive(false)
                _sessionTimeSeconds.value = 0L
            }
            failedServer?.let {
                serverQualityRepository.recordTunnelFailure(it)
                recentTunnelFailures.record(it, SystemClock.elapsedRealtime())
            }
        }
    }

    fun handleNetworkWaitServiceDestroyed() {
        cancelPendingNetworkResume("WAIT_SERVICE_DESTROYED")
        scope.launch {
            mutex.withLock {
                val waitingError = ConnectionState.Error(
                    context.getString(R.string.vpn_waiting_for_network_resume),
                )
                if (_connectionState.value == waitingError) {
                    _connectionState.value = ConnectionState.Error(
                        context.getString(R.string.error_underlying_network_unavailable),
                    )
                }
            }
        }
    }

    /**
     * Stops VPN with optional error message. Acquires mutex internally.
     */
    private suspend fun performStop(
        errorMessage: String? = null,
        request: Int? = null,
        expectedGeneration: Int? = null,
    ) {
        var stopBeforeGeneration = -1
        mutex.withLock {
            if (request != null && request != requestedOperation.get()) return
            if (expectedGeneration != null && expectedGeneration != connectionGeneration) return
            cancelPendingNetworkResume("STOP_SEQUENCE")
            val current = _connectionState.value
            if (current is ConnectionState.Disconnected) return

            stopBeforeGeneration = advanceGeneration()
            permittedServiceStartGeneration.set(-1)
            rememberTunnelActive(false)
            _connectionState.value = if (errorMessage != null) {
                ConnectionState.Error(errorMessage)
            } else {
                ConnectionState.Disconnected
            }
            stopUsageTracking()
            // Close the TUN and foreground notification before slower accounting
            // work, so the user-requested disconnect is visible immediately.
            sendStopIntent(stopBeforeGeneration)
            flushPendingUsage()
            saveSessionLog()
            // Drop the wall-clock session counter — without this the displayed
            // "Time" stays frozen at the value it had at the moment of stop,
            // because the subsequent updateState(Disconnected) is short-circuited
            // by the `prev is Disconnected` early return below.
            _sessionTimeSeconds.value = 0
            SafeDiagnostics.info(
                TAG,
                "VPN state changed: ${if (errorMessage == null) "DISCONNECTED" else "ERROR"}",
            )
        }
    }

    private fun sendStopIntent(stopBeforeGeneration: Int = Int.MAX_VALUE, force: Boolean = false) {
        val intent = Intent(context, ToBeVpnService::class.java).apply {
            action = ToBeVpnService.ACTION_STOP
            putExtra(ToBeVpnService.EXTRA_STOP_BEFORE_GENERATION, stopBeforeGeneration)
            putExtra(ToBeVpnService.EXTRA_FORCE_STOP, force)
        }
        startServiceSafely(intent)
    }

    private fun startServiceSafely(intent: Intent) {
        try {
            context.startService(intent)
        } catch (error: Exception) {
            SafeDiagnostics.warn(
                TAG,
                "VPN stop intent rejected: ${SafeDiagnostics.failureCategory(error)}",
            )
            // cleanupActiveInstance() still closes the live TUN even if the
            // operating system refuses this extra stop intent.
            ToBeVpnService.cleanupActiveInstance()
        }
    }

    private fun advanceGeneration(): Int {
        connectionGeneration += 1
        latestConnectionGeneration.set(connectionGeneration)
        return connectionGeneration
    }

    /** Must be called while [mutex] is held. */
    private fun resetRealityFingerprintAttempts(server: Server): String? {
        fingerprintAttemptServerKey = realityFingerprintAttemptKey(server)
        attemptedRealityFingerprints.clear()
        val primary = RealityFingerprintPolicy.primaryCandidate(server)
        primary?.let {
            attemptedRealityFingerprints += RealityFingerprintPolicy.normalize(it)
        }
        activeRealityFingerprint = primary
        return primary
    }

    /** Must be called while [mutex] is held. */
    private fun nextRealityFingerprint(server: Server): String? {
        if (fingerprintAttemptServerKey != realityFingerprintAttemptKey(server)) {
            fingerprintAttemptServerKey = realityFingerprintAttemptKey(server)
            activeRealityFingerprint = RealityFingerprintPolicy.primaryCandidate(server)
            activeRealityFingerprint?.let {
                attemptedRealityFingerprints += RealityFingerprintPolicy.normalize(it)
            }
        }
        return RealityFingerprintPolicy.nextCandidate(
            server = server,
            attempted = attemptedRealityFingerprints,
        )
    }

    /** Must be called while [mutex] is held after Xray accepted the config. */
    private fun commitRealityFingerprint(server: Server, fingerprint: String?) {
        fingerprintAttemptServerKey = realityFingerprintAttemptKey(server)
        if (fingerprint == null) {
            activeRealityFingerprint = null
            return
        }
        attemptedRealityFingerprints += RealityFingerprintPolicy.normalize(fingerprint)
        activeRealityFingerprint = fingerprint
    }

    private fun activeRealityFingerprintFor(server: Server): String? =
        activeRealityFingerprint.takeIf {
            fingerprintAttemptServerKey == realityFingerprintAttemptKey(server)
        }

    private fun activeServerDiagnosticDescriptor(server: Server): String =
        diagnosticServerDescriptor(server, activeRealityFingerprintFor(server))

    private fun realityFingerprintAttemptKey(server: Server): String = buildString {
        append(server.id).append(':')
        append(server.address).append(':').append(server.port).append(':')
        append(server.security).append(':').append(server.fingerprint).append(':')
        append(server.publicKey).append(':').append(server.shortId).append(':')
        append(server.network).append(':').append(server.path).append(':').append(server.host)
    }

    /**
     * The native loop is ready, but the public state remains Connecting until
     * a request through the tunnel proves end-to-end traffic.
     */
    fun handleTunnelCoreStarted(generation: Int) {
        SafeDiagnostics.trace(TAG, "XRay core ready: generation=$generation")
        scope.launch {
            val accepted = mutex.withLock {
                generation == connectionGeneration &&
                    _connectionState.value is ConnectionState.Connecting
            }
            if (accepted) startStartupTunnelValidation(generation, "STARTUP")
        }
    }

    /** Called by ToBeVpnService for terminal state changes. */
    fun updateState(state: ConnectionState, generation: Int = -1) {
        if (state is ConnectionState.Connected) {
            handleTunnelCoreStarted(generation)
            return
        }
        scope.launch {
            var failedServer: Server? = null
            mutex.withLock {
                // Reject stale updates from old connection attempts
                if (generation != -1 && generation != connectionGeneration) return@launch

                val prev = _connectionState.value

                when (state) {
                    is ConnectionState.Connected -> {
                        return@launch
                    }
                    is ConnectionState.Disconnected -> {
                        // Don't override Error (should persist until user acts) or Disconnected
                        if (prev is ConnectionState.Disconnected || prev is ConnectionState.Error) return@launch
                        advanceGeneration()
                        permittedServiceStartGeneration.set(-1)
                        _connectionState.value = state
                        stopUsageTracking()
                        flushPendingUsage()
                        saveSessionLog()
                        _sessionTimeSeconds.value = 0
                        SafeDiagnostics.info(TAG, "VPN state changed: DISCONNECTED source=SERVICE")
                    }
                    is ConnectionState.Error -> {
                        // Don't override intentional disconnect with stale errors
                        if (prev is ConnectionState.Disconnected) return@launch
                        if (prev is ConnectionState.Connecting) {
                            failedServer = _currentServer.value
                        }
                        advanceGeneration()
                        permittedServiceStartGeneration.set(-1)
                        _connectionState.value = state
                        stopUsageTracking()
                        flushPendingUsage()
                        saveSessionLog()
                        _sessionTimeSeconds.value = 0
                        SafeDiagnostics.warn(TAG, "VPN state changed: ERROR source=SERVICE")
                    }
                    is ConnectionState.Connecting -> {
                        // Only accept if we're not already ahead (Connected/Disconnected)
                        if (prev is ConnectionState.Disconnected || prev is ConnectionState.Connecting) {
                            _connectionState.value = state
                        }
                    }
                }
            }
            failedServer?.let { serverQualityRepository.recordConnectionFailure(it) }
        }
    }

    private fun startUsageTracking() {
        usageTrackingJob?.cancel()
        val gen = connectionGeneration
        val request = requestedOperation.get()
        usageTrackingJob = scope.launch {
            val paid = isPaidUser()
            // Heartbeat counter — fires registerCurrentDevice every HEARTBEAT_TICKS
            // seconds while VPN is connected. This is the only client-callable
            // endpoint that bumps `last_seen_at` server-side, so without it the
            // device's "Last active" in the device list freezes at the moment
            // the app was last foregrounded.
            var heartbeatCounter = 0
            while (gen == latestConnectionGeneration.get()) {
                delay(1000)
                if (_connectionState.value !is ConnectionState.Connected) break
                if (gen != latestConnectionGeneration.get()) break

                // Wall-clock-based session time is independent of counter resets.
                _sessionTimeSeconds.value = (System.currentTimeMillis() - connectionStartTime) / 1000

                // queryStats with reset=true — returns delta since last call.
                drainTrafficCounters(addTimeSeconds = 1)

                heartbeatCounter++
                if (heartbeatCounter >= HEARTBEAT_TICKS) {
                    heartbeatCounter = 0
                    if (runCatching { authRepository.pingHwidOnly() }.getOrDefault(false)) {
                        performStop(
                            errorMessage = context.getString(R.string.error_usage_blocked),
                            request = request,
                            expectedGeneration = gen,
                        )
                        break
                    }
                    if (sessionDao.getSession()?.telegramId != null) {
                        runCatching { authRepository.registerCurrentDevice() }
                    }
                }

                if (!paid) {
                    val updated = usageRepository.getUsage()
                    if (updated.isExhausted) {
                        performStop(
                            errorMessage = context.getString(R.string.vpn_error_limit_exhausted),
                            request = request,
                            expectedGeneration = gen,
                        )
                        break
                    }
                }
            }
        }
    }

    private suspend fun saveSessionLog() {
        val session = sessionDao.getSession()
        val keepDeviceScopedUsage = session?.authState != "AUTHENTICATED" ||
            session.userPlan == "FREE_TRIAL"
        val derivedSessionBytes = if (keepDeviceScopedUsage) {
            val currentUsage = usageRepository.getUsage()
            (currentUsage.bytesUsed - sessionStartUsageBytes).coerceAtLeast(0L)
        } else {
            0L
        }
        val sessionBytes = maxOf(sessionBytesAccumulated, derivedSessionBytes)
        val sessionTime = if (connectionStartTime > 0) {
            (System.currentTimeMillis() - connectionStartTime) / 1000
        } else 0L
        if (sessionBytes <= 0 && sessionTime <= 0) return
        val authenticated = session?.authState == "AUTHENTICATED"
        val timestampSeconds = if (connectionStartTime > 0L) {
            connectionStartTime / 1000
        } else {
            System.currentTimeMillis() / 1000
        }
        trafficLogDao.insert(
            TrafficLogEntity(
                bytesUsed = sessionBytes,
                timeUsedSeconds = sessionTime,
                serverId = _currentServer.value?.id ?: "",
                timestamp = timestampSeconds,
                isAuthenticated = authenticated,
            )
        )
        sessionBytesAccumulated = 0L
        sessionStartUsageBytes = 0L
        _sessionBytes.value = 0L
        connectionStartTime = 0L
        resetDiagnosticTrafficInterval()
    }

    private fun stopUsageTracking() {
        usageTrackingJob?.cancel()
        usageTrackingJob = null
        cancelTunnelHealthMonitoring()
    }

    private fun cancelTunnelHealthMonitoring() {
        val (job, call) = synchronized(healthJobLock) {
            val existingJob = healthCheckJob
            val existingCall = activeTunnelProbeCall.getAndSet(null)
            healthCheckJob = null
            existingJob to existingCall
        }
        job?.cancel()
        call?.cancel()
    }

    private fun replaceTunnelHealthJob(job: Job) {
        val previousJob: Job?
        val previousCall: Call?
        synchronized(healthJobLock) {
            previousJob = healthCheckJob
            previousCall = activeTunnelProbeCall.getAndSet(null)
            healthCheckJob = job
        }
        previousJob?.cancel()
        previousCall?.cancel()
        job.invokeOnCompletion {
            synchronized(healthJobLock) {
                if (healthCheckJob === job) healthCheckJob = null
            }
        }
        job.start()
    }

    private fun startStartupTunnelValidation(generation: Int, source: String) {
        SafeDiagnostics.trace(
            TAG,
            "Startup tunnel validation scheduled: generation=$generation source=$source",
        )
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var networkUnavailableStartedAtMs: Long? = null
            delay(TUNNEL_STARTUP_VALIDATION_DELAY_MS)
            while (isExpectedTunnelState(generation, duringStartup = true)) {
                val availability = underlyingNetworkAvailability()
                val networkLossTimeoutMs =
                    UnderlyingNetworkPolicy.teardownTimeoutMs(availability)
                if (networkLossTimeoutMs != null) {
                    val now = SystemClock.elapsedRealtime()
                    val unavailableSince = networkUnavailableStartedAtMs ?: now.also {
                        networkUnavailableStartedAtMs = it
                    }
                    val deadline = NetworkAvailabilityDeadline(
                        startedAtMs = unavailableSince,
                        timeoutMs = networkLossTimeoutMs,
                    )
                    if (deadline.isExpired(now)) {
                        handleUnderlyingNetworkUnavailable(generation)
                        return@launch
                    }
                    delay(deadline.nextCheckDelayMs(now, TUNNEL_HEALTH_NO_NETWORK_RETRY_MS))
                    continue
                }
                networkUnavailableStartedAtMs = null
                if (availability == UnderlyingNetworkAvailability.UNVALIDATED) {
                    SafeDiagnostics.trace(
                        TAG,
                        "Startup tunnel validation probing through unvalidated physical network",
                    )
                }
                val probe = withTimeoutOrNull(TUNNEL_STARTUP_VALIDATION_TIMEOUT_MS) {
                    probeTunnelWithRetries(
                        attempts = TUNNEL_STARTUP_VALIDATION_ATTEMPTS,
                        targets = TUNNEL_STARTUP_PROBE_TARGETS,
                    )
                } ?: TunnelProbeResult(healthy = false, terminalFailure = false)
                if (probe.healthy) {
                    SafeDiagnostics.info(
                        TAG,
                        "Startup tunnel validation succeeded: generation=$generation source=$source",
                    )
                    completeStartupTunnelValidation(generation, source)
                } else {
                    SafeDiagnostics.warn(
                        TAG,
                        "Startup tunnel validation failed: generation=$generation source=$source " +
                            "terminal_failure=${probe.terminalFailure}",
                    )
                    _currentServer.value?.let {
                        serverQualityRepository.recordTunnelFailure(it)
                        recentTunnelFailures.record(it, SystemClock.elapsedRealtime())
                    }
                    scheduleTunnelRecovery(generation, source, duringStartup = true)
                }
                return@launch
            }
        }
        replaceTunnelHealthJob(job)
    }

    private suspend fun completeStartupTunnelValidation(generation: Int, source: String) {
        if (!ToBeVpnService.markActiveTunnelValidated(generation)) {
            performStop(
                errorMessage = context.getString(R.string.error_generic),
                request = requestedOperation.get(),
                expectedGeneration = generation,
            )
            return
        }
        val accepted = mutex.withLock {
            if (!isExpectedTunnelState(generation, duringStartup = true)) return@withLock false
            _connectionState.value = ConnectionState.Connected
            rememberTunnelActive(true)
            connectionStartTime = System.currentTimeMillis()
            sessionBytesAccumulated = 0L
            _sessionBytes.value = 0L
            qualityDownlinkBytesAccumulated = 0L
            trafficQualityConfirmed = false
            resetDiagnosticTrafficInterval()
            lastTunnelDownlinkElapsedMs = 0L
            downlinkEvidenceAccumulator.reset()
            _sessionTimeSeconds.value = 0L
            // Startup probe bytes do not belong to the user session.
            XRayCore.queryOutboundTrafficStats("proxy")
            probeDownlinkEvidenceGate.reset()
            usageRepository.setLastConnected(connectionStartTime)
            sessionStartUsageBytes = usageRepository.getUsage().bytesUsed
            startUsageTracking()
            true
        }
        if (!accepted) return
        SafeDiagnostics.info(
            TAG,
            "VPN state changed: CONNECTED generation=$generation source=$source",
        )
        confirmTunnelHealthy(generation)
        startTunnelHealthCheck(initialDelayMs = TUNNEL_HEALTH_INTERVAL_MS)
    }

    private fun startTunnelHealthCheck(initialDelayMs: Long = TUNNEL_HEALTH_INITIAL_DELAY_MS) {
        val gen = latestConnectionGeneration.get()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            delay(initialDelayMs)
            var networkUnavailableStartedAtMs: Long? = null
            // A reload, handover or reconnect creates a new watchdog job and
            // therefore a fresh two-cycle health episode.
            val episode = TunnelHealthEpisode()
            while (isExpectedTunnelState(gen, duringStartup = false)) {
                val availability = underlyingNetworkAvailability()
                val networkLossTimeoutMs =
                    UnderlyingNetworkPolicy.teardownTimeoutMs(availability)
                if (networkLossTimeoutMs != null) {
                    val now = SystemClock.elapsedRealtime()
                    val unavailableSince = networkUnavailableStartedAtMs ?: now.also {
                        networkUnavailableStartedAtMs = it
                    }
                    val deadline = NetworkAvailabilityDeadline(
                        startedAtMs = unavailableSince,
                        timeoutMs = networkLossTimeoutMs,
                    )
                    if (deadline.isExpired(now)) {
                        handleUnderlyingNetworkUnavailable(gen)
                        return@launch
                    }
                    delay(deadline.nextCheckDelayMs(now, TUNNEL_HEALTH_NO_NETWORK_RETRY_MS))
                    continue
                }
                networkUnavailableStartedAtMs = null
                if (availability == UnderlyingNetworkAvailability.UNVALIDATED) {
                    SafeDiagnostics.trace(
                        TAG,
                        "Tunnel watchdog probing through unvalidated physical network",
                    )
                }
                val loopGeneration = XRayCore.currentLoopGeneration
                val probeStartedAt = SystemClock.elapsedRealtime()
                val downlinkBeforeProbe = downlinkEvidenceAccumulator.consume()
                val probe = probeTunnelWithRetries(TUNNEL_HEALTH_ATTEMPTS)
                val decision = episode.onProbeResult(
                    probeHealthy = probe.healthy,
                    probeStartedAtMs = probeStartedAt,
                    probeLoopGeneration = loopGeneration,
                    evidence = downlinkBeforeProbe,
                )
                val decisionName = when (decision) {
                    is TunnelHealthDecision.Healthy -> "HEALTHY"
                    is TunnelHealthDecision.LivenessOverride -> "LIVENESS_OVERRIDE"
                    is TunnelHealthDecision.AwaitingConfirmation -> "AWAITING_CONFIRMATION"
                    is TunnelHealthDecision.ConfirmedFailure -> "CONFIRMED_FAILURE"
                }
                SafeDiagnostics.trace(
                    TAG,
                    "Periodic tunnel validation: generation=$gen probe_healthy=${probe.healthy} " +
                        "decision=$decisionName " +
                        "probe_duration_ms=${SystemClock.elapsedRealtime() - probeStartedAt}",
                )
                when (decision) {
                    is TunnelHealthDecision.Healthy,
                    is TunnelHealthDecision.LivenessOverride -> confirmTunnelHealthy(gen)

                    is TunnelHealthDecision.AwaitingConfirmation -> {
                        SafeDiagnostics.warn(
                            TAG,
                            "Periodic tunnel validation awaiting confirmation: " +
                                "generation=$gen failures=${decision.failures} " +
                                "required=${decision.required} " +
                                "pre_probe_downlink_bytes=${decision.downlinkBytes} " +
                                "pre_probe_downlink_age_ms=${decision.downlinkAgeMs}",
                        )
                    }

                    is TunnelHealthDecision.ConfirmedFailure -> {
                        SafeDiagnostics.warn(
                            TAG,
                            "Periodic tunnel validation confirmed failure: " +
                                "generation=$gen failures=${decision.failures} " +
                                "terminal_failure=${probe.terminalFailure} " +
                                "pre_probe_downlink_bytes=${decision.downlinkBytes} " +
                                "pre_probe_downlink_age_ms=${decision.downlinkAgeMs}",
                        )
                        _currentServer.value?.let {
                            serverQualityRepository.recordTunnelFailure(it)
                            recentTunnelFailures.record(it, SystemClock.elapsedRealtime())
                        }
                        scheduleTunnelRecovery(gen, source = "PERIODIC")
                        return@launch
                    }
                }
                delay(TUNNEL_HEALTH_INTERVAL_MS)
            }
        }
        replaceTunnelHealthJob(job)
    }

    private suspend fun confirmTunnelHealthy(generation: Int) {
        val confirmation = mutex.withLock {
            if (!isExpectedTunnelState(generation, duringStartup = false)) return@withLock null
            watchdogRecoveryAttempts = 0
            watchdogRecoveryExcludedServers.clear()
            val server = _currentServer.value ?: return@withLock null
            recentTunnelFailures.forget(server)
            val successKey = "$generation:${server.id}"
            val firstSuccess = confirmedConnectionSuccessKey != successKey
            if (firstSuccess) confirmedConnectionSuccessKey = successKey
            server to firstSuccess
        } ?: return
        val (server, firstSuccess) = confirmation
        serverQualityRepository.recordTunnelHealthy(server)
        if (firstSuccess) serverQualityRepository.recordConnectionSuccess(server)
    }

    private suspend fun recoverTunnelAfterHealthFailure(
        gen: Int,
        source: String,
        duringStartup: Boolean,
    ) {
        cancelTunnelHealthMonitoring()
        val automaticSelection = prefsDataStore.isAutomaticServerSelection()
        var failedServer: Server? = null
        var recoveryRequest = -1
        var excludedServers = emptyList<Server>()
        var fingerprintRetry: String? = null
        val allowed = mutex.withLock {
            if (!isExpectedTunnelState(gen, duringStartup)) return@withLock false
            val current = _currentServer.value ?: return@withLock false
            failedServer = current
            fingerprintRetry = if (duringStartup) {
                nextRealityFingerprint(current)
            } else {
                null
            }
            val consumesRecoveryBudget = fingerprintRetry == null ||
                TunnelRecoveryPolicy.fingerprintRetryConsumesAttempt(automaticSelection)
            if (consumesRecoveryBudget) {
                if (!TunnelRecoveryPolicy.canAttempt(
                        currentAttempts = watchdogRecoveryAttempts,
                        automaticSelection = automaticSelection,
                        duringStartup = duringStartup,
                    )
                ) return@withLock false
                watchdogRecoveryAttempts++
            }
            // A different ClientHello is still the same server attempt. Only
            // exclude it after the bounded browser variants are exhausted.
            if (fingerprintRetry == null) {
                watchdogRecoveryExcludedServers[current.id] = current
            }
            excludedServers = watchdogRecoveryExcludedServers.values.toList()
            recoveryRequest = requestedOperation.get()
            true
        }
        if (!allowed) {
            SafeDiagnostics.warn(
                TAG,
                "VPN recovery refused: generation=$gen source=$source automatic=$automaticSelection " +
                    "during_startup=$duringStartup attempts=$watchdogRecoveryAttempts",
            )
            performStop(
                errorMessage = context.getString(R.string.error_tunnel_unhealthy),
                request = requestedOperation.get(),
                expectedGeneration = gen,
            )
            return
        }

        val staleServer = failedServer ?: return
        SafeDiagnostics.warn(
            TAG,
            "VPN recovery started: generation=$gen source=$source automatic=$automaticSelection " +
                "during_startup=$duringStartup attempts=$watchdogRecoveryAttempts " +
                "fingerprint_retry=${fingerprintRetry != null} failed=" +
                activeServerDiagnosticDescriptor(staleServer),
        )
        val target = if (fingerprintRetry != null) {
            staleServer
        } else {
            refreshServerAfterAccessCheck(
                server = staleServer,
                excludedAutoServers = if (automaticSelection) excludedServers else emptyList(),
                allowStaleOnRefreshMiss = !automaticSelection,
            ) ?: run {
                SafeDiagnostics.warn(TAG, "VPN recovery has no eligible target")
                performStop(
                    errorMessage = context.getString(R.string.error_tunnel_unhealthy),
                    request = recoveryRequest,
                    expectedGeneration = gen,
                )
                return
            }
        }
        val fingerprintForReload = fingerprintRetry
            ?: RealityFingerprintPolicy.primaryCandidate(target)
        if (recoveryRequest != requestedOperation.get() ||
            !isExpectedTunnelState(gen, duringStartup) ||
            prefsDataStore.isAutomaticServerSelection() != automaticSelection
        ) {
            return
        }
        val reloaded = runCatching {
            ToBeVpnService.reloadActiveCore(
                expectedGeneration = gen,
                configJson = VpnConfig.buildConfigJson(
                    server = target,
                    realityFingerprintOverride = fingerprintForReload,
                ),
                reason = "HEALTH_RECOVERY_$source",
                showConnectedNotification = !duringStartup,
            )
        }.getOrDefault(false)
        if (!reloaded) {
            SafeDiagnostics.warn(TAG, "VPN recovery XRay reload failed: source=$source")
            performStop(
                errorMessage = context.getString(R.string.error_tunnel_unhealthy),
                request = recoveryRequest,
                expectedGeneration = gen,
            )
            return
        }
        val accepted = mutex.withLock {
            if (recoveryRequest == requestedOperation.get() &&
                isExpectedTunnelState(gen, duringStartup)
            ) {
                _currentServer.value = target
                commitRealityFingerprint(target, fingerprintForReload)
                true
            } else {
                false
            }
        }
        if (!accepted) return
        SafeDiagnostics.info(
            TAG,
            "VPN recovery XRay reload succeeded: source=$source target=" +
                activeServerDiagnosticDescriptor(target),
        )
        persistAutomaticSelectionIfNeeded(target)
        if (duringStartup) {
            startStartupTunnelValidation(gen, "RECOVERY")
        } else {
            startTunnelHealthCheck(initialDelayMs = TUNNEL_HEALTH_AFTER_RELOAD_DELAY_MS)
        }
    }

    private suspend fun probeTunnelWithRetries(
        attempts: Int,
        retryDelayMs: Long = TUNNEL_HEALTH_RETRY_MS,
        targets: List<TunnelProbeTarget> = TUNNEL_PROBE_TARGETS,
    ): TunnelProbeResult = tunnelProbeMutex.withLock {
        probeDownlinkEvidenceGate.onProbeStarted()
        downlinkEvidenceAccumulator.reset()
        var terminalFailure = false
        try {
            repeat(attempts) { index ->
                val result = probeTunnelOnce(targets)
                if (result.healthy) return@withLock result
                terminalFailure = result.terminalFailure
                if (terminalFailure) return@withLock result
                if (index < attempts - 1) delay(retryDelayMs)
            }
            TunnelProbeResult(healthy = false, terminalFailure = terminalFailure)
        } finally {
            probeDownlinkEvidenceGate.onProbeFinished()
        }
    }

    private suspend fun probeTunnelOnce(targets: List<TunnelProbeTarget>): TunnelProbeResult {
        var everyTargetFailedWithTls = true
        for (target in targets) {
            val attempt = probeTunnelUrl(target)
            if (attempt.healthy) return attempt
            if (!attempt.terminalFailure) everyTargetFailedWithTls = false
        }
        return TunnelProbeResult(
            healthy = false,
            terminalFailure = everyTargetFailedWithTls,
        )
    }

    private suspend fun probeTunnelUrl(target: TunnelProbeTarget): TunnelProbeResult {
        val request = Request.Builder().url(target.url).get().build()
        return suspendCancellableCoroutine { continuation ->
            val call = tunnelProbeClient.newCall(request)
            if (!activeTunnelProbeCall.compareAndSet(null, call)) {
                continuation.resume(TunnelProbeResult(false, false))
                return@suspendCancellableCoroutine
            }
            continuation.invokeOnCancellation {
                activeTunnelProbeCall.compareAndSet(call, null)
                call.cancel()
            }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    activeTunnelProbeCall.compareAndSet(call, null)
                    if (continuation.isActive) {
                        continuation.resume(
                            TunnelProbeResult(
                                healthy = false,
                                terminalFailure = SafeDiagnostics.failureCategory(e) == "TLS",
                            ),
                        )
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    activeTunnelProbeCall.compareAndSet(call, null)
                    val healthy = response.use { it.code in 200..399 }
                    if (continuation.isActive) {
                        continuation.resume(TunnelProbeResult(healthy, false))
                    }
                }
            })
        }
    }

    @Suppress("DEPRECATION")
    private fun underlyingNetworkAvailability(): UnderlyingNetworkAvailability {
        val cm = context.getSystemService(ConnectivityManager::class.java)
            ?: return UnderlyingNetworkAvailability.VALIDATED
        var hasPhysicalInternet = false
        cm.allNetworks.forEach { network ->
            val capabilities = cm.getNetworkCapabilities(network) ?: return@forEach
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            ) return@forEach
            hasPhysicalInternet = true
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                return UnderlyingNetworkAvailability.VALIDATED
            }
        }
        return if (hasPhysicalInternet) {
            UnderlyingNetworkAvailability.UNVALIDATED
        } else {
            UnderlyingNetworkAvailability.UNAVAILABLE
        }
    }

    private suspend fun flushPendingUsage() {
        drainTrafficCounters(addTimeSeconds = 0)
    }

    private suspend fun drainTrafficCounters(addTimeSeconds: Long) {
        withContext(NonCancellable) {
            statsMutex.withLock {
                val loopGenerationBeforeQuery = XRayCore.currentLoopGeneration
                val trafficStats = XRayCore.queryOutboundTrafficStats("proxy")
                val upBytes = trafficStats.uplinkBytes
                val downBytes = trafficStats.downlinkBytes
                val loopGenerationAfterQuery = XRayCore.currentLoopGeneration
                val stableLoopGeneration =
                    if (loopGenerationBeforeQuery == loopGenerationAfterQuery) {
                        loopGenerationAfterQuery
                    } else {
                        -1
                    }
                val delta = upBytes + downBytes
                if (delta <= 0L && addTimeSeconds <= 0L) return@withLock

                sessionBytesAccumulated += delta
                _sessionBytes.value = sessionBytesAccumulated
                diagnosticIntervalUplinkBytes += upBytes
                diagnosticIntervalDownlinkBytes += downBytes
                val suppressDownlinkEvidence = probeDownlinkEvidenceGate
                    .suppressEvidenceForCurrentDrain()
                if (downBytes > 0L && !suppressDownlinkEvidence && stableLoopGeneration > 0) {
                    val now = SystemClock.elapsedRealtime()
                    lastTunnelDownlinkElapsedMs = now
                    downlinkEvidenceAccumulator.record(
                        observedAtMs = now,
                        loopGeneration = stableLoopGeneration,
                        bytes = downBytes,
                    )
                    qualityDownlinkBytesAccumulated = saturatingTrafficAdd(
                        qualityDownlinkBytesAccumulated,
                        downBytes,
                    )
                }
                if (!trafficQualityConfirmed &&
                    qualityDownlinkBytesAccumulated >= QUALITY_DOWNLINK_CONFIRM_BYTES
                ) {
                    trafficQualityConfirmed = true
                    _currentServer.value?.let { server ->
                        scope.launch {
                            serverQualityRepository.recordTraffic(server, qualityDownlinkBytesAccumulated)
                        }
                    }
                }

                val session = sessionDao.getSession()
                val keepDeviceScopedUsage = session?.authState != "AUTHENTICATED" ||
                    session.userPlan == "FREE_TRIAL"
                if (keepDeviceScopedUsage) {
                    val usage = usageRepository.getUsage()
                    usageRepository.updateUsage(
                        usage.bytesUsed + delta,
                        usage.timeUsedSeconds + addTimeSeconds,
                    )
                }
                logDiagnosticTrafficIntervalIfDue()
            }
        }
    }

    private fun resetDiagnosticTrafficInterval() {
        diagnosticIntervalStartedAtMs = SystemClock.elapsedRealtime()
        diagnosticIntervalUplinkBytes = 0L
        diagnosticIntervalDownlinkBytes = 0L
    }

    private fun saturatingTrafficAdd(current: Long, value: Long): Long =
        if (current > Long.MAX_VALUE - value) Long.MAX_VALUE else current + value

    private fun logDiagnosticTrafficIntervalIfDue() {
        val now = SystemClock.elapsedRealtime()
        if (diagnosticIntervalStartedAtMs <= 0L) {
            diagnosticIntervalStartedAtMs = now
            return
        }
        val intervalMs = now - diagnosticIntervalStartedAtMs
        if (intervalMs < DIAGNOSTIC_TRAFFIC_INTERVAL_MS) return
        val uplinkKbps = diagnosticIntervalUplinkBytes * 8L / intervalMs.coerceAtLeast(1L)
        val downlinkKbps = diagnosticIntervalDownlinkBytes * 8L / intervalMs.coerceAtLeast(1L)
        SafeDiagnostics.trace(
            TAG,
            "VPN traffic interval: traffic_kib=" +
                ((diagnosticIntervalUplinkBytes + diagnosticIntervalDownlinkBytes) / 1024L) +
                " uplink_kib=${diagnosticIntervalUplinkBytes / 1024L} " +
                "downlink_kib=${diagnosticIntervalDownlinkBytes / 1024L} " +
                "interval_ms=$intervalMs interval_up_kbps=$uplinkKbps " +
                "interval_down_kbps=$downlinkKbps",
        )
        diagnosticIntervalStartedAtMs = now
        diagnosticIntervalUplinkBytes = 0L
        diagnosticIntervalDownlinkBytes = 0L
    }

    companion object {
        private const val TAG = "VpnConnectionManager"
        private const val HEARTBEAT_TICKS = 60
        private const val TUNNEL_HEALTH_INITIAL_DELAY_MS = 2_500L
        private const val TUNNEL_HEALTH_INTERVAL_MS = 30_000L
        private const val TUNNEL_HEALTH_NO_NETWORK_RETRY_MS = 5_000L
        private const val TUNNEL_HEALTH_RETRY_MS = 3_000L
        private const val TUNNEL_HEALTH_ATTEMPTS = 3
        private const val TUNNEL_HEALTH_AFTER_RELOAD_DELAY_MS = 2_500L
        private const val TUNNEL_STARTUP_VALIDATION_DELAY_MS = 500L
        private const val TUNNEL_STARTUP_VALIDATION_TIMEOUT_MS = 11_500L
        private const val TUNNEL_STARTUP_VALIDATION_ATTEMPTS = 1
        private const val QUALITY_DOWNLINK_CONFIRM_BYTES = 64L * 1024L
        private const val DIAGNOSTIC_TRAFFIC_INTERVAL_MS = 30_000L
        private const val NETWORK_RESUME_START_GUARD_MS = 10_000L
        private const val NETWORK_RESUME_WAIT_TIMEOUT_MS = 15L * 60L * 1_000L
        private const val NETWORK_RESUME_MAX_ATTEMPTS = 5
        private const val NETWORK_RESUME_RATE_LIMIT_WINDOW_MS = 60L * 60L * 1_000L
        private val TUNNEL_STARTUP_PROBE_TARGETS = listOf(
            TunnelProbeTarget("https://www.gstatic.com/generate_204"),
            TunnelProbeTarget("https://www.example.com/"),
        )
        private val TUNNEL_PROBE_TARGETS = TUNNEL_STARTUP_PROBE_TARGETS +
            TunnelProbeTarget("https://repo1.maven.org/maven2/")
    }

    private data class TunnelProbeResult(
        val healthy: Boolean,
        val terminalFailure: Boolean,
    )

    private data class TunnelProbeTarget(val url: String)
}
