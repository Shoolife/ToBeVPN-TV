package com.tobevpn.tv.data.local

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tobevpn.tv.di.DatabaseModule
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppDatabaseMigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AppDatabase::class.java,
    )

    @Before
    fun removePreviousTestDatabase() {
        InstrumentationRegistry.getInstrumentation().targetContext.deleteDatabase(TEST_DATABASE)
    }

    @Test
    fun migration10To11PreservesServerAndAddsTransportDefaults() {
        helper.createDatabase(TEST_DATABASE, 10).use { database ->
            insertVersion10Server(database)
        }

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            11,
            true,
            DatabaseModule.MIGRATION_10_11,
        ).use { database ->
            database.query(
                "SELECT id, name, host, alpn, headerType, serviceName, extra, sortOrder FROM servers",
            ).use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals("server-id", cursor.getString(cursor.getColumnIndexOrThrow("id")))
                assertEquals("Saved server", cursor.getString(cursor.getColumnIndexOrThrow("name")))
                listOf("host", "alpn", "headerType", "serviceName", "extra").forEach { column ->
                    assertEquals("", cursor.getString(cursor.getColumnIndexOrThrow(column)))
                }
                assertEquals(7, cursor.getInt(cursor.getColumnIndexOrThrow("sortOrder")))
            }
        }
    }

    @Test
    fun migration11To12CreatesPendingPromocodeActivationTable() {
        helper.createDatabase(TEST_DATABASE, 11).close()

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            12,
            true,
            DatabaseModule.MIGRATION_11_12,
        ).use { database ->
            database.execSQL(
                "INSERT INTO pending_promocode_activations " +
                    "(telegramId, code, requestId, createdAt) VALUES (?, ?, ?, ?)",
                arrayOf<Any>(123L, "WELCOME", "request-id", 456L),
            )
            database.query(
                "SELECT telegramId, code, requestId, createdAt " +
                    "FROM pending_promocode_activations",
            ).use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals(123L, cursor.getLong(cursor.getColumnIndexOrThrow("telegramId")))
                assertEquals("WELCOME", cursor.getString(cursor.getColumnIndexOrThrow("code")))
                assertEquals("request-id", cursor.getString(cursor.getColumnIndexOrThrow("requestId")))
                assertEquals(456L, cursor.getLong(cursor.getColumnIndexOrThrow("createdAt")))
            }
        }
    }

    @Test
    fun migration12To13KeepsAuthenticatedSessionAndRemovesDuplicates() {
        helper.createDatabase(TEST_DATABASE, 12).use { database ->
            insertVersion12Session(
                database = database,
                deviceId = "stale-device",
                authState = "UNAUTHENTICATED",
                telegramId = null,
                isLinked = false,
                accessToken = "stale-access",
                refreshToken = "stale-refresh",
                accessExpiresAt = 9_000L,
                refreshExpiresAt = 10_000L,
            )
            insertVersion12Session(
                database = database,
                deviceId = "linked-device",
                authState = "AUTHENTICATED",
                telegramId = 123L,
                isLinked = true,
                accessToken = "linked-access",
                refreshToken = "linked-refresh",
                accessExpiresAt = 1_000L,
                refreshExpiresAt = 2_000L,
            )
        }

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            13,
            true,
            DatabaseModule.MIGRATION_12_13,
        ).use { database ->
            database.query(
                "SELECT deviceId, authState, telegramId, isLinked FROM session",
            ).use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals("linked-device", cursor.getString(cursor.getColumnIndexOrThrow("deviceId")))
                assertEquals("AUTHENTICATED", cursor.getString(cursor.getColumnIndexOrThrow("authState")))
                assertEquals(123L, cursor.getLong(cursor.getColumnIndexOrThrow("telegramId")))
                assertEquals(1, cursor.getInt(cursor.getColumnIndexOrThrow("isLinked")))
            }
        }
    }

    @Test
    fun fullMigration10To13PreservesServerAndCreatesPromocodeQueue() {
        helper.createDatabase(TEST_DATABASE, 10).use(::insertVersion10Server)

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            13,
            true,
            DatabaseModule.MIGRATION_10_11,
            DatabaseModule.MIGRATION_11_12,
            DatabaseModule.MIGRATION_12_13,
        ).use { database ->
            database.query("SELECT COUNT(*) FROM servers").use { cursor ->
                cursor.moveToFirst()
                assertEquals(1, cursor.getInt(0))
            }
            database.query(
                "SELECT COUNT(*) FROM sqlite_master " +
                    "WHERE type='table' AND name='pending_promocode_activations'",
            ).use { cursor ->
                cursor.moveToFirst()
                assertEquals(1, cursor.getInt(0))
            }
        }
    }

    @Test
    fun migration13To14AddsHysteria2ColumnsAndKeepsServersVless() {
        helper.createDatabase(TEST_DATABASE, 13).use(::insertVersion10Server)
        // Validates the migrated schema against 14.json: columns, types,
        // NOT NULL and defaults must match the entity exactly.
        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            14,
            true,
            DatabaseModule.MIGRATION_13_14,
        ).use { database ->
            database.query(
                "SELECT id, protocol, obfsPassword, pinSha256, portHopping, echConfigList " +
                    "FROM servers",
            ).use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals("server-id", cursor.getString(cursor.getColumnIndexOrThrow("id")))
                assertEquals("VLESS", cursor.getString(cursor.getColumnIndexOrThrow("protocol")))
                listOf("obfsPassword", "pinSha256", "portHopping", "echConfigList").forEach { column ->
                    assertEquals("", cursor.getString(cursor.getColumnIndexOrThrow(column)))
                }
            }
        }
    }

    @Test
    fun migration14To15AddsFinalMask() {
        helper.createDatabase(TEST_DATABASE, 14).use(::insertVersion10Server)
        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            15,
            true,
            DatabaseModule.MIGRATION_14_15,
        ).use { database ->
            database.query("SELECT id, finalMask FROM servers").use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals("server-id", cursor.getString(cursor.getColumnIndexOrThrow("id")))
                assertEquals("", cursor.getString(cursor.getColumnIndexOrThrow("finalMask")))
            }
        }
    }

    private fun insertVersion12Session(
        database: SupportSQLiteDatabase,
        deviceId: String,
        authState: String,
        telegramId: Long?,
        isLinked: Boolean,
        accessToken: String,
        refreshToken: String,
        accessExpiresAt: Long,
        refreshExpiresAt: Long,
    ) {
        database.execSQL(
            "INSERT INTO session (deviceId, authState, telegramId, userPlan, planDisplayName, " +
                "planExpiresAt, shortUuid, panelUserUuid, accessToken, refreshToken, " +
                "accessExpiresAt, refreshExpiresAt, isLinked, isAdminProfile) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            arrayOf<Any?>(
                deviceId,
                authState,
                telegramId,
                if (isLinked) "PAID" else "FREE_TRIAL",
                null,
                null,
                null,
                null,
                accessToken,
                refreshToken,
                accessExpiresAt,
                refreshExpiresAt,
                if (isLinked) 1 else 0,
                0,
            ),
        )
    }

    private fun insertVersion10Server(database: SupportSQLiteDatabase) {
        database.execSQL(
            "INSERT INTO servers (id, name, address, port, uuid, flow, security, sni, " +
                "fingerprint, publicKey, shortId, network, path, mode, spx, country, " +
                "isOnline, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            arrayOf<Any>(
                "server-id", "Saved server", "node.example", 443,
                "550e8400-e29b-41d4-a716-446655440000", "", "tls", "front.example",
                "chrome", "", "", "ws", "/vpn", "", "", "NL", 1, 7,
            ),
        )
    }

    private companion object {
        const val TEST_DATABASE = "tv-app-database-migration-test"
    }
}
