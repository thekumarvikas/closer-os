package com.closeros.app.data

import android.content.Context
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

/**
 * The rep's working day for the efficiency report: Start / End day, breaks, and time blocks measured
 * on this phone — Closer OS on screen (app), saving outcomes / editing leads (crm), phone line busy
 * (call), away in WhatsApp after opening it from Closer OS (wa). Kept on the phone and uploaded with
 * the normal sync; nothing is lost without internet.
 */
object WorkLog {
    private val lock = Any()
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences("worklog", Context.MODE_PRIVATE)
    private fun list(ctx: Context, key: String): List<JsonObject> =
        p(ctx).getString(key, null)?.let { runCatching { json.decodeFromString<List<JsonObject>>(it) }.getOrNull() } ?: emptyList()
    private fun save(ctx: Context, key: String, v: List<JsonObject>) =
        p(ctx).edit().putString(key, json.encodeToString(kotlinx.serialization.builtins.ListSerializer(JsonObject.serializer()), v.takeLast(3000))).apply()

    // ───── Day / break state (this phone) ─────
    fun today() = LocalDate.now().toString()
    fun dayStarted(ctx: Context) = p(ctx).getString("day", null) == today() && p(ctx).getLong("day_start", 0) > 0
    fun dayStartMs(ctx: Context) = if (dayStarted(ctx)) p(ctx).getLong("day_start", 0) else 0L
    fun dayEnded(ctx: Context) = p(ctx).getString("day", null) == today() && p(ctx).getLong("day_end", 0) > 0
    fun dayEndMs(ctx: Context) = if (dayEnded(ctx)) p(ctx).getLong("day_end", 0) else 0L
    fun onBreak(ctx: Context) = dayStarted(ctx) && !dayEnded(ctx) && p(ctx).getLong("break_since", 0) > 0
    fun breakSinceMs(ctx: Context) = if (onBreak(ctx)) p(ctx).getLong("break_since", 0) else 0L
    fun breakType(ctx: Context) = p(ctx).getString("break_type", null)
    /** Minutes of breaks taken today (finished ones + the running one). */
    fun breakMinutesToday(ctx: Context): Int {
        if (p(ctx).getString("day", null) != today()) return 0
        val done = p(ctx).getLong("break_total_ms", 0)
        val running = breakSinceMs(ctx).takeIf { it > 0 }?.let { System.currentTimeMillis() - it } ?: 0
        return ((done + running) / 60_000).toInt()
    }

    private fun event(ctx: Context, kind: String, breakType: String? = null, at: Long = System.currentTimeMillis()) = synchronized(lock) {
        save(ctx, "events", list(ctx, "events") + buildJsonObject {
            put("id", UUID.randomUUID().toString()); put("kind", kind); put("at", Instant.ofEpochMilli(at).toString())
            breakType?.let { put("break_type", it) }
        })
    }

    fun startDay(ctx: Context) {
        val now = System.currentTimeMillis()
        if (p(ctx).getString("day", null) != today())
            p(ctx).edit().putString("day", today()).putLong("day_end", 0).putLong("break_since", 0).putLong("break_total_ms", 0).apply()
        p(ctx).edit().putLong("day_start", if (dayStarted(ctx)) p(ctx).getLong("day_start", now) else now).putLong("day_end", 0).apply()
        event(ctx, "day_start", at = now)
        flushSoon(ctx)
    }

    fun endDay(ctx: Context) {
        if (onBreak(ctx)) endBreak(ctx)
        p(ctx).edit().putLong("day_end", System.currentTimeMillis()).apply()
        event(ctx, "day_end"); flushSoon(ctx)
    }

    fun startBreak(ctx: Context, type: String) {
        if (!dayStarted(ctx)) startDay(ctx)
        if (onBreak(ctx)) return
        p(ctx).edit().putLong("break_since", System.currentTimeMillis()).putString("break_type", type).apply()
        event(ctx, "break_start", type); flushSoon(ctx)
    }

    fun endBreak(ctx: Context) {
        val since = breakSinceMs(ctx); if (since == 0L) return
        p(ctx).edit().putLong("break_since", 0).putLong("break_total_ms", p(ctx).getLong("break_total_ms", 0) + System.currentTimeMillis() - since).apply()
        event(ctx, "break_end"); flushSoon(ctx)
    }

    // ───── Time blocks ─────
    fun segment(ctx: Context, kind: String, startMs: Long, endMs: Long = System.currentTimeMillis()) {
        if (startMs <= 0 || endMs - startMs < 3_000) return
        val end = minOf(endMs, startMs + 4 * 3_600_000L)
        synchronized(lock) {
            save(ctx, "segments", list(ctx, "segments") + buildJsonObject {
                put("id", UUID.randomUUID().toString()); put("kind", kind)
                put("start", Instant.ofEpochMilli(startMs).toString()); put("end", Instant.ofEpochMilli(end).toString())
            })
        }
    }

    /** Closer OS came on screen: starts an "app" block; also ends a WhatsApp trip started from Closer OS. */
    fun appResumed(ctx: Context) {
        val now = System.currentTimeMillis()
        p(ctx).edit().putLong("app_since", now).apply()
        val wa = p(ctx).getLong("wa_since", 0)
        if (wa > 0) { p(ctx).edit().putLong("wa_since", 0).apply(); if (now - wa <= 10 * 60_000) segment(ctx, "wa", wa, now) }
    }
    fun appPaused(ctx: Context) {
        val since = p(ctx).getLong("app_since", 0)
        p(ctx).edit().putLong("app_since", 0).apply()
        segment(ctx, "app", since)
    }
    /** WhatsApp opened from Closer OS to message a lead: the time until the rep comes back is measured. */
    fun whatsappOpened(ctx: Context) { p(ctx).edit().putLong("wa_since", System.currentTimeMillis()).apply() }

    /** Saving an outcome / editing a lead on screen: start and end of a CRM block. */
    fun crmStart(ctx: Context): Long = System.currentTimeMillis()
    fun crmEnd(ctx: Context, startMs: Long) = segment(ctx, "crm", startMs, minOf(System.currentTimeMillis(), startMs + 10 * 60_000L))   // a form left open counts 10 min at most

    fun waiting(ctx: Context) = list(ctx, "events").size + list(ctx, "segments").size

    private fun flushSoon(ctx: Context) = runCatching { com.closeros.app.calls.CallSync.syncNow(ctx) }

    /** Uploads everything waiting (called by the sync). */
    suspend fun flush(ctx: Context, orgId: String) {
        for (key in listOf("events", "segments")) {
            val items = synchronized(lock) { list(ctx, key) }.take(500)
            if (items.isEmpty()) continue
            val arr = buildJsonArray { items.forEach { add(it) } }
            runCatching { if (key == "events") Repo.logWorkEvents(orgId, arr) else Repo.uploadActivity(orgId, arr) }
                .onSuccess {
                    val sent = items.mapNotNull { it["id"]?.jsonPrimitive?.content }.toSet()
                    synchronized(lock) { save(ctx, key, list(ctx, key).filter { it["id"]?.jsonPrimitive?.content !in sent }) }
                }.onFailure { if (!Net.isNetworkError(it)) AppLog.error(ctx, "work log", it) }
        }
    }
}
