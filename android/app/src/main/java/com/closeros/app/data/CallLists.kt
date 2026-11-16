package com.closeros.app.data

import android.content.ContentProviderOperation
import android.content.Context
import android.provider.ContactsContract
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/**
 * "Call a list" / "WhatsApp a list" from a file: the people stay on THIS PHONE only (owner's rule, Nov 2026 —
 * they are not company leads). A person becomes a lead only when the rep taps "+ Add as lead".
 * Kept in LocalDb cache "call_lists", newest first, max 30 lists × 5,000 people.
 */
@Serializable data class ListPerson(val name: String = "", val phone: String, val city: String? = null, val profession: String? = null,
    val email: String? = null, val company: String? = null)
@Serializable data class CallList(val id: String, val tag: String, val createdMs: Long, val kind: String = "call",
    val people: List<ListPerson> = emptyList(), val called: Set<String> = emptySet(), val added: Set<String> = emptySet())

object CallLists {
    private const val KEY = "call_lists"
    /** Ids of list people used in the calling / WhatsApp queue ("list:<number>") — never sent to the server. */
    const val PREFIX = "list:"
    fun isListId(id: String?) = id?.startsWith(PREFIX) == true

    fun all(ctx: Context): List<CallList> = LocalDb.get(ctx).get(KEY)?.let {
        runCatching { json.decodeFromString(ListSerializer(CallList.serializer()), it) }.getOrNull() } ?: emptyList()
    private fun write(ctx: Context, v: List<CallList>) =
        LocalDb.get(ctx).put(KEY, json.encodeToString(ListSerializer(CallList.serializer()), v.take(30)))

    fun save(ctx: Context, l: CallList) = synchronized(this) { write(ctx, listOf(l) + all(ctx).filterNot { it.id == l.id }) }
    fun delete(ctx: Context, id: String) = synchronized(this) { write(ctx, all(ctx).filterNot { it.id == id }) }
    private fun update(ctx: Context, phone: String, f: (CallList) -> CallList) = synchronized(this) {
        write(ctx, all(ctx).map { l -> if (l.people.any { it.phone == phone }) f(l) else l })
    }
    fun markCalled(ctx: Context, phone: String) = update(ctx, phone) { it.copy(called = it.called + phone) }
    fun markAdded(ctx: Context, phone: String) = update(ctx, phone) { it.copy(added = it.added + phone) }

    /** The list a number belongs to (newest list first). */
    fun find(ctx: Context, phone: String): Pair<CallList, ListPerson>? =
        all(ctx).firstNotNullOfOrNull { l -> l.people.firstOrNull { it.phone == phone }?.let { l to it } }

    /** People of a list as queue items: people already in my leads come as the real lead, the rest as "list:" items. */
    fun asLeads(ctx: Context, orgId: String, l: CallList): List<Lead> = l.people.map { p ->
        LeadIndex.find(ctx, p.phone) ?: Lead(id = PREFIX + p.phone, org_id = orgId, name = p.name, phone = p.phone, city = p.city,
            profession = p.profession, email = p.email, company = p.company, source = l.tag)
    }

    /**
     * Saves people in the phone's contacts (numbers already saved are skipped), so WhatsApp messages go to saved
     * numbers. Returns how many were added. Needs WRITE_CONTACTS.
     */
    fun saveToContacts(ctx: Context, people: List<Pair<String, String>>, tag: String): Int {
        val existing = LeadImport.contacts(ctx).map { it.second.filter(Char::isDigit).takeLast(10) }.toMutableSet()
        var added = 0
        people.chunked(100).forEach { chunk ->
            val ops = ArrayList<ContentProviderOperation>()
            chunk.forEach { (name, phone) ->
                val key = phone.filter(Char::isDigit).takeLast(10)
                if (key.length < 7 || !existing.add(key)) return@forEach
                val i = ops.size
                ops += ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                    .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build()
                ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, i)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name.ifBlank { phone }).build()
                ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, i)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                    .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE).build()
                ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, i)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Note.NOTE, "Closer OS · $tag").build()
                added++
            }
            if (ops.isNotEmpty()) runCatching { ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops) }
                .onFailure { AppLog.error(ctx, "save contacts", it); added -= ops.size / 4 }
        }
        return added
    }
}
