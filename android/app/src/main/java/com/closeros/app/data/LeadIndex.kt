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
    @Serializable private data class Row(
        val id: String, val org_id: String, val name: String = "", val phone: String, val profession: String? = null,
        val company: String? = null, val city: String? = null, val key_facts: String? = null, val do_not_call: Boolean = false,
        val dial_count: Int = 0, val conversation_count: Int = 0, val call_count: Int = 0,
        val updated_at: String, val deleted_at: String? = null,
    )

    private const val CURSOR = "lead_index_cursor3"   // v3: rows carry all-call + conversation counts
    private const val MAX_PAGES = 30   // up to 30,000 leads per sync run

    fun find(ctx: Context, phone: String): Lead? =
        runCatching { LocalDb.get(ctx).leadJsonByPhone(phone)?.let { json.decodeFromString<Lead>(it) } }.getOrNull()

    /** Remembers leads the app has just loaded (lists, lookups), so they're known offline too. */
    fun remember(ctx: Context, leads: Collection<Lead>) = runCatching {
        LocalDb.get(ctx).putLeads(leads.filter { it.phone.isNotBlank() }.map { Triple(it.phone, it.id, json.encodeToString(Lead.serializer(), it.copy(batch_leads = emptyList()))) })
    }

    /** Fetches leads changed since the last run (first run: everything visible to this person, newest 30,000). */
    /** Downloads changed leads; returns the numbers that are new on this phone (their older calls get uploaded). */
    suspend fun sync(ctx: Context, orgId: String): Set<String> {
        val db = LocalDb.get(ctx)
        val added = mutableSetOf<String>()
        var since = db.get(CURSOR) ?: "1970-01-01T00:00:00Z"
        repeat(MAX_PAGES) {
            val rows = Backend.client.from("leads").select(Columns.raw("id,org_id,name,phone,profession,company,city,key_facts,do_not_call,dial_count,conversation_count,call_count,updated_at,deleted_at")) {
                filter { eq("org_id", orgId); gt("updated_at", since) }
                order("updated_at", Order.ASCENDING); limit(1000)
            }.decodeList<Row>()
            if (rows.isEmpty()) return added
            rows.filter { it.deleted_at == null && db.leadJsonByPhone(it.phone) == null }.forEach { added += it.phone }
            db.putLeads(rows.map { r ->
                Triple(r.phone, r.id, if (r.deleted_at != null) null else json.encodeToString(Lead.serializer(),
                    Lead(id = r.id, org_id = r.org_id, name = r.name, phone = r.phone, profession = r.profession, company = r.company,
                        city = r.city, key_facts = r.key_facts, do_not_call = r.do_not_call,
                        dial_count = r.dial_count, conversation_count = r.conversation_count, call_count = r.call_count)))
            })
            since = rows.last().updated_at
            db.put(CURSOR, since)
            if (rows.size < 1000) return added
        }
        return added
    }
}
