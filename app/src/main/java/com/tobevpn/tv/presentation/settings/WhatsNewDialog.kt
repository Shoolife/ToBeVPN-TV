package com.tobevpn.tv.presentation.settings

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Route
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tobevpn.tv.BuildConfig
import com.tobevpn.tv.R
import com.tobevpn.tv.presentation.components.VerticalScrollCues
import com.tobevpn.tv.presentation.components.rememberVerticalScrollCueState
import com.tobevpn.tv.presentation.components.verticalFadingEdges
import com.tobevpn.tv.presentation.theme.VpnGreen
import kotlinx.coroutines.launch

private data class WhatsNewHighlight(
    val icon: ImageVector,
    val titleRes: Int,
    val descriptionRes: Int,
)

private val currentHighlights = listOf(
    WhatsNewHighlight(
        icon = Icons.Filled.Bolt,
        titleRes = R.string.whats_new_quick_ping_v1036_title,
        descriptionRes = R.string.whats_new_quick_ping_v1036_desc,
    ),
    WhatsNewHighlight(
        icon = Icons.Filled.Route,
        titleRes = R.string.whats_new_final_mask_v1036_title,
        descriptionRes = R.string.whats_new_final_mask_v1036_desc,
    ),
    WhatsNewHighlight(
        icon = Icons.Filled.CloudOff,
        titleRes = R.string.whats_new_fallback_subscription_v1036_title,
        descriptionRes = R.string.whats_new_fallback_subscription_v1036_desc,
    ),
    WhatsNewHighlight(
        icon = Icons.Filled.Memory,
        titleRes = R.string.whats_new_xray_core_v1036_title,
        descriptionRes = R.string.whats_new_xray_core_v1036_desc,
    ),
)

/**
 * TV adaptation of the phone client's "What's new" dialog. The composition
 * stays the same (hero badge, version pill, highlight cards, close control and
 * full-width action), while the wider layout keeps every item visible on TV.
 */
@Composable
fun WhatsNewDialog(
    darkTheme: Boolean,
    onDismiss: () -> Unit,
) {
    val doneFocusRequester = remember { FocusRequester() }
    val closeFocusRequester = remember { FocusRequester() }
    val highlightsFocusRequester = remember { FocusRequester() }
    val highlightsScrollState = rememberScrollState()
    val scrollScope = rememberCoroutineScope()
    var doneFocused by remember { mutableStateOf(false) }
    var closeFocused by remember { mutableStateOf(false) }
    var visible by remember { mutableStateOf(false) }

    // The TV can keep a light app theme while Android itself stays dark. Use
    // the selected app theme explicitly so a newly opened dialog never flashes
    // or remains in the system palette.
    val dialogBackground = if (darkTheme) Color(0xFF202020) else Color.White
    val itemBackground = if (darkTheme) Color(0xFF292929) else Color(0xFFEDEEF0)
    val outlineColor = if (darkTheme) Color(0xFF494949) else Color(0xFFD2D4D8)
    val primaryText = if (darkTheme) Color(0xFFF2F2F2) else Color(0xFF1A1C1E)
    val secondaryText = if (darkTheme) Color(0xFFB8B8B8) else Color(0xFF5C5E6A)

    LaunchedEffect(Unit) {
        visible = true
        withFrameNanos { }
        runCatching { doneFocusRequester.requestFocus() }
    }
    val progress by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = 220),
        label = "whatsNewIn",
    )
    val cues = rememberVerticalScrollCueState(
        state = highlightsScrollState,
        fadeLength = 34.dp,
    )

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.55f)),
            contentAlignment = Alignment.Center,
        ) {
            Card(
                modifier = Modifier
                    .fillMaxWidth(0.70f)
                    .heightIn(max = 680.dp)
                    .fillMaxHeight(0.92f)
                    .widthIn(max = 720.dp)
                    .scale(0.97f + 0.03f * progress),
                shape = RoundedCornerShape(22.dp),
                colors = CardDefaults.cardColors(containerColor = dialogBackground),
                elevation = CardDefaults.cardElevation(defaultElevation = 12.dp),
                border = BorderStroke(1.dp, outlineColor),
            ) {
                Box {
                    Column(
                        modifier = Modifier.padding(
                            start = 26.dp,
                            end = 26.dp,
                            top = 24.dp,
                            bottom = 22.dp,
                        ),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(56.dp)
                                .shadow(
                                    elevation = 12.dp,
                                    shape = RoundedCornerShape(18.dp),
                                    spotColor = VpnGreen,
                                    ambientColor = VpnGreen,
                                )
                                .clip(RoundedCornerShape(18.dp))
                                .background(
                                    Brush.linearGradient(
                                        listOf(
                                            VpnGreen,
                                            lerp(VpnGreen, Color.White, 0.24f),
                                        ),
                                    ),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.AutoAwesome,
                                contentDescription = null,
                                tint = Color.Black,
                                modifier = Modifier.size(29.dp),
                            )
                        }

                        Spacer(modifier = Modifier.height(9.dp))
                        Text(
                            text = stringResource(R.string.whats_new_title),
                            fontSize = 26.sp,
                            lineHeight = 30.sp,
                            fontWeight = FontWeight.Bold,
                            color = primaryText,
                            textAlign = TextAlign.Center,
                        )

                        Spacer(modifier = Modifier.height(6.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(999.dp))
                                .background(itemBackground)
                                .padding(horizontal = 11.dp, vertical = 5.dp),
                        ) {
                            Text(
                                text = stringResource(
                                    R.string.whats_new_version,
                                    BuildConfig.VERSION_NAME,
                                ),
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = secondaryText,
                            )
                        }

                        Spacer(modifier = Modifier.height(11.dp))
                        Text(
                            text = stringResource(R.string.whats_new_intro),
                            fontSize = 15.sp,
                            lineHeight = 19.sp,
                            color = secondaryText,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Spacer(modifier = Modifier.height(10.dp))
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .verticalFadingEdges(
                                        topAlpha = cues.topAlpha,
                                        bottomAlpha = cues.bottomAlpha,
                                        fadeHeight = 34.dp,
                                    )
                                    .verticalScroll(highlightsScrollState)
                                    .focusRequester(highlightsFocusRequester)
                                    .focusProperties {
                                        up = closeFocusRequester
                                        down = doneFocusRequester
                                    }
                                    .focusable()
                                    .onPreviewKeyEvent { event ->
                                        if (event.type != KeyEventType.KeyDown) {
                                            return@onPreviewKeyEvent false
                                        }
                                        when (event.key) {
                                            Key.DirectionDown -> {
                                                if (highlightsScrollState.value < highlightsScrollState.maxValue) {
                                                    scrollScope.launch {
                                                        highlightsScrollState.animateScrollTo(
                                                            (highlightsScrollState.value + 120)
                                                                .coerceAtMost(highlightsScrollState.maxValue),
                                                        )
                                                    }
                                                    true
                                                } else {
                                                    doneFocusRequester.requestFocus()
                                                    true
                                                }
                                            }
                                            Key.DirectionUp -> {
                                                if (highlightsScrollState.value > 0) {
                                                    scrollScope.launch {
                                                        highlightsScrollState.animateScrollTo(
                                                            (highlightsScrollState.value - 120).coerceAtLeast(0),
                                                        )
                                                    }
                                                    true
                                                } else {
                                                    closeFocusRequester.requestFocus()
                                                    true
                                                }
                                            }
                                            else -> false
                                        }
                                    },
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Spacer(modifier = Modifier.height(3.dp))
                                currentHighlights.forEach { highlight ->
                                    WhatsNewHighlightCard(
                                        highlight = highlight,
                                        containerColor = itemBackground,
                                        outlineColor = outlineColor,
                                        primaryText = primaryText,
                                        secondaryText = secondaryText,
                                    )
                                }
                                Spacer(modifier = Modifier.height(8.dp))
                            }
                            VerticalScrollCues(state = cues)
                        }

                        Spacer(modifier = Modifier.height(14.dp))
                        val buttonShape = RoundedCornerShape(12.dp)
                        Button(
                            onClick = onDismiss,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(46.dp)
                                .focusRequester(doneFocusRequester)
                                .focusProperties { up = highlightsFocusRequester }
                                .onPreviewKeyEvent { event ->
                                    if (
                                        event.type == KeyEventType.KeyDown &&
                                        event.key == Key.DirectionUp
                                    ) {
                                        highlightsFocusRequester.requestFocus()
                                        true
                                    } else {
                                        false
                                    }
                                }
                                .onFocusChanged { doneFocused = it.isFocused },
                            shape = buttonShape,
                            border = if (doneFocused) {
                                BorderStroke(2.dp, primaryText)
                            } else {
                                null
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = VpnGreen,
                                contentColor = Color.Black,
                            ),
                        ) {
                            Text(
                                text = stringResource(R.string.whats_new_done),
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }

                    val closeShape = RoundedCornerShape(10.dp)
                    Surface(
                        onClick = onDismiss,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(10.dp)
                            .size(38.dp)
                            .focusRequester(closeFocusRequester)
                            .focusProperties { down = highlightsFocusRequester }
                            .onPreviewKeyEvent { event ->
                                if (
                                    event.type == KeyEventType.KeyDown &&
                                    event.key == Key.DirectionDown
                                ) {
                                    highlightsFocusRequester.requestFocus()
                                    true
                                } else {
                                    false
                                }
                            }
                            .onFocusChanged { closeFocused = it.isFocused },
                        shape = closeShape,
                        color = if (closeFocused) itemBackground else Color.Transparent,
                        contentColor = secondaryText,
                        border = if (closeFocused) {
                            BorderStroke(2.dp, primaryText)
                        } else {
                            null
                        },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                imageVector = Icons.Filled.Close,
                                contentDescription = stringResource(R.string.whats_new_done),
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WhatsNewHighlightCard(
    highlight: WhatsNewHighlight,
    containerColor: Color,
    outlineColor: Color,
    primaryText: Color,
    secondaryText: Color,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        border = BorderStroke(1.dp, outlineColor),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 13.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(VpnGreen.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = highlight.icon,
                    contentDescription = null,
                    tint = VpnGreen,
                    modifier = Modifier.size(21.dp),
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(highlight.titleRes),
                    fontSize = 15.sp,
                    lineHeight = 19.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = primaryText,
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = stringResource(highlight.descriptionRes),
                    fontSize = 13.sp,
                    lineHeight = 17.sp,
                    color = secondaryText,
                )
            }
        }
    }
}
