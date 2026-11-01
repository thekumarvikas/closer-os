package com.closeros.app.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject

/** Small things kept on the phone: the call waiting for its outcome, unsent outcomes, sync time. */
class LocalStore(ctx: Context) {
    private val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)

    /** A call the rep started from Closer OS; its outcome form must be filled before the next call. */
    @Serializable data class PendingCall(
        val leadId: String, val leadName: String, val phone: String, val startedAtMs: Long,
        val purpose: String = "sales", val batchId: String? = null,
    )

    var pendingCall: PendingCall?
        get() = p.getString("pending_call", null)?.let { runCatching { json.decodeFromString<PendingCall>(it) }.getOrNull() }
        set(v) { p.edit().putString("pending_call", v?.let { json.encodeToString(it) }).apply() }

    /** Outcomes that could not be sent (no internet). Sent again by the sync worker. */
    var outbox: List<JsonObject>
        get() = p.getString("outbox", null)?.let { runCatching { json.decodeFromString<List<JsonObject>>(it) }.getOrNull() } ?: emptyList()
        set(v) { p.edit().putString("outbox", json.encodeToString(v)).apply() }

    fun addToOutbox(o: JsonObject) { outbox = outbox + o }

    var lastSyncMs: Long
        get() = p.getLong("last_sync_ms", 0)
        set(v) { p.edit().putLong("last_sync_ms", v).apply() }

    /** Newest call-log time already uploaded. */
    var callLogCursorMs: Long
        get() = p.getLong("call_log_cursor_ms", 0)
        set(v) { p.edit().putLong("call_log_cursor_ms", v).apply() }

    var orgId: String?
        get() = p.getString("org_id", null)
        set(v) { p.edit().putString("org_id", v).apply() }

    var preferredSim: Int
        get() = p.getInt("preferred_sim", -1)
        set(v) { p.edit().putInt("preferred_sim", v).apply() }

    /** Follow-ups that currently have reminders scheduled. */
    var scheduledFollowUps: Set<String>
        get() = p.getStringSet("scheduled_fu", emptySet()) ?: emptySet()
        set(v) { p.edit().putStringSet("scheduled_fu", v).apply() }

    /** Phone number of each SIM slot, confirmed by the rep ("1" → "+9198…"). */
    fun simNumber(slot: Int?): String? = slot?.let { p.getString("sim_number_$it", null) }
    fun setSimNumber(slot: Int, number: String) { p.edit().putString("sim_number_$slot", number.trim()).apply() }

    var setupDone: Boolean
        get() = p.getBoolean("setup_done", false)
        set(v) { p.edit().putBoolean("setup_done", v).apply() }

    /** Folder where the phone's dialer saves call recordings (picked once by the rep). */
    var recordingsFolder: String?
        get() = p.getString("rec_folder", null)
        set(v) { p.edit().putString("rec_folder", v).apply() }

    val uploadedRecordings: Set<String> get() = p.getStringSet("rec_uploaded", emptySet()) ?: emptySet()
    fun markRecordingUploaded(callId: String) {
        p.edit().putStringSet("rec_uploaded", (uploadedRecordings + callId).toList().takeLast(3000).toSet()).apply()
    }
    var recordingsUploaded: Int
        get() = p.getInt("rec_count", 0)
        set(v) { p.edit().putInt("rec_count", v).apply() }

    /** Seconds before the next call in the calling queue (3, 5 or 10). */
    var countdownSec: Int
        get() = p.getInt("countdown", 5)
        set(v) { p.edit().putInt("countdown", v).apply() }

    fun clear() { p.edit().clear().apply() }
}
