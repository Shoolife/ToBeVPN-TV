package com.tobevpn.tv.data.repository

import com.tobevpn.tv.data.remote.dto.GithubAssetDto
import com.tobevpn.tv.data.remote.dto.GithubReleaseDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateRepositoryTest {

    @Test
    fun tvSuffixDoesNotAffectVersionComparison() {
        assertEquals(
            parseSemver("1.0.24")!!.toList(),
            parseSemver("1.0.24-tv")!!.toList(),
        )
        assertEquals(
            -1,
            compareSemver(parseSemver("1.0.24-tv")!!, parseSemver("v1.0.25-tv")!!),
        )
    }

    @Test
    fun selectNewestUpdateChoosesHighestSemverNotFirstRelease() {
        val update = selectNewestUpdate(
            releases = listOf(
                release("v1.0.45"),
                release("v1.0.47"),
                release("v1.0.46"),
            ),
            current = parseSemver("1.0.44")!!,
            supportedAbis = listOf("arm64-v8a", "armeabi-v7a"),
        )

        assertEquals("v1.0.47", update?.release?.tagName)
        assertEquals("ToBeVPN-TV-1.0.47-arm64-v8a-test.apk", update?.apk?.name)
    }

    @Test
    fun selectNewestUpdateSkipsDraftPrereleaseAndReleaseWithoutApk() {
        val update = selectNewestUpdate(
            releases = listOf(
                release("v1.0.50", draft = true),
                release("v1.0.49", prerelease = true),
                release("v1.0.48", assets = listOf(asset("ToBeVPN-TV-1.0.48-test.aab"))),
                release("v1.0.47"),
            ),
            current = parseSemver("1.0.46")!!,
            supportedAbis = listOf("arm64-v8a"),
        )

        assertEquals("v1.0.47", update?.release?.tagName)
    }

    @Test
    fun selectNewestUpdateReturnsNullWhenOnlyCurrentOrOlderVersionsExist() {
        val update = selectNewestUpdate(
            releases = listOf(
                release("v1.0.47"),
                release("v1.0.46"),
            ),
            current = parseSemver("1.0.47")!!,
            supportedAbis = listOf("arm64-v8a"),
        )

        assertNull(update)
    }

    @Test
    fun pickApkAssetUsesAbiPreferenceBeforeUniversalFallback() {
        val release = release(
            tagName = "v1.0.47",
            assets = listOf(
                asset("ToBeVPN-TV-1.0.47-universal-test.apk"),
                asset("ToBeVPN-TV-1.0.47-armeabi-v7a-test.apk"),
                asset("ToBeVPN-TV-1.0.47-arm64-v8a-test.apk"),
            ),
        )

        val apk = pickApkAsset(
            release = release,
            supportedAbis = listOf("arm64-v8a", "armeabi-v7a"),
        )

        assertEquals("ToBeVPN-TV-1.0.47-arm64-v8a-test.apk", apk?.name)
    }

    @Test
    fun pickApkAssetHandlesMissingAssetsKey() {
        assertNull(
            pickApkAsset(
                release = release(tagName = "v1.0.48", assets = null),
                supportedAbis = listOf("arm64-v8a"),
            )
        )
    }

    private fun release(
        tagName: String,
        draft: Boolean = false,
        prerelease: Boolean = false,
        assets: List<GithubAssetDto>? = listOf(asset("ToBeVPN-TV-${tagName.removePrefix("v")}-arm64-v8a-test.apk")),
    ): GithubReleaseDto = GithubReleaseDto(
        tagName = tagName,
        name = tagName,
        body = "",
        htmlUrl = "https://github.com/Shoolife/ToBeVPN-TV/releases/tag/$tagName",
        draft = draft,
        prerelease = prerelease,
        assets = assets,
    )

    private fun asset(name: String): GithubAssetDto = GithubAssetDto(
        name = name,
        downloadUrl = "https://github.com/Shoolife/ToBeVPN-TV/releases/download/test/$name",
        size = 1L,
        contentType = "application/vnd.android.package-archive",
    )
}
