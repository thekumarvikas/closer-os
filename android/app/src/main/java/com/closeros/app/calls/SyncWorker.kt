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
        if (!com.closeros.app.data.Net.isOnline) return@runCatching 0   // nothing can be sent; runs again when the internet is back
        Backend.ensureFreshSession()

        // 1) Outcomes saved while offline.
        val pending = store.outbox
        val sentOk = pending.filter { o ->
            runCatching { Repo.logCall(o) }.onFailure { if (!com.closeros.app.data.Net.isNetworkError(it)) com.closeros.app.data.AppLog.error(ctx, "outbox", it) }.isSuccess
        }
        store.removeFromOutbox(sentOk)
        // Notes, key facts, WhatsApp "sent" marks and leads added with no internet.
        runCatching { com.closeros.app.data.Ops.flush(ctx) }
        // Working day + time blocks for the efficiency report.
        // One login = one phone: if this login is now used on another phone, sign out here (all uploaded above).
        if (DeviceGuard.check(ctx, force = true)) return@runCatching 0
        // Keep the phone's copy of the leads fresh (instant after-call pop-up, works offline).
        val newLeadPhones = runCatching { com.closeros.app.data.LeadIndex.sync(ctx, orgId) }
            .onFailure { com.closeros.app.data.AppLog.error(ctx, "lead index", it) }.getOrDefault(emptySet())

        // 2) New call-log entries (first run: the last 2 days).
        val since = store.callLogCursorMs.takeIf { it > 0 } ?: (System.currentTimeMillis() - 2 * 86_400_000L)
        val entries = PhoneCalls.readLog(ctx, since)
        var sent = 0
        val device = PhoneCalls.deviceId(ctx)
        for (chunk in entries.chunked(200)) {
            sent += Repo.syncCalls(orgId, phoneCallsJson(chunk, device))
            store.callLogCursorMs = chunk.last().startedAtMs
        }
        // 2a) Older calls with lead numbers, from the phone's whole call history — so each lead's call count is complete.
        //     Once for all leads, then again only for numbers that just became leads. Personal calls stay on the phone.
        runCatching {
            if (!store.leadHistoryDone && com.closeros.app.data.LocalDb.get(ctx).leadIndexCount() > 0) { sent += uploadLeadHistory(ctx, orgId, device, null); store.leadHistoryDone = true }
            else if (newLeadPhones.isNotEmpty()) sent += uploadLeadHistory(ctx, orgId, device, newLeadPhones)
        }.onFailure { com.closeros.app.data.AppLog.error(ctx, "lead call history", it) }
        // 2b) WhatsApp calls noted from WhatsApp's call notifications (if the rep allowed it).
        val wa = WhatsAppCalls.since(ctx, store.waCursorMs).filter { it.phone.isNotBlank() || !it.name.isNullOrBlank() }
        for (chunk in wa.chunked(200)) {
            val arr = buildJsonArray {
                chunk.forEach { c ->
                    add(buildJsonObject {
                        put("id", c.id); put("phone", c.phone); put("direction", c.direction); put("channel", "whatsapp")
                        put("started_at", Instant.ofEpochMilli(c.startedAtMs).toString()); put("duration_sec", c.durationSec)
                        put("device_id", device); c.name?.let { put("contact_name", JsonPrimitive(it)) }
                    })
                }
            }
            sent += Repo.syncCalls(orgId, arr)
            store.waCursorMs = chunk.last().startedAtMs
        }
        store.lastSyncMs = System.currentTimeMillis()
        // 3) Upload the phone's call recordings for these calls, and tell the dashboard how it went.
        checkRecordings(ctx, orgId)
        // Send any saved crash/error reports, and tidy old "done" marks.
        runCatching { com.closeros.app.data.AppLog.flush(ctx) }
        runCatching { com.closeros.app.data.LocalDb.get(ctx).pruneMarks() }
        // 4) Announcements from management + new leads assigned to me.
        runCatching { TeamAlerts.check(ctx, orgId) }
        runCatching { CheckIn.schedule(ctx) }   // hourly check-ins (settings may have changed)
        // 5) Refresh follow-up reminders.
        runCatching { FollowUpAlarms.scheduleAll(ctx, Repo.followUps(orgId)) }
        // 6) Save copies of reports, lead work, playbook, focus and recent recordings for use with no internet.
        runCatching { Prefetch.run(ctx) }
        sent
    }

    private fun phoneCallsJson(chunk: List<LogCall>, device: String) = buildJsonArray {
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

    /** Uploads every call in the phone's history whose number is a lead ([phones] = only these numbers). Safe to repeat: ids are stable. */
    private suspend fun uploadLeadHistory(ctx: Context, orgId: String, device: String, phones: Set<String>?): Int {
        val leadPhones = phones ?: com.closeros.app.data.LocalDb.get(ctx).leadPhones()
        if (leadPhones.isEmpty()) return 0
        val prefix = AfterCall.company(ctx)?.prefix ?: "+91"
        var cursor = 0L; var sent = 0
        while (true) {
            val page = PhoneCalls.readLog(ctx, cursor, 2000)
            if (page.isEmpty()) break
            page.filter { com.closeros.app.ui.normalizePhone(it.phone, prefix) in leadPhones }.chunked(200)
                .forEach { sent += Repo.syncCalls(orgId, phoneCallsJson(it, device)) }
            cursor = page.last().startedAtMs
            if (page.size < 2000) break
        }
        return sent
    }

    /** Runs the recording upload and reports this phone's status to the dashboard. */
    suspend fun checkRecordings(ctx: Context, orgId: String): RecordingSync.Result {
        val store = LocalStore(ctx)
        val r = runCatching { RecordingSync.run(ctx, orgId) }.getOrElse {
            com.closeros.app.data.AppLog.error(ctx, "recordings", it); RecordingSync.Result(error = it.message ?: "Recording check failed") }
        r.error?.takeIf { it.startsWith("Upload refused") || it.contains("Exception") }?.let { com.closeros.app.data.AppLog.error(ctx, "recording upload", null, message = it) }
        store.lastRecordingCheck = "${java.time.LocalTime.now().withNano(0)} · ${r.filesFound} files · ${r.matched}/${r.callsChecked} calls matched · ${r.uploaded} uploaded" +
            (r.error?.let { " · $it" } ?: "")
        runCatching {
            Repo.reportDevice(buildJsonObject {
                put("org_id", orgId); put("device_id", PhoneCalls.deviceId(ctx))
                put("model", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"); put("android", android.os.Build.VERSION.RELEASE)
                put("app_version", com.closeros.app.BuildConfig.VERSION_NAME)
                put("default_dialer", ctx.getSystemService(android.telecom.TelecomManager::class.java)?.defaultDialerPackage ?: "")
                put("rec_folder_set", store.recordingsFolder != null)
                put("rec_files_found", r.filesFound); put("rec_calls_checked", r.callsChecked); put("rec_matched", r.matched)
                put("rec_uploaded_total", store.recordingsUploaded); put("rec_last_error", r.error ?: "")
                put("rec_checked_at", Instant.now().toString())
                put("setup", buildJsonObject { PhoneSetup.items(ctx).forEach { put(it.key, it.done) } })
            })
        }
        return r
    }

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "call-sync", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
        )
    }

    /** After every call: upload it ~30 s later (call history written, pop-up done). Back-to-back calls share one upload. */
    fun syncAfterCall(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            "call-end-sync", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online)
                .setInitialDelay(30, java.util.concurrent.TimeUnit.SECONDS).build(),
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
        CallSync.run(applicationContext).let { r ->
            r.exceptionOrNull()?.let { com.closeros.app.data.AppLog.error(applicationContext, "sync", it) }
            if (r.isSuccess) Result.success() else Result.retry()
        }
}
