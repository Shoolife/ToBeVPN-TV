import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) load(file.inputStream())
}

val releaseBuildRequested = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true)
}

fun requireConfiguredReleaseFallback(name: String, value: String) {
    val normalized = value.trim()
    val looksLikePlaceholder = normalized.isBlank() ||
        normalized.contains("<") ||
        normalized.contains("your-", ignoreCase = true) ||
        normalized.contains("example.", ignoreCase = true) ||
        normalized.contains(".invalid", ignoreCase = true)
    if (releaseBuildRequested && looksLikePlaceholder) {
        throw GradleException(
            "$name must be configured with an operator endpoint for release builds. " +
                "Do not build a production APK with a blank or placeholder network endpoint."
        )
    }
}

android {
    namespace = "com.tobevpn.tv"
    compileSdk {
        version = release(37) {
            minorApiLevel = 0
        }
    }

    defaultConfig {
        // namespace stays "com.tobevpn.tv" — that's the package for R / BuildConfig.
        // applicationId matches the mobile app on purpose: Play Console publishes
        // both APKs under one listing, but different form factors get unique
        // versionCode ranges. Mobile lives in 1..999, TV in 1000..1999, etc.
        applicationId = "com.tobevpn.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 1036
        versionName = "1.0.36-tv"

        // Direct APK releases retain the GitHub updater. The Google Play
        // variant overrides both flags and delegates updates to Play.
        buildConfigField("boolean", "IN_APP_UPDATES_ENABLED", "true")
        buildConfigField("boolean", "PLAY_DISTRIBUTION", "false")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Backend URL is **never** hardcoded into the public source tree —
        // production instances must not be discoverable via GitHub search.
        // Resolution order:
        //   1. local.properties: `bot.api.url=https://...` (developers)
        //   2. env var BOT_API_URL (CI / GitHub Actions secret)
        //   3. Hard fail at configure time so a broken build never silently
        //      compiles against `https://example.invalid/` and gets shipped.
        val botApiUrl = localProperties.getProperty("bot.api.url")
            ?: System.getenv("BOT_API_URL")
            ?: throw GradleException(
                "BOT_API_URL is not configured. Set it via local.properties (`bot.api.url=...`) " +
                "or the BOT_API_URL environment variable / Actions secret."
            )
        buildConfigField("String", "BOT_API_BASE_URL", "\"$botApiUrl\"")

        // Release builds require operator-provided fallback endpoints. Debug
        // builds may omit them; environment values take precedence so CI cannot
        // accidentally inherit a developer placeholder from local.properties.
        val fallbackBotDomain = System.getenv("FALLBACK_BOT_DOMAIN")
            ?.takeIf { it.isNotBlank() }
            ?: localProperties.getProperty("fallback.bot.domain")
            ?: ""
        val fallbackSubsDomain = System.getenv("FALLBACK_SUBS_DOMAIN")
            ?.takeIf { it.isNotBlank() }
            ?: localProperties.getProperty("fallback.subs.domain")
            ?: ""
        val subscriptionUrl = System.getenv("SUBSCRIPTION_URL")
            ?.takeIf { it.isNotBlank() }
            ?: localProperties.getProperty("subscription.url")
            ?: ""
        requireConfiguredReleaseFallback("FALLBACK_BOT_DOMAIN", fallbackBotDomain)
        requireConfiguredReleaseFallback("FALLBACK_SUBS_DOMAIN", fallbackSubsDomain)
        requireConfiguredReleaseFallback("SUBSCRIPTION_URL", subscriptionUrl)
        buildConfigField("String", "FALLBACK_BOT_DOMAIN", "\"$fallbackBotDomain\"")
        buildConfigField("String", "FALLBACK_SUBS_DOMAIN", "\"$fallbackSubsDomain\"")
        buildConfigField("String", "SUBSCRIPTION_BASE_URL", "\"$subscriptionUrl\"")
    }

    // Release signing is opt-in — credentials live in local.properties (gitignored).
    // Without them the release config is skipped so debug builds and CI clones
    // still work; `./gradlew bundleRelease` will fail loudly if invoked.
    val keystorePath = localProperties.getProperty("keystore.path")
    val keystorePassword = localProperties.getProperty("keystore.password")
    val keystoreKeyAlias = localProperties.getProperty("keystore.keyAlias")
    val keystoreKeyPassword = localProperties.getProperty("keystore.keyPassword")
    val hasReleaseSigning = keystorePath != null
        && keystorePassword != null
        && keystoreKeyAlias != null
        && keystoreKeyPassword != null

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreKeyAlias
                keyPassword = keystoreKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isShrinkResources = false
            ndk {
                abiFilters.clear()
                abiFilters += listOf("arm64-v8a", "x86", "x86_64")
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            ndk {
                abiFilters.clear()
                // arm64-v8a covers modern Android TV (Nvidia Shield, Mi Box,
                // Chromecast with Google TV, current Hisense/TCL). x86_64 covers
                // emulators and Chromebook ATV containers. armeabi-v7a is kept
                // for older 32-bit Android TVs (some Sony/Philips/legacy Mi Box);
                // x86 for rare 32-bit Intel ATV boxes / x86 emulator images.
                abiFilters += listOf("arm64-v8a", "x86_64", "armeabi-v7a", "x86")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        create("playRelease") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            buildConfigField("boolean", "IN_APP_UPDATES_ENABLED", "false")
            buildConfigField("boolean", "PLAY_DISTRIBUTION", "true")
        }
    }

    // Per-ABI splits: instead of one universal APK with native libs for every
    // architecture, produce one APK per ABI plus a universal fallback. The
    // in-app updater on the device picks the matching split via
    // Build.SUPPORTED_ABIS, so an old armv7 Mi Box pulls the small
    // armeabi-v7a APK, not the full bundle.
    //
    // Splits are toggled off when building the App Bundle: AAB carries every
    // architecture inside one .aab and Google's bundletool re-splits per
    // device. CI runs APK and AAB in separate gradle invocations, passing
    // -PdisableAbiSplits for the AAB (Google issuetracker #402800800).
    val splitsDisabled = providers.gradleProperty("disableAbiSplits").isPresent
    splits {
        abi {
            isEnable = !splitsDisabled
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("androidTest").assets.directories.add("$projectDir/schemas")
    }
}

ksp {
    arg("room.schemaLocation", file("$projectDir/schemas").path)
}

dependencies {
    // XRay core (AAR in libs/)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))

    // Compose
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // TV Compose
    implementation(libs.androidx.tv.foundation)
    implementation(libs.androidx.tv.material)

    // Core
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation("com.google.android.play:app-update:2.1.0")
    implementation("com.google.android.play:app-update-ktx:2.1.0")

    // Lifecycle
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    // Navigation
    implementation(libs.androidx.navigation.compose)

    // Hilt
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    // Room
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    androidTestImplementation(libs.androidx.room.testing)

    // Network
    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp.logging)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // DataStore
    implementation(libs.androidx.datastore.preferences)

    // SQLCipher
    implementation(libs.sqlcipher)
    implementation(libs.androidx.sqlite.ktx)

    // Serialization
    implementation(libs.kotlinx.serialization.json)

    // QR code generation (for TV pairing)
    implementation(libs.zxing.core)

    // Google Play Billing: only to read the Play account country (external payment rules).
    implementation(libs.play.billing.ktx)

    // Testing
    testImplementation(libs.junit)
    // Real org.json for JVM tests of the Xray config builder (Android ships a stub).
    testImplementation("org.json:json:20250517")
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
