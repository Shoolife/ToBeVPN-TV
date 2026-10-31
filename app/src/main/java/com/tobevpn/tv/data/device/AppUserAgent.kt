package com.tobevpn.tv.data.device

import com.tobevpn.tv.BuildConfig

/**
 * User-Agent of every request to our servers: "ToBeVPN/<version>/androidtv/<versionCode>".
 * Google Play builds add "-play" to the version ("1.0.36-tv-play") so the
 * panel can tell them from GitHub installs. Only the header changes:
 * update and minimum-version checks keep using BuildConfig.VERSION_NAME.
 */
object AppUserAgent {
    val versionLabel: String =
        BuildConfig.VERSION_NAME + if (BuildConfig.PLAY_DISTRIBUTION) PLAY_SUFFIX else ""

    val value: String = "ToBeVPN/$versionLabel/androidtv/${BuildConfig.VERSION_CODE}"

    private const val PLAY_SUFFIX = "-play"
}
