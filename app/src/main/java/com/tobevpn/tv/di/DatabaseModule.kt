package com.tobevpn.tv.di

import android.content.Context
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.tobevpn.tv.data.local.AppDatabase
import com.tobevpn.tv.data.local.DatabasePassphrase
import com.tobevpn.tv.data.local.dao.ServerDao
import com.tobevpn.tv.data.local.dao.SessionDao
import com.tobevpn.tv.data.local.dao.TrafficLogDao
import com.tobevpn.tv.data.local.dao.PendingPromocodeActivationDao
import com.tobevpn.tv.data.local.dao.UsageDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase {
        val passphrase = DatabasePassphrase.getPassphrase(context)
        // If a pre-encryption DB file exists, SQLCipher throws
        // "file is not a database" on open. Drop incompatible leftovers so
        // upgrades from older builds do not get stuck in a crash loop.
        ensureCipherCompatible(context, "tobevpn_tv.db", passphrase)
        return Room.databaseBuilder(
            context,
            AppDatabase::class.java,
            "tobevpn_tv.db",
        )
            .openHelperFactory(SupportOpenHelperFactory(passphrase))
            .addMigrations(
                MIGRATION_7_8,
                MIGRATION_8_9,
                MIGRATION_9_10,
                MIGRATION_10_11,
                MIGRATION_11_12,
                MIGRATION_12_13,
                MIGRATION_13_14,
                MIGRATION_14_15,
            )
            .fallbackToDestructiveMigration(dropAllTables = false)
            // Usage is updated while the tunnel is active. Keep committed
            // writes in the main DB instead of growing a separate WAL file.
            .setJournalMode(RoomDatabase.JournalMode.TRUNCATE)
            .build()
    }

    private val MIGRATION_7_8 = object : Migration(7, 8) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE session ADD COLUMN planDisplayName TEXT")
        }
    }

    private val MIGRATION_8_9 = object : Migration(8, 9) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE session ADD COLUMN isAdminProfile INTEGER NOT NULL DEFAULT 0")
        }
    }

    private val MIGRATION_9_10 = object : Migration(9, 10) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE servers ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0")
        }
    }

    // v10 -> v11: retain every transport parameter needed by modern
    // WS/TLS/XHTTP/gRPC profiles without dropping the cached subscription.
    internal val MIGRATION_10_11 = object : Migration(10, 11) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE servers ADD COLUMN host TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN alpn TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN headerType TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN serviceName TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN extra TEXT NOT NULL DEFAULT ''")
        }
    }

    internal val MIGRATION_11_12 = object : Migration(11, 12) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS pending_promocode_activations (" +
                    "telegramId INTEGER NOT NULL, code TEXT NOT NULL, " +
                    "requestId TEXT NOT NULL, createdAt INTEGER NOT NULL, " +
                    "PRIMARY KEY(telegramId, code))",
            )
            db.execSQL(
                "CREATE UNIQUE INDEX IF NOT EXISTS " +
                    "index_pending_promocode_activations_requestId " +
                    "ON pending_promocode_activations(requestId)",
            )
        }
    }

    /**
     * The session table is a logical singleton, but its deviceId primary key
     * previously allowed an ID migration to insert a second row without
     * removing the old one. Keep the authenticated/linked row when possible;
     * otherwise retain the row with the freshest usable token pair.
     */
    internal val MIGRATION_12_13 = object : Migration(12, 13) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL(
                "DELETE FROM session WHERE deviceId NOT IN (" +
                    "SELECT deviceId FROM session ORDER BY " +
                    "CASE WHEN authState = 'AUTHENTICATED' AND telegramId IS NOT NULL " +
                    "THEN 1 ELSE 0 END DESC, " +
                    "CASE WHEN isLinked = 1 THEN 1 ELSE 0 END DESC, " +
                    "CASE WHEN accessToken IS NOT NULL AND refreshToken IS NOT NULL " +
                    "THEN 1 ELSE 0 END DESC, " +
                    "COALESCE(refreshExpiresAt, 0) DESC, " +
                    "COALESCE(accessExpiresAt, 0) DESC, rowid DESC LIMIT 1)",
            )
        }
    }

    // v13 -> v14: Hysteria2 profiles in the server cache; existing rows are
    // VLESS.
    internal val MIGRATION_13_14 = object : Migration(13, 14) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE servers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'VLESS'")
            db.execSQL("ALTER TABLE servers ADD COLUMN obfsPassword TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN pinSha256 TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN portHopping TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE servers ADD COLUMN echConfigList TEXT NOT NULL DEFAULT ''")
        }
    }

    // v14 -> v15: the link's finalmask (fm=).
    internal val MIGRATION_14_15 = object : Migration(14, 15) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE servers ADD COLUMN finalMask TEXT NOT NULL DEFAULT ''")
        }
    }

    private fun ensureCipherCompatible(
        context: Context,
        dbName: String,
        passphrase: ByteArray,
    ) {
        val dbFile = context.getDatabasePath(dbName)
        if (!dbFile.exists()) return
        try {
            net.zetetic.database.sqlcipher.SQLiteDatabase.openDatabase(
                dbFile.absolutePath,
                passphrase,
                null,
                net.zetetic.database.sqlcipher.SQLiteDatabase.OPEN_READONLY,
                null,
                null,
            ).close()
        } catch (_: android.database.SQLException) {
            dbFile.delete()
            java.io.File("${dbFile.absolutePath}-shm").delete()
            java.io.File("${dbFile.absolutePath}-wal").delete()
        } catch (_: Throwable) {
            // Do not delete user data for transient JNI or file-lock errors.
        }
    }

    @Provides
    fun provideSessionDao(db: AppDatabase): SessionDao = db.sessionDao()

    @Provides
    fun provideUsageDao(db: AppDatabase): UsageDao = db.usageDao()

    @Provides
    fun provideServerDao(db: AppDatabase): ServerDao = db.serverDao()

    @Provides
    fun provideTrafficLogDao(db: AppDatabase): TrafficLogDao = db.trafficLogDao()

    @Provides
    fun providePendingPromocodeActivationDao(db: AppDatabase): PendingPromocodeActivationDao =
        db.pendingPromocodeActivationDao()
}
