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

    fun clear() { p.edit().clear().apply() }
}
