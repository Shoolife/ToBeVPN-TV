package com.tobevpn.tv.di

import com.tobevpn.tv.BuildConfig
import com.tobevpn.tv.data.device.AppUserAgent
import com.tobevpn.tv.data.remote.AuthHeaderInterceptor
import com.tobevpn.tv.data.remote.BootstrapApi
import com.tobevpn.tv.data.remote.BotApi
import com.tobevpn.tv.data.remote.CurrencyApi
import com.tobevpn.tv.data.remote.FallbackInterceptor
import com.tobevpn.tv.data.remote.GithubReleasesApi
import com.tobevpn.tv.data.remote.TokenAuthenticator
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    private val userAgent = AppUserAgent.value

    private val loggingInterceptor
        get() = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.HEADERS
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
            // Even in debug, never print the bearer access_token or the bot-side
            // legacy/panel tokens to logcat — anyone with adb on the dev device
            // could otherwise lift a working session.
            redactHeader(AuthHeaderInterceptor.DIRECT_AUTH_HEADER)
            redactHeader(AuthHeaderInterceptor.FALLBACK_AUTH_HEADER)
            redactHeader("X-Api-Token")
            redactHeader("Cookie")
        }

    private val userAgentInterceptor = Interceptor { chain ->
        val request = chain.request().newBuilder()
            .header("User-Agent", userAgent)
            .build()
        chain.proceed(request)
    }

    @Provides
    @Singleton
    fun provideCurrencyApi(): CurrencyApi {
        val client = OkHttpClient.Builder()
            .addInterceptor(loggingInterceptor)
            .build()

        return Retrofit.Builder()
            .baseUrl("https://open.er-api.com/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(CurrencyApi::class.java)
    }

    @Provides
    @Singleton
    fun provideBootstrapApi(): BootstrapApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(FallbackInterceptor())
            .addInterceptor(userAgentInterceptor)
            .addInterceptor(loggingInterceptor)
            .build()

        return Retrofit.Builder()
            .baseUrl(BuildConfig.BOT_API_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(BootstrapApi::class.java)
    }

    @Provides
    @Singleton
    fun provideBotApi(
        authInterceptor: AuthHeaderInterceptor,
        authenticator: TokenAuthenticator,
    ): BotApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(FallbackInterceptor())
            .addInterceptor(userAgentInterceptor)
            .addInterceptor(authInterceptor)
            .authenticator(authenticator)
            .addInterceptor(loggingInterceptor)
            .build()

        return Retrofit.Builder()
            .baseUrl(BuildConfig.BOT_API_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(BotApi::class.java)
    }

    /**
     * GitHub Releases API client used by the in-app updater. Independent OkHttp
     * stack so its requests don't carry our session token (the GitHub API
     * doesn't need it and shouldn't see it) and don't share the BOT API's
     * authenticator chain.
     */
    @Provides
    @Singleton
    fun provideGithubReleasesApi(): GithubReleasesApi {
        val client = OkHttpClient.Builder()
            .addInterceptor(userAgentInterceptor)
            .addInterceptor(loggingInterceptor)
            .build()

        return Retrofit.Builder()
            .baseUrl("https://api.github.com/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(GithubReleasesApi::class.java)
    }
}
