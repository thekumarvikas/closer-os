package com.closeros.app.data

import android.content.Context
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable

/**
 * A small copy of the rep's leads on the phone (number → name, profession, key facts…), kept up to
 * date by the background sync. The after-call pop-up uses it to recognise a lead the instant a call
 * ends — no waiting for the internet. The server is still asked afterwards to confirm.
 */
object LeadIndex {
    @Serializable private data class Meta(val id: String, val phone: String, val updated_at: String, val deleted_at: String? = null)

    private const val CURSOR = "lead_index_cursor9"   // v5: full lead rows + webinar ids (reminder vs sales offline)
    private const val MAX_PAGES = 120   // up to 30,000 leads per sync run (pages of 250: small enough for weak internet)

    fun find(ctx: Context, phone: String): Lead? =
        runCatching { LocalDb.get(ctx).leadJsonByPhone(phone)?.let { json.decodeFromString<Lead>(it) } }.getOrNull()

    /** Remembers leads the app has just loaded (lists, lookups), so they're known offline too. */
    fun remember(ctx: Context, leads: Collection<Lead>) = runCatching {
        // Numbers this phone didn't know as leads yet (e.g. just added from a call): their older calls still need uploading.
        val db = LocalDb.get(ctx)
        val fresh = leads.map { it.phone }.filter { it.isNotBlank() && db.leadJsonByPhone(it) == null }
        if (fresh.isNotEmpty()) synchronized(this) {
            val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
            p.edit().putStringSet("history_pending", (p.getStringSet("history_pending", emptySet()).orEmpty() + fresh).toSet()).apply()
        }
        LocalDb.get(ctx).putLeads(leads.filter { it.phone.isNotBlank() }.map { Triple(it.phone, it.id, json.encodeToString(Lead.serializer(), it)) })
    }

    /** Fetches leads changed since the last run (first run: everything visible to this person, newest 30,000). */
    /** Downloads changed leads; returns the numbers that are new on this phone (their older calls get uploaded). */
    suspend fun sync(ctx: Context, orgId: String): Set<String> {
        val db = LocalDb.get(ctx)
        val added = mutableSetOf<String>()
        var since = db.get(CURSOR) ?: "1970-01-01T00:00:00Z"
        repeat(MAX_PAGES) {
            val raw = Backend.client.from("leads").select(Columns.raw("*, batch_leads(batch_id, is_holdout, watch_minutes, attended, batch:batches(name, webinar_at))")) {
                filter { eq("org_id", orgId); gt("updated_at", since) }
                order("updated_at", Order.ASCENDING); limit(250)
            }.decodeList<kotlinx.serialization.json.JsonObject>()
            if (raw.isEmpty()) return added
            val rows = raw.mapNotNull { o -> runCatching { json.decodeFromJsonElement(Meta.serializer(), o) to o }.getOrNull() }
            rows.filter { (m, _) -> m.deleted_at == null && db.leadJsonByPhone(m.phone) == null }.forEach { added += it.first.phone }
            db.putLeads(rows.map { (m, o) -> Triple(m.phone, m.id, if (m.deleted_at != null) null else o.toString()) })
            since = rows.last().first.updated_at
            db.put(CURSOR, since)
            if (raw.size < 250) return added
        }
        return added
    }
}
