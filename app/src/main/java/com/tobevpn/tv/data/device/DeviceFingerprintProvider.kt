package com.tobevpn.tv.data.device

import android.content.Context
import android.os.Build
import android.provider.Settings
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

data class DeviceFingerprint(
    val hwid: String,        // Settings.Secure.ANDROID_ID
    val platform: String,    // "Android TV"
    val osVersion: String,   // Build.VERSION.RELEASE — "16"
    val model: String,       // Build.MANUFACTURER + " " + Build.MODEL
    val userAgent: String,   // AppUserAgent.value
)

@Singleton
class DeviceFingerprintProvider @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun get(): DeviceFingerprint = DeviceFingerprint(
        hwid = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID),
        platform = "Android TV",
        osVersion = Build.VERSION.RELEASE.orEmpty(),
        model = composeModel(),
        userAgent = AppUserAgent.value,
    )

    private fun composeModel(): String {
        val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
        val model = Build.MODEL?.trim().orEmpty()
        return when {
            model.isEmpty() && manufacturer.isEmpty() -> "Android TV"
            manufacturer.isEmpty() -> model
            model.isEmpty() -> manufacturer
            model.startsWith(manufacturer, ignoreCase = true) -> model
            else -> "$manufacturer $model"
        }
    }
}
