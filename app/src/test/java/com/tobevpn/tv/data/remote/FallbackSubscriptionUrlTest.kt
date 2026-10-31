package com.tobevpn.tv.data.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class FallbackSubscriptionUrlTest {

    @Test
    fun replacesKeyPlaceholderInPath() {
        assertEquals(
            "https://cdn.example/api/sub/AbC123",
            buildSubscriptionUrlByKey("https://cdn.example/api/sub/{key}", "AbC123").toString(),
        )
    }

    @Test
    fun fillsEmptySubQueryOfTheOldFunctionUrl() {
        assertEquals(
            "https://functions.example/fn?sub=AbC123",
            buildSubscriptionUrlByKey("https://functions.example/fn?sub=", "AbC123").toString(),
        )
    }

    @Test
    fun appendsKeyAsPathSegmentWithoutQuery() {
        assertEquals(
            "https://sub.example/api/AbC123",
            buildSubscriptionUrlByKey("https://sub.example/api/", "AbC123").toString(),
        )
    }
}
