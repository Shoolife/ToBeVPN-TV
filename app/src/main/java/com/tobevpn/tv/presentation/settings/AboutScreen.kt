package com.tobevpn.tv.presentation.settings

import com.tobevpn.tv.billing.regionLocale
import java.util.Locale
import androidx.compose.ui.platform.LocalConfiguration
import com.tobevpn.tv.billing.PlayBillingStatus
import android.content.Intent
import android.net.Uri
import android.text.format.Formatter
import android.view.KeyEvent as AndroidKeyEvent
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PrivacyTip
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tobevpn.tv.BuildConfig
import com.tobevpn.tv.R
import com.tobevpn.tv.presentation.components.TvHeaderIconButton
import com.tobevpn.tv.presentation.components.VerticalScrollCues
import com.tobevpn.tv.presentation.components.rememberVerticalScrollCueState
import com.tobevpn.tv.presentation.components.verticalFadingEdges
import com.tobevpn.tv.presentation.rememberTvScreenScale
import com.tobevpn.tv.presentation.theme.VpnGreen
import com.tobevpn.tv.presentation.theme.VpnRed
import com.tobevpn.tv.update.SettingsUpdateCheckRow
import com.tobevpn.tv.util.DiagnosticLogFileInfo
import com.tobevpn.tv.util.DiagnosticLogState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@Composable
fun AboutScreen(
    onBack: () -> Unit,
    onLongBack: () -> Unit = onBack,
    viewModel: AboutViewModel = hiltViewModel(),
) {
    val diagnosticState by viewModel.diagnosticState.collectAsStateWithLifecycle()
    val playBillingStatus by viewModel.playBillingStatus.collectAsStateWithLifecycle()
    val historyState by viewModel.history.collectAsStateWithLifecycle()
    val xrayVersion by viewModel.xrayVersion.collectAsStateWithLifecycle()
    val context = androidx.compose.ui.platform.LocalContext.current
    var showWhatsNew by remember { mutableStateOf(false) }
    var showDiagnosticInfo by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    var deleteCandidate by remember { mutableStateOf<DiagnosticLogFileInfo?>(null) }
    var diagnosticModeToast by remember { mutableStateOf<Toast?>(null) }
    val darkTheme = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val backFocus = remember { FocusRequester() }
    val logoFocus = remember { FocusRequester() }

    val shareSubject = stringResource(R.string.diagnostics_share_subject)
    val shareTitle = stringResource(R.string.diagnostics_share_title)
    val exportSaved = stringResource(R.string.diagnostics_export_saved)
    LaunchedEffect(viewModel, shareSubject, shareTitle, exportSaved) {
        viewModel.events.collect { event ->
            when (event) {
                is DiagnosticUiEvent.ModeChanged -> {
                    diagnosticModeToast?.cancel()
                    diagnosticModeToast = Toast.makeText(
                        context,
                        if (event.enabled) {
                            R.string.diagnostics_mode_enabled
                        } else {
                            R.string.diagnostics_mode_disabled
                        },
                        Toast.LENGTH_SHORT,
                    ).also(Toast::show)
                }
                is DiagnosticUiEvent.ShareLog -> {
                    event.intent.putExtra(Intent.EXTRA_SUBJECT, shareSubject)
                    runCatching {
                        context.startActivity(Intent.createChooser(event.intent, shareTitle))
                    }.onFailure {
                        viewModel.saveLogToDownloads(event.fileName)
                    }
                }
                is DiagnosticUiEvent.LogExported -> Toast.makeText(
                    context,
                    "$exportSaved ${event.location}",
                    Toast.LENGTH_LONG,
                ).show()
                DiagnosticUiEvent.NoLogToExport -> Toast.makeText(
                    context,
                    R.string.diagnostics_no_log_to_export,
                    Toast.LENGTH_SHORT,
                ).show()
                DiagnosticUiEvent.OperationFailed -> Toast.makeText(
                    context,
                    R.string.diagnostics_operation_failed,
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    LaunchedEffect(Unit) {
        withFrameNanos { }
        runCatching { backFocus.requestFocus() }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val uiScale = rememberTvScreenScale(maxWidth, maxHeight)
        val screenPad = (40 * uiScale).dp
        val gap = (20 * uiScale).dp
        val cardPad = (22 * uiScale).dp
        val titleSize = (26 * uiScale).sp
        val sectionSize = (20 * uiScale).sp
        val bodySize = (15 * uiScale).sp
        val headerColor = MaterialTheme.colorScheme.onBackground

        Column(Modifier.fillMaxSize().padding(screenPad)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TvHeaderIconButton(
                    onClick = onBack,
                    onLongClick = onLongBack,
                    modifier = Modifier
                        .size((44 * uiScale).dp)
                        .focusRequester(backFocus)
                        .focusProperties { down = logoFocus },
                    shape = RoundedCornerShape((8 * uiScale).dp),
                    borderWidth = (2 * uiScale).dp,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = stringResource(R.string.back),
                        modifier = Modifier.size((21 * uiScale).dp),
                        tint = headerColor,
                    )
                }
                Spacer(Modifier.width(gap))
                Text(
                    stringResource(R.string.about),
                    fontSize = titleSize,
                    fontWeight = FontWeight.Bold,
                    color = headerColor,
                )
            }
            Spacer(Modifier.height(gap))

            Row(
                modifier = Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                Column(
                    modifier = Modifier.weight(0.9f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(gap),
                ) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape((18 * uiScale).dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer,
                        ),
                    ) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(cardPad),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            DiagnosticUnlockLogo(
                                onLongClick = viewModel::toggleDiagnosticMode,
                                focusRequester = logoFocus,
                                size = (78 * uiScale).dp,
                            )
                            Spacer(Modifier.height((9 * uiScale).dp))
                            Text(
                                stringResource(R.string.app_name),
                                fontSize = sectionSize,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                stringResource(R.string.about_slogan),
                                fontSize = bodySize,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }

                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape((18 * uiScale).dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer,
                        ),
                    ) {
                        Column(Modifier.padding(cardPad)) {
                            SettingsUpdateCheckRow(
                                fontSize = bodySize,
                                onWhatsNew = { showWhatsNew = true },
                            )
                            Spacer(Modifier.height((10 * uiScale).dp))
                            AboutSpecRow(
                                label = stringResource(R.string.xray),
                                value = xrayVersion ?: "…",
                                fontSize = bodySize,
                            )
                        }
                    }

                    AnimatedVisibility(
                        visible = diagnosticState.debugModeEnabled,
                        enter = expandVertically(animationSpec = tween(320)) + fadeIn(tween(220)),
                        exit = shrinkVertically(animationSpec = tween(260)) + fadeOut(tween(160)),
                    ) {
                        PlayBillingDiagnosticsCard(
                            status = playBillingStatus,
                            bodySize = bodySize,
                            cardPadding = cardPad,
                            rowGap = (6 * uiScale).dp,
                            cornerRadius = (18 * uiScale).dp,
                        )
                    }
                }

                Column(
                    modifier = Modifier.weight(1.1f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(gap),
                ) {
                    AboutLinksCard(
                        fontSize = bodySize,
                        cardPadding = cardPad,
                        onOpen = { url ->
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, Uri.parse(url)),
                                )
                            }.onFailure {
                                Toast.makeText(
                                    context,
                                    R.string.about_open_link_failed,
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                    )

                    AnimatedVisibility(
                        visible = diagnosticState.debugModeEnabled,
                        enter = expandVertically(animationSpec = tween(320)) + fadeIn(tween(220)),
                        exit = shrinkVertically(animationSpec = tween(260)) + fadeOut(tween(160)),
                    ) {
                        DiagnosticCard(
                            state = diagnosticState,
                            bodySize = bodySize,
                            cardPadding = cardPad,
                            onToggleCollection = viewModel::toggleCollection,
                            onHistory = {
                                showHistory = true
                                viewModel.loadHistory()
                            },
                            onInfo = { showDiagnosticInfo = true },
                        )
                    }
                }
            }
        }
    }

    if (showWhatsNew) {
        WhatsNewDialog(darkTheme = darkTheme, onDismiss = { showWhatsNew = false })
    }
    if (showDiagnosticInfo) {
        DiagnosticInfoDialog(
            darkTheme = darkTheme,
            onDismiss = { showDiagnosticInfo = false },
        )
    }
    if (showHistory) {
        DiagnosticHistoryDialog(
            state = historyState,
            darkTheme = darkTheme,
            onDismiss = { showHistory = false },
            onShare = viewModel::shareLog,
            onDelete = { deleteCandidate = it },
        )
    }
    deleteCandidate?.let { log ->
        TvConfirmationDialog(
            title = stringResource(R.string.diagnostics_history_delete_title),
            message = stringResource(
                R.string.diagnostics_history_delete_message,
                log.date.format(DATE_FORMAT),
            ),
            confirmLabel = stringResource(R.string.diagnostics_history_delete_confirm),
            cancelLabel = stringResource(R.string.cancel),
            darkTheme = darkTheme,
            destructive = true,
            onConfirm = {
                deleteCandidate = null
                viewModel.deleteLog(log.fileName)
            },
            onDismissRequest = { deleteCandidate = null },
        )
    }
}

@Composable
internal fun DiagnosticUnlockLogo(
    onLongClick: () -> Unit,
    focusRequester: FocusRequester,
    size: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    var pressed by remember { mutableStateOf(false) }
    var triggered by remember { mutableStateOf(false) }
    var holdJob by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    DisposableEffect(Unit) { onDispose { holdJob?.cancel() } }

    Surface(
        modifier = modifier
            .size(size)
            .focusRequester(focusRequester)
            .onFocusChanged {
                focused = it.isFocused
                if (!it.isFocused) {
                    pressed = false
                    triggered = false
                    holdJob?.cancel()
                    holdJob = null
                }
            }
            .onPreviewKeyEvent { event ->
                val nativeEvent = event.nativeKeyEvent
                val activation = when (nativeEvent.keyCode) {
                    AndroidKeyEvent.KEYCODE_DPAD_CENTER,
                    AndroidKeyEvent.KEYCODE_ENTER,
                    AndroidKeyEvent.KEYCODE_NUMPAD_ENTER,
                    AndroidKeyEvent.KEYCODE_BUTTON_A,
                    -> true
                    else -> false
                }
                if (!activation) return@onPreviewKeyEvent false
                when (event.type) {
                    KeyEventType.KeyDown -> {
                        if (!pressed) {
                            pressed = true
                            triggered = false
                            holdJob?.cancel()
                            holdJob = scope.launch {
                                delay(DIAGNOSTIC_HOLD_MS)
                                if (pressed && !triggered) {
                                    triggered = true
                                    onLongClick()
                                }
                            }
                        }
                        if (
                            !triggered &&
                            (nativeEvent.repeatCount > 0 || nativeEvent.isLongPress)
                        ) {
                            triggered = true
                            holdJob?.cancel()
                            holdJob = null
                            onLongClick()
                        }
                        true
                    }
                    KeyEventType.KeyUp -> {
                        pressed = false
                        holdJob?.cancel()
                        holdJob = null
                        true
                    }
                    else -> false
                }
            }
            .pointerInput(onLongClick) {
                detectTapGestures(
                    onPress = {
                        val releasedBeforeTimeout = withTimeoutOrNull(
                            DIAGNOSTIC_HOLD_MS,
                        ) {
                            tryAwaitRelease()
                        } != null
                        if (!releasedBeforeTimeout) {
                            onLongClick()
                        }
                    },
                )
            }
            .focusable(),
        shape = CircleShape,
        color = Color.Transparent,
        border = if (focused) BorderStroke(3.dp, MaterialTheme.colorScheme.onSurface) else null,
    ) {
        Image(
            painter = painterResource(R.drawable.onboarding_logo),
            contentDescription = stringResource(R.string.diagnostics_unlock_hint),
            modifier = Modifier.fillMaxSize().padding(5.dp),
        )
    }
}

@Composable
private fun AboutLinksCard(
    fontSize: androidx.compose.ui.unit.TextUnit,
    cardPadding: androidx.compose.ui.unit.Dp,
    onOpen: (String) -> Unit,
) {
    val rows = listOf(
        Triple(Icons.Default.Campaign, R.string.about_news_title, R.string.about_news_link),
        Triple(Icons.Default.PrivacyTip, R.string.about_privacy_title, R.string.about_privacy_link),
        Triple(Icons.Default.PersonRemove, R.string.about_delete_title, R.string.about_delete_link),
    )
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(Modifier.padding(cardPadding)) {
            rows.forEachIndexed { index, row ->
                val url = stringResource(row.third)
                TvOutlinedAction(
                    label = stringResource(row.second),
                    icon = row.first,
                    fontSize = fontSize,
                    onClick = { onOpen(url) },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (index != rows.lastIndex) Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
internal fun DiagnosticCard(
    state: DiagnosticLogState,
    bodySize: androidx.compose.ui.unit.TextUnit,
    cardPadding: androidx.compose.ui.unit.Dp,
    onToggleCollection: () -> Unit,
    onHistory: () -> Unit,
    onInfo: () -> Unit,
    modifier: Modifier = Modifier,
    infoButtonModifier: Modifier = Modifier,
    startButtonModifier: Modifier = Modifier,
    historyButtonModifier: Modifier = Modifier,
    compact: Boolean = false,
    compactLogSpacing: Boolean = false,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val summary = if (state.hasCurrentLog && state.currentLogDate != null) {
        stringResource(
            R.string.diagnostics_log_summary,
            state.currentLogDate.format(DATE_FORMAT),
            Formatter.formatShortFileSize(context, state.currentLogSizeBytes),
        )
    } else {
        stringResource(R.string.diagnostics_log_empty)
    }
    val useCompactLogSpacing = compact || compactLogSpacing
    val sectionGap = if (useCompactLogSpacing) 5.dp else 10.dp
    val summaryVerticalPadding = if (useCompactLogSpacing) 3.dp else 9.dp
    val summaryTopGap = if (compactLogSpacing) 2.dp else sectionGap
    val summaryTopPadding = if (compactLogSpacing) 0.dp else summaryVerticalPadding
    val infoButtonSize = if (compact) 40.dp else 44.dp
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(Modifier.padding(cardPadding)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.diagnostics_title),
                        fontSize = (bodySize.value + 2f).sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        stringResource(
                            if (state.collecting) {
                                R.string.diagnostics_status_collecting
                            } else {
                                R.string.diagnostics_status_stopped
                            },
                        ),
                        fontSize = bodySize,
                        color = if (state.collecting) VpnGreen else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TvOutlinedAction(
                    label = null,
                    icon = Icons.Default.Info,
                    fontSize = bodySize,
                    onClick = onInfo,
                    modifier = Modifier.size(infoButtonSize).then(infoButtonModifier),
                )
            }
            Spacer(Modifier.height(summaryTopGap))
            Text(
                summary,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        top = summaryTopPadding,
                        bottom = summaryVerticalPadding,
                    ),
                fontSize = bodySize,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(sectionGap))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TvOutlinedAction(
                    label = stringResource(
                        if (state.collecting) R.string.diagnostics_stop else R.string.diagnostics_start,
                    ),
                    icon = if (state.collecting) Icons.Default.Stop else Icons.Default.PlayArrow,
                    fontSize = bodySize,
                    onClick = onToggleCollection,
                    modifier = Modifier.weight(1f).then(startButtonModifier),
                    accent = if (state.collecting) VpnRed else VpnGreen,
                )
                TvOutlinedAction(
                    label = stringResource(R.string.diagnostics_history_button),
                    icon = Icons.Default.History,
                    fontSize = bodySize,
                    onClick = onHistory,
                    modifier = Modifier.weight(1f).then(historyButtonModifier),
                )
            }
        }
    }
}

@Composable
private fun TvOutlinedAction(
    label: String?,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    fontSize: androidx.compose.ui.unit.TextUnit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Color = MaterialTheme.colorScheme.onSurface,
) {
    var focused by remember { mutableStateOf(false) }
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.onFocusChanged { focused = it.isFocused },
        shape = RoundedCornerShape(10.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = accent),
        border = BorderStroke(
            if (focused) 2.dp else 1.dp,
            if (focused) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline,
        ),
    ) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(20.dp))
        if (label != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                label,
                fontSize = fontSize,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun AboutSpecRow(
    label: String,
    value: String,
    fontSize: androidx.compose.ui.unit.TextUnit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), fontSize = fontSize)
        Text(
            value,
            fontSize = fontSize,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Hidden-diagnostics view of the Google Play country check, so a support
 * case can compare what Google Play reports with the account on the TV.
 */
@Composable
private fun PlayBillingDiagnosticsCard(
    status: PlayBillingStatus,
    bodySize: androidx.compose.ui.unit.TextUnit,
    cardPadding: androidx.compose.ui.unit.Dp,
    rowGap: androidx.compose.ui.unit.Dp,
    cornerRadius: androidx.compose.ui.unit.Dp,
) {
    val locale = LocalConfiguration.current.locales[0]
    val notAvailable = stringResource(R.string.play_diag_value_none)
    val countryText = status.country
        ?.takeIf { it.isNotBlank() }
        ?.let { code ->
            val name = regionLocale(code)?.getDisplayCountry(locale).orEmpty()
            if (name.isBlank() || name.equals(code, ignoreCase = true)) code else "$code · $name"
        }
        ?: notAvailable
    val checkedText = status.checkedAtMillis
        ?.let {
            java.text.DateFormat.getDateTimeInstance(
                java.text.DateFormat.SHORT,
                java.text.DateFormat.SHORT,
                locale,
            ).format(java.util.Date(it))
        }
        ?: notAvailable
    val rows = listOf(
        stringResource(R.string.play_diag_build) to stringResource(
            if (status.distribution) R.string.play_diag_build_play else R.string.play_diag_build_direct,
        ),
        stringResource(R.string.play_diag_country) to countryText,
        stringResource(R.string.play_diag_payment) to stringResource(
            if (status.externalPurchasesAllowed) R.string.play_diag_payment_allowed else R.string.play_diag_payment_blocked,
        ),
        stringResource(R.string.play_diag_checked) to checkedText,
        stringResource(R.string.play_diag_result) to (status.lastResult ?: notAvailable),
        stringResource(R.string.play_diag_installer) to (status.installer ?: notAvailable),
    )
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(cornerRadius),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(cardPadding),
            verticalArrangement = Arrangement.spacedBy(rowGap),
        ) {
            Text(
                stringResource(R.string.play_diag_title),
                fontSize = bodySize,
                fontWeight = FontWeight.Bold,
            )
            rows.forEach { (label, value) ->
                AboutSpecRow(label = label, value = value, fontSize = bodySize)
            }
            Text(
                stringResource(R.string.play_diag_account_hint),
                fontSize = bodySize * 0.85f,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun DiagnosticInfoDialog(
    darkTheme: Boolean,
    onDismiss: () -> Unit,
) {
    val scrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    val scrollFocus = remember { FocusRequester() }
    val doneFocus = remember { FocusRequester() }
    var doneFocused by remember { mutableStateOf(false) }
    val cues = rememberVerticalScrollCueState(
        state = scrollState,
        fadeLength = 38.dp,
    )
    val dialogBackground = if (darkTheme) Color(0xFF202020) else Color.White
    val outline = if (darkTheme) Color(0xFF494949) else Color(0xFFD2D4D8)

    LaunchedEffect(Unit) {
        withFrameNanos { }
        runCatching { scrollFocus.requestFocus() }
    }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.62f)),
            contentAlignment = Alignment.Center,
        ) {
            Card(
                modifier = Modifier.fillMaxWidth(0.58f).widthIn(max = 680.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = dialogBackground,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = BorderStroke(1.dp, outline),
            ) {
                Column(
                    Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        Icons.Default.BugReport,
                        null,
                        tint = VpnGreen,
                        modifier = Modifier.size(34.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        stringResource(R.string.diagnostics_info_title),
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(12.dp))
                    Box(Modifier.fillMaxWidth().heightIn(max = 300.dp)) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalFadingEdges(
                                    topAlpha = cues.topAlpha,
                                    bottomAlpha = cues.bottomAlpha,
                                    fadeHeight = 38.dp,
                                )
                                .verticalScroll(scrollState)
                                .focusRequester(scrollFocus)
                                .focusProperties { down = doneFocus }
                                .focusable()
                                .onPreviewKeyEvent { event ->
                                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                    when (event.key) {
                                        Key.DirectionDown -> {
                                            if (scrollState.value < scrollState.maxValue) {
                                                scope.launch { scrollState.animateScrollTo((scrollState.value + 100).coerceAtMost(scrollState.maxValue)) }
                                                true
                                            } else false
                                        }
                                        Key.DirectionUp -> {
                                            if (scrollState.value > 0) {
                                                scope.launch { scrollState.animateScrollTo((scrollState.value - 100).coerceAtLeast(0)) }
                                                true
                                            } else false
                                        }
                                        else -> false
                                    }
                                },
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            val paragraphs = listOf(
                                R.string.diagnostics_info_manual,
                                R.string.diagnostics_info_persistence,
                                R.string.diagnostics_info_contents,
                                R.string.diagnostics_info_daily,
                                R.string.diagnostics_info_privacy,
                                R.string.diagnostics_info_share,
                            )
                            paragraphs.forEachIndexed { index, res ->
                                Text(
                                    stringResource(res),
                                    fontSize = 15.sp,
                                    lineHeight = 21.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                if (index != paragraphs.lastIndex) Spacer(Modifier.height(10.dp))
                            }
                        }
                        VerticalScrollCues(state = cues)
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = onDismiss,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(44.dp)
                            .focusRequester(doneFocus)
                            .focusProperties { up = scrollFocus }
                            .onFocusChanged { doneFocused = it.isFocused },
                        shape = RoundedCornerShape(10.dp),
                        border = if (doneFocused) {
                            BorderStroke(2.dp, MaterialTheme.colorScheme.onSurface)
                        } else null,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = VpnGreen,
                            contentColor = Color.Black,
                        ),
                    ) {
                        Text(stringResource(R.string.diagnostics_info_done), fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
internal fun DiagnosticHistoryDialog(
    state: DiagnosticHistoryUiState,
    darkTheme: Boolean,
    onDismiss: () -> Unit,
    onShare: (String) -> Unit,
    onDelete: (DiagnosticLogFileInfo) -> Unit,
) {
    val dialogBackground = MaterialTheme.colorScheme.background
    val outline = if (darkTheme) Color(0xFF494949) else Color(0xFFD2D4D8)
    val closeFocus = remember { FocusRequester() }
    val listState = rememberLazyListState()
    val listCues = rememberVerticalScrollCueState(
        state = listState,
        fadeLength = 38.dp,
    )
    LaunchedEffect(Unit) {
        withFrameNanos { }
        runCatching { closeFocus.requestFocus() }
    }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.62f)),
            contentAlignment = Alignment.Center,
        ) {
            Card(
                modifier = Modifier.fillMaxWidth(0.72f).heightIn(max = 580.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = dialogBackground,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = BorderStroke(1.dp, outline),
            ) {
                Column(Modifier.padding(24.dp)) {
                    Text(
                        stringResource(R.string.diagnostics_history_title),
                        fontSize = 23.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        stringResource(R.string.diagnostics_history_description),
                        fontSize = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(15.dp))
                    when {
                        state.isLoading && state.logs.isEmpty() -> Box(
                            Modifier.fillMaxWidth().height(180.dp),
                            contentAlignment = Alignment.Center,
                        ) { CircularProgressIndicator() }
                        state.logs.isEmpty() -> Box(
                            Modifier.fillMaxWidth().height(150.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                stringResource(R.string.diagnostics_history_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        else -> Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 360.dp),
                        ) {
                            LazyColumn(
                                state = listState,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .verticalFadingEdges(
                                        topAlpha = listCues.topAlpha,
                                        bottomAlpha = listCues.bottomAlpha,
                                        fadeHeight = 38.dp,
                                    ),
                                verticalArrangement = Arrangement.spacedBy(9.dp),
                            ) {
                                items(state.logs, key = DiagnosticLogFileInfo::fileName) { log ->
                                    DiagnosticHistoryRow(
                                        log = log,
                                        deleting = state.deletingFileName == log.fileName,
                                        onShare = { onShare(log.fileName) },
                                        onDelete = { onDelete(log) },
                                    )
                                }
                            }
                            VerticalScrollCues(state = listCues)
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    TvOutlinedAction(
                        label = stringResource(R.string.close),
                        icon = Icons.AutoMirrored.Filled.ArrowBack,
                        fontSize = 15.sp,
                        onClick = onDismiss,
                        modifier = Modifier.fillMaxWidth().focusRequester(closeFocus),
                    )
                }
            }
        }
    }
}

@Composable
private fun DiagnosticHistoryRow(
    log: DiagnosticLogFileInfo,
    deleting: Boolean,
    onShare: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val date = log.date.format(DATE_FORMAT)
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(13.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Description, null, tint = VpnGreen)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (log.date == LocalDate.now()) {
                        stringResource(R.string.diagnostics_history_today)
                    } else date,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    stringResource(
                        R.string.diagnostics_history_date_and_size,
                        date,
                        Formatter.formatShortFileSize(context, log.sizeBytes),
                    ),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (deleting) {
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            } else {
                TvOutlinedAction(
                    label = null,
                    icon = Icons.Default.Share,
                    fontSize = 14.sp,
                    onClick = onShare,
                    modifier = Modifier.size(42.dp),
                )
                Spacer(Modifier.width(8.dp))
                TvOutlinedAction(
                    label = null,
                    icon = Icons.Default.DeleteOutline,
                    fontSize = 14.sp,
                    onClick = onDelete,
                    modifier = Modifier.size(42.dp),
                    accent = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

private val DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy")
private const val DIAGNOSTIC_HOLD_MS = 1_000L
