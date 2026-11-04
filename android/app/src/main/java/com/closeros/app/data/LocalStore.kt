package com.closeros.app.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject

/** Small things kept on the phone: the call waiting for its outcome, unsent outcomes, sync time. */
class LocalStore(ctx: Context) {
    private val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
    private val db = LocalDb.get(ctx)

    /** A call the rep started from Closer OS; its outcome form must be filled before the next call. */
    @Serializable data class PendingCall(
        val leadId: String, val leadName: String, val phone: String, val startedAtMs: Long,
        val purpose: String = "sales", val batchId: String? = null,
        val profession: String? = null, val categoryId: String? = null,
        /** Set for calls found in the call log (incoming, or dialled outside Closer OS). */
        val logId: String? = null,
        /** Set when the laptop asked this phone to dial (desk mode). */
        val requestId: String? = null,
    )

    var pendingCall: PendingCall?
        get() = p.getString("pending_call", null)?.let { runCatching { json.decodeFromString<PendingCall>(it) }.getOrNull() }
        set(v) { p.edit().putString("pending_call", v?.let { json.encodeToString(it) }).apply() }

    /** Outcomes that could not be sent (no internet). Sent again by the sync worker. */
    var outbox: List<JsonObject>
        get() = p.getString("outbox", null)?.let { runCatching { json.decodeFromString<List<JsonObject>>(it) }.getOrNull() } ?: emptyList()
        set(v) { p.edit().putString("outbox", json.encodeToString(v)).commit() }

    fun addToOutbox(o: JsonObject) = synchronized(outboxLock) { outbox = outbox + o }

    /** Removes only the outcomes that were sent, so one saved meanwhile is never lost. */
    fun removeFromOutbox(sent: List<JsonObject>) = synchronized(outboxLock) { if (sent.isNotEmpty()) outbox = outbox.filter { it !in sent } }

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

    val uploadedRecordings: Set<String> get() = db.marked("rec")
    fun markRecordingUploaded(callId: String) = db.mark("rec", callId)
    var recordingsUploaded: Int
        get() = p.getInt("rec_count", 0)
        set(v) { p.edit().putInt("rec_count", v).apply() }

    /** Setup steps Android can't check (e.g. Autostart): the rep ticks them as done. */
    fun confirmed(key: String) = p.getBoolean("confirm_$key", false)
    fun confirm(key: String) { p.edit().putBoolean("confirm_$key", true).apply() }

    /** Last filters/sort the rep used on a webinar list (per reminder / sales). */
    fun listPrefs(purpose: String): String? = p.getString("list_prefs_$purpose", null)
    fun setListPrefs(purpose: String, v: String) { p.edit().putString("list_prefs_$purpose", v).apply() }

    /** Calls (call-log ids) whose outcome was saved, so they're never asked again. */
    val loggedCalls: Set<String> get() = db.marked("logged")
    fun isLogged(id: String) = db.isMarked("logged", id)
    fun markLogged(id: String) = db.mark("logged", id)
    /** Only calls after this time need an outcome (set the first time this version runs). */
    var outcomeCheckFromMs: Long
        get() = p.getLong("outcome_from", 0)
        set(v) { p.edit().putLong("outcome_from", v).apply() }

    /** New-lead alerts: leads assigned after this time are announced. */
    var newLeadsSince: String?
        get() = p.getString("new_leads_since", null)
        set(v) { p.edit().putString("new_leads_since", v).apply() }
    /** Announcement notifications already shown (id + reminder time), so a reminder rings again. */
    val shownAnnouncements: Set<String> get() = p.getStringSet("ann_shown", emptySet()) ?: emptySet()
    fun setShownAnnouncements(v: Set<String>) { p.edit().putStringSet("ann_shown", v).apply() }

    var waCursorMs: Long
        get() = p.getLong("wa_cursor", 0)
        set(v) { p.edit().putLong("wa_cursor", v).apply() }

    /** Company setting: track WhatsApp calls (read by the notification watcher). */
    var trackWhatsapp: Boolean
        get() = p.getBoolean("track_whatsapp", true)
        set(v) { p.edit().putBoolean("track_whatsapp", v).apply() }

    var lastRecordingCheck: String?
        get() = p.getString("rec_last_check", null)
        set(v) { p.edit().putString("rec_last_check", v).apply() }

    /** Seconds before the next call in the calling queue (3, 5 or 10). */
    var countdownSec: Int
        get() = p.getInt("countdown", 5)
        set(v) { p.edit().putInt("countdown", v).apply() }

    /** After-call pop-up: "all" calls (default), "leads" only, or "off". */
    var afterCallMode: String
        get() = p.getString("after_call_mode", "all") ?: "all"
        set(v) { p.edit().putString("after_call_mode", v).apply() }

    /** Last call the pop-up was shown for (Android sends the "call ended" signal twice). */
    var lastAfterCallId: String?
        get() = p.getString("last_after_call", null)
        set(v) { p.edit().putString("last_after_call", v).commit() }

    /** What the after-call pop-up did last time (for Phone setup / support). */
    var lastAfterCallTrace: String?
        get() = p.getString("after_call_trace", null)
        set(v) { p.edit().putString("after_call_trace", v).apply() }

    fun clear() { p.edit().clear().apply() }

    companion object { private val outboxLock = Any() }
}
