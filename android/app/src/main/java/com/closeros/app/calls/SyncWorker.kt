package com.closeros.app.calls

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Repo
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Sends unsent outcomes and new call-log entries to Closer OS. Safe to run any number of times. */
object CallSync {
    suspend fun run(ctx: Context): Result<Int> = runCatching {
        val store = LocalStore(ctx)
        val orgId = store.orgId ?: return@runCatching 0
        if (Backend.uid == null) return@runCatching 0

        // 1) Outcomes saved while offline.
        val pending = store.outbox
        val failed = pending.filter { runCatching { Repo.logCall(it) }.isFailure }
        store.outbox = failed

        // 2) New call-log entries (first run: the last 2 days).
        val since = store.callLogCursorMs.takeIf { it > 0 } ?: (System.currentTimeMillis() - 2 * 86_400_000L)
        val entries = PhoneCalls.readLog(ctx, since)
        var sent = 0
        val device = PhoneCalls.deviceId(ctx)
        for (chunk in entries.chunked(200)) {
            val arr = buildJsonArray {
                chunk.forEach { c ->
                    add(buildJsonObject {
                        put("id", c.id); put("phone", c.phone); put("direction", c.direction)
                        put("started_at", Instant.ofEpochMilli(c.startedAtMs).toString()); put("duration_sec", c.durationSec)
                        put("device_id", device)
                        c.simSlot?.let { put("sim_slot", it) }; c.simLabel?.let { put("sim_label", JsonPrimitive(it)) }
                        c.simNumber?.let { put("sim_number", JsonPrimitive(it)) }
                    })
                }
            }
            sent += Repo.syncCalls(orgId, arr)
            store.callLogCursorMs = chunk.last().startedAtMs
        }
        store.lastSyncMs = System.currentTimeMillis()
        // 3) Upload the phone's call recordings for these calls.
        runCatching { store.recordingsUploaded += RecordingSync.run(ctx, orgId) }
        // 4) Refresh follow-up reminders.
        runCatching { FollowUpAlarms.scheduleAll(ctx, Repo.followUps(orgId)) }
        sent
    }

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "call-sync", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
        )
    }

    fun syncNow(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            "call-sync-now", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build(),
        )
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result =
        if (CallSync.run(applicationContext).isSuccess) Result.success() else Result.retry()
}
