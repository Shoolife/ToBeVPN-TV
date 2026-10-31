package com.tobevpn.tv.data.device

import com.tobevpn.tv.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUserAgentTest {

    @Test
    fun `user agent keeps the androidtv shape the panel and Devices screen parse`() {
        assertEquals(
            "ToBeVPN/${AppUserAgent.versionLabel}/androidtv/${BuildConfig.VERSION_CODE}",
            AppUserAgent.value,
        )
        assertTrue(AppUserAgent.value.contains("/androidtv/"))
    }

    @Test
    fun `only Play builds mark the version`() {
        val expected = if (BuildConfig.PLAY_DISTRIBUTION) {
            "${BuildConfig.VERSION_NAME}-play"
        } else {
            BuildConfig.VERSION_NAME
        }
        assertEquals(expected, AppUserAgent.versionLabel)
    }
}
