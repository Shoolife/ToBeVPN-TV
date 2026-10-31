package com.tobevpn.tv.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import com.tobevpn.tv.data.local.dao.ServerDao
import com.tobevpn.tv.data.local.dao.SessionDao
import com.tobevpn.tv.data.local.dao.TrafficLogDao
import com.tobevpn.tv.data.local.dao.PendingPromocodeActivationDao
import com.tobevpn.tv.data.local.dao.UsageDao
import com.tobevpn.tv.data.local.entity.ServerEntity
import com.tobevpn.tv.data.local.entity.SessionEntity
import com.tobevpn.tv.data.local.entity.TrafficLogEntity
import com.tobevpn.tv.data.local.entity.PendingPromocodeActivationEntity
import com.tobevpn.tv.data.local.entity.UsageEntity

@Database(
    entities = [
        SessionEntity::class,
        UsageEntity::class,
        ServerEntity::class,
        TrafficLogEntity::class,
        PendingPromocodeActivationEntity::class,
    ],
    version = 15,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun sessionDao(): SessionDao
    abstract fun usageDao(): UsageDao
    abstract fun serverDao(): ServerDao
    abstract fun trafficLogDao(): TrafficLogDao
    abstract fun pendingPromocodeActivationDao(): PendingPromocodeActivationDao
}
