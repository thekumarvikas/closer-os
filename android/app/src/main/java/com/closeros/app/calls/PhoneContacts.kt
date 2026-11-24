package com.closeros.app.calls

// Leads saved as contacts on the rep's phone (owner, Nov 24 2026), so a lead who calls back shows by name on the ringing
// screen, in the call history and in WhatsApp. They live in Closer OS's OWN contacts account ("Closer OS"), never in the rep's
// Google account: personal contacts are never touched, and everything goes when the lead is reassigned / deleted or the rep
// signs out. Format (owner): name only (no date — it would show in WhatsApp); company line "Doctor · Pune · Webinar 23 Nov ·
// Saved 24 Nov"; buyer line "Buyer – <product> on 25 Nov 2026"; note = the latest conversation note with its date.
// Rep edits on the phone: the NAME and EMAIL go back to Closer OS; a changed number is added to the lead as an extra number.

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.app.Service
import android.content.AbstractThreadedSyncAdapter
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.SyncResult
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds
import android.provider.ContactsContract.RawContacts
import com.closeros.app.R
import com.closeros.app.data.AppLog
import com.closeros.app.data.Backend
import com.closeros.app.data.json
import com.closeros.app.data.parseInstant
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object PhoneContacts {
    @Serializable data class Web(val at: String? = null, val min: Int? = null)
    @Serializable data class Buy(val product: String = "", val at: String? = null, val more: Int = 0)
    @Serializable data class Row(
        val id: String, val name: String = "", val phone: String = "", val email: String? = null,
        val profession: String? = null, val city: String? = null, val saved_at: String? = null, val intent: String? = null,
        val last_note: String? = null, val last_note_at: String? = null, val webinar: Web? = null, val buyer: Buy? = null,
    )
    /** What we last wrote for a lead: to spot the rep's own edits on the phone. */
    @Serializable private data class Mine(val raw: Long, val hash: Int, val name: String, val email: String?, val phone: String)

    fun accountType(ctx: Context) = ctx.getString(R.string.contacts_account_type)
    private fun account(ctx: Context) = Account("Closer OS", accountType(ctx))
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("phone_contacts", Context.MODE_PRIVATE)
    private fun can(ctx: Context) = listOf(android.Manifest.permission.READ_CONTACTS, android.Manifest.permission.WRITE_CONTACTS)
        .all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun day(iso: String?, zone: ZoneId, year: Boolean = false) = iso?.let { runCatching {
        DateTimeFormatter.ofPattern(if (year) "d MMM yyyy" else "d MMM").withZone(zone).format(parseInstant(it)) }.getOrNull() }

    fun companyLine(r: Row, zone: ZoneId) = listOfNotNull(r.profession?.trim()?.ifBlank { null }, r.city?.trim()?.ifBlank { null },
        day(r.webinar?.at, zone)?.let { "Webinar $it" }, day(r.saved_at, zone)?.let { "Saved $it" }).joinToString(" · ")
    fun buyerLine(r: Row, zone: ZoneId) = r.buyer?.let { b ->
        "Buyer – ${b.product}" + (day(b.at, zone, year = true)?.let { " on $it" } ?: "") + if (b.more > 0) " · +${b.more} more" else "" }
    fun noteLine(r: Row, zone: ZoneId) = r.last_note?.trim()?.ifBlank { null }?.let { n -> n + (day(r.last_note_at, zone)?.let { " ($it)" } ?: "") }
    private fun displayName(r: Row) = r.name.trim().ifBlank { "Lead " + r.phone }

    /** Saved copy for the caller-ID strip (works without internet). Keyed by the last 10 digits. */
    private fun saveStrip(ctx: Context, rows: List<Row>) = runCatching {
        com.closeros.app.data.LocalDb.get(ctx).put("contact_rows", json.encodeToString(rows))
    }
    fun stripRow(ctx: Context, phone: String): Row? = runCatching {
        val key = phone.filter { it.isDigit() }.takeLast(10); if (key.length < 6) return null
        com.closeros.app.data.LocalDb.get(ctx).get("contact_rows")?.let { json.decodeFromString<List<Row>>(it) }
            ?.firstOrNull { it.phone.filter { c -> c.isDigit() }.endsWith(key) }
    }.getOrNull()

    /** Brings the phone's "Closer OS" contacts in line with my leads. Called from every sync and from a push. */
    suspend fun sync(ctx: Context, orgId: String, zoneId: String) {
        val rows = runCatching {
            json.decodeFromString<List<Row>>(Backend.client.postgrest.rpc("my_contact_leads", buildJsonObject { put("p_org", orgId) }).data)
        }.getOrElse { AppLog.error(ctx, "phone contacts", it); return }
        saveStrip(ctx, rows)
        if (!can(ctx)) return
        val zone = runCatching { ZoneId.of(zoneId) }.getOrDefault(ZoneId.systemDefault())
        runCatching { apply(ctx, rows, zone) }.onFailure { AppLog.error(ctx, "phone contacts", it) }
    }

    private suspend fun apply(ctx: Context, rows: List<Row>, zone: ZoneId) {
        val am = AccountManager.get(ctx); val acc = account(ctx)
        if (am.getAccountsByType(acc.type).none { it.name == acc.name }) {
            am.addAccountExplicitly(acc, null, null)
            ContentResolver.setSyncAutomatically(acc, ContactsContract.AUTHORITY, false)
            // Make the account's contacts visible in the phone's contact list.
            runCatching { ctx.contentResolver.insert(ContactsContract.Settings.CONTENT_URI, android.content.ContentValues().apply {
                put(ContactsContract.Settings.ACCOUNT_NAME, acc.name); put(ContactsContract.Settings.ACCOUNT_TYPE, acc.type)
                put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1) }) }
        }
        val p = prefs(ctx)
        val mine = p.all.mapNotNull { (k, v) -> runCatching { k to json.decodeFromString<Mine>(v as String) }.getOrNull() }.toMap().toMutableMap()
        val cr = ctx.contentResolver
        val asAdapter = RawContacts.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build()
        // 1. Rep edits on the phone → Closer OS (name, email; a new number becomes an extra number on the lead).
        for (r in rows) {
            val m = mine[r.id] ?: continue
            val now = readContact(ctx, m.raw) ?: continue
            if (now.first.isNotBlank() && now.first != m.name && now.first != displayName(r)) runCatching {
                Backend.client.postgrest.rpc("update_lead_details", buildJsonObject { put("p_lead", r.id); put("p", buildJsonObject { put("name", now.first) }) })
            }
            if (!now.second.isNullOrBlank() && now.second != m.email && now.second != r.email) runCatching {
                Backend.client.postgrest.rpc("update_lead_details", buildJsonObject { put("p_lead", r.id); put("p", buildJsonObject { put("email", now.second) }) })
            }
            val ph = now.third
            if (!ph.isNullOrBlank() && ph.filter { it.isDigit() }.takeLast(10) != m.phone.filter { it.isDigit() }.takeLast(10)) runCatching {
                Backend.client.postgrest.rpc("set_lead_contact", buildJsonObject { put("p_lead", r.id)
                    put("p", buildJsonObject { put("kind", "phone"); put("op", "add"); put("value", ph); put("label", "Secondary") }) })
            }
        }
        // 2. Closer OS → phone: add new, update changed, remove the ones no longer mine.
        val want = rows.filter { it.phone.isNotBlank() }.associateBy { it.id }
        val ops = ArrayList<ContentProviderOperation>()
        fun flush() { if (ops.isNotEmpty()) { cr.applyBatch(ContactsContract.AUTHORITY, ops); ops.clear() } }
        for ((id, m) in mine.toList()) if (id !in want) {
            ops += ContentProviderOperation.newDelete(asAdapter).withSelection("${RawContacts._ID}=?", arrayOf(m.raw.toString())).build()
            mine.remove(id); if (ops.size >= 200) flush()
        }
        flush()
        val edit = p.edit()
        mine.keys.toList().forEach { if (it !in want) edit.remove(it) }
        for (r in want.values) {
            val name = displayName(r); val company = companyLine(r, zone); val buyer = buyerLine(r, zone); val note = noteLine(r, zone)
            val hash = listOf(name, r.phone, r.email, company, buyer, note).hashCode()
            val m = mine[r.id]
            if (m != null && m.hash == hash) continue
            if (m != null) {   // changed: rewrite its details (the rep's name edit was already sent back above)
                cr.delete(ContactsContract.Data.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build(),
                    "${ContactsContract.Data.RAW_CONTACT_ID}=?", arrayOf(m.raw.toString()))
                writeData(ctx, m.raw, name, r.phone, r.email, company, buyer, note)
                edit.putString(r.id, json.encodeToString(Mine(m.raw, hash, name, r.email, r.phone)))
            } else {
                val raw = insert(ctx, r.id, name, r.phone, r.email, company, buyer, note) ?: continue
                edit.putString(r.id, json.encodeToString(Mine(raw, hash, name, r.email, r.phone)))
            }
        }
        edit.apply()
    }

    private fun insert(ctx: Context, leadId: String, name: String, phone: String, email: String?, company: String, buyer: String?, note: String?): Long? {
        val acc = account(ctx)
        val uri = ctx.contentResolver.insert(RawContacts.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build(),
            android.content.ContentValues().apply {
                put(RawContacts.ACCOUNT_NAME, acc.name); put(RawContacts.ACCOUNT_TYPE, acc.type); put(RawContacts.SOURCE_ID, leadId) }) ?: return null
        val raw = android.content.ContentUris.parseId(uri)
        writeData(ctx, raw, name, phone, email, company, buyer, note)
        return raw
    }

    private fun writeData(ctx: Context, raw: Long, name: String, phone: String, email: String?, company: String, buyer: String?, note: String?) {
        val ops = ArrayList<ContentProviderOperation>()
        val data = ContactsContract.Data.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build()
        fun row(mime: String, vararg kv: Pair<String, Any?>) {
            ops += ContentProviderOperation.newInsert(data).withValue(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(ContactsContract.Data.MIMETYPE, mime).apply { kv.forEach { (k, v) -> withValue(k, v) } }.build()
        }
        row(CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, CommonDataKinds.StructuredName.DISPLAY_NAME to name)
        row(CommonDataKinds.Phone.CONTENT_ITEM_TYPE, CommonDataKinds.Phone.NUMBER to phone, CommonDataKinds.Phone.TYPE to CommonDataKinds.Phone.TYPE_MOBILE)
        if (!email.isNullOrBlank()) row(CommonDataKinds.Email.CONTENT_ITEM_TYPE, CommonDataKinds.Email.ADDRESS to email, CommonDataKinds.Email.TYPE to CommonDataKinds.Email.TYPE_WORK)
        if (company.isNotBlank() || buyer != null) row(CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
            CommonDataKinds.Organization.COMPANY to company.ifBlank { null }, CommonDataKinds.Organization.TITLE to buyer)
        if (note != null) row(CommonDataKinds.Note.CONTENT_ITEM_TYPE, CommonDataKinds.Note.NOTE to note)
        ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
    }

    /** name, email, phone as the contact now stands on the phone (the rep may have edited them). */
    private fun readContact(ctx: Context, raw: Long): Triple<String, String?, String?>? = runCatching {
        var name = ""; var email: String? = null; var phone: String? = null; var found = false
        ctx.contentResolver.query(ContactsContract.Data.CONTENT_URI, arrayOf(ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1),
            "${ContactsContract.Data.RAW_CONTACT_ID}=?", arrayOf(raw.toString()), null)?.use { c ->
            while (c.moveToNext()) { found = true
                when (c.getString(0)) {
                    CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> name = c.getString(1).orEmpty()
                    CommonDataKinds.Email.CONTENT_ITEM_TYPE -> if (email == null) email = c.getString(1)
                    CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> if (phone == null) phone = c.getString(1)
                }
            }
        }
        if (found) Triple(name, email, phone) else null
    }.getOrNull()

    /** Sign-out / removed from the company: every Closer OS contact goes (removing the account removes its contacts). */
    fun removeAll(ctx: Context) {
        runCatching { AccountManager.get(ctx).getAccountsByType(accountType(ctx)).forEach { AccountManager.get(ctx).removeAccountExplicitly(it) } }
        runCatching { prefs(ctx).edit().clear().apply() }
        runCatching { com.closeros.app.data.LocalDb.get(ctx).put("contact_rows", "[]") }
    }
}

/** Android needs an "account" behind the Closer OS contacts list; this one has no password and no sign-in of its own. */
class ContactsAuthService : Service() {
    private val auth by lazy { object : AbstractAccountAuthenticator(this) {
        override fun editProperties(r: AccountAuthenticatorResponse?, t: String?) = null
        override fun addAccount(r: AccountAuthenticatorResponse?, t: String?, a: String?, f: Array<out String>?, o: Bundle?) = null
        override fun confirmCredentials(r: AccountAuthenticatorResponse?, a: Account?, o: Bundle?) = null
        override fun getAuthToken(r: AccountAuthenticatorResponse?, a: Account?, t: String?, o: Bundle?) = null
        override fun getAuthTokenLabel(t: String?) = null
        override fun updateCredentials(r: AccountAuthenticatorResponse?, a: Account?, t: String?, o: Bundle?) = null
        override fun hasFeatures(r: AccountAuthenticatorResponse?, a: Account?, f: Array<out String>?) = null
    } }
    override fun onBind(intent: Intent?): IBinder? = auth.iBinder
}

/** Lets the phone's Contacts app show the "Closer OS" list; the real updates come from PhoneContacts.sync. */
class ContactsSyncService : Service() {
    private val adapter by lazy { object : AbstractThreadedSyncAdapter(this, false) {
        override fun onPerformSync(a: Account?, e: Bundle?, au: String?, p: ContentProviderClient?, r: SyncResult?) {}
    } }
    override fun onBind(intent: Intent?): IBinder? = adapter.syncAdapterBinder
}
