package com.closeros.app.calls

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.provider.Settings
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import java.util.UUID

/** One entry of the phone's call log. */
data class LogCall(
    val id: String, val phone: String, val direction: String, val startedAtMs: Long, val durationSec: Int,
    val simSlot: Int?, val simLabel: String?, val simNumber: String? = null,
    val channel: String = "phone", val name: String? = null,
)

data class Sim(val slot: Int, val label: String, val handle: PhoneAccountHandle?)

object PhoneCalls {
    fun has(ctx: Context, perm: String) = ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("HardwareIds")
    @Volatile private var cachedDeviceId: String? = null
    fun deviceId(ctx: Context): String = cachedDeviceId ?: (Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown").also { cachedDeviceId = it }

    // SIM details change rarely: look them up at most every 30 seconds.
    @Volatile private var simCache: Pair<Long, List<Sim>>? = null
    @Volatile private var subCache: Pair<Long, List<android.telephony.SubscriptionInfo>>? = null
    @SuppressLint("MissingPermission")
    private fun subs(ctx: Context): List<android.telephony.SubscriptionInfo> {
        subCache?.let { if (System.currentTimeMillis() - it.first < 30_000) return it.second }
        val v = runCatching { ctx.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty() }.getOrDefault(emptyList())
        subCache = System.currentTimeMillis() to v
        return v
    }

    /** The same call-log entry always gets the same id, so uploads never duplicate. */
    fun stableId(ctx: Context, logId: Long, dateMs: Long): String =
        UUID.nameUUIDFromBytes("${deviceId(ctx)}|$logId|$dateMs".toByteArray()).toString()

    /** SIMs that can make calls, in slot order. */
    @SuppressLint("MissingPermission")
    fun sims(ctx: Context): List<Sim> {
        if (!has(ctx, android.Manifest.permission.READ_PHONE_STATE)) return emptyList()
        simCache?.let { if (System.currentTimeMillis() - it.first < 30_000) return it.second }
        val telecom = ctx.getSystemService(TelecomManager::class.java)
        val subs = subs(ctx)
        val handles = runCatching { telecom.callCapablePhoneAccounts }.getOrDefault(emptyList())
        return subs.sortedBy { it.simSlotIndex }.mapIndexed { i, s ->
            // Match the calling account to the SIM by subscription id where the phone exposes it.
            val handle = handles.firstOrNull { it.id == s.subscriptionId.toString() || it.id.startsWith(s.iccId ?: "\u0000") }
                ?: handles.getOrNull(i)
            Sim(s.simSlotIndex + 1, "SIM ${s.simSlotIndex + 1} · ${s.carrierName ?: s.displayName ?: ""}".trim(), handle)
        }.also { simCache = System.currentTimeMillis() to it }
    }

    /** The SIM's own number, if the phone reveals it (many phones don't — then the rep types it). */
    @SuppressLint("MissingPermission", "HardwareIds")
    fun simOwnNumber(ctx: Context, slot: Int): String? = runCatching {
        val sm = ctx.getSystemService(SubscriptionManager::class.java)
        val sub = sm.activeSubscriptionInfoList.orEmpty().firstOrNull { it.simSlotIndex + 1 == slot } ?: return null
        val n = if (android.os.Build.VERSION.SDK_INT >= 33) sm.getPhoneNumber(sub.subscriptionId) else @Suppress("DEPRECATION") sub.number
        n?.takeIf { it.filter { c -> c.isDigit() }.length >= 10 }
    }.getOrNull()

    @Volatile private var namesCache: Pair<Long, Map<String, String>>? = null

    /** All names saved in the phone's contacts, by the number's last 10 digits (read once a minute at most). */
    fun contactNames(ctx: Context): Map<String, String> {
        namesCache?.let { (at, m) -> if (System.currentTimeMillis() - at < 60_000) return m }
        if (!has(ctx, android.Manifest.permission.READ_CONTACTS)) return emptyMap()
        val m = HashMap<String, String>()
        runCatching {
            ctx.contentResolver.query(android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER, android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val d = c.getString(0)?.filter { it.isDigit() }?.takeLast(10) ?: continue
                    val n = c.getString(1)?.takeIf { it.isNotBlank() } ?: continue
                    if (d.length >= 7) m.putIfAbsent(d, n)
                }
            }
        }
        namesCache = System.currentTimeMillis() to m
        return m
    }

    /** The name saved in the phone's contacts for a number (needs contacts permission). */
    fun contactName(ctx: Context, phone: String): String? = runCatching {
        if (!has(ctx, android.Manifest.permission.READ_CONTACTS)) return null
        val uri = Uri.withAppendedPath(android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phone))
        ctx.contentResolver.query(uri, arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()?.takeIf { it.isNotBlank() }

    /** The newest few phone calls (quick: used right after a call ends). */
    fun latest(ctx: Context, limit: Int): List<LogCall> = query(ctx, 0, newestFirst = true, limit = limit)

    /** Reads the whole call log (newest first) for the Calls screen. */
    fun history(ctx: Context, limit: Int): List<LogCall> =
        (query(ctx, 0, newestFirst = true, limit = limit) + WhatsAppCalls.asLog(ctx, 0)).sortedByDescending { it.startedAtMs }.take(limit)

    /** Phone + WhatsApp calls since a time, oldest first. */
    fun readAll(ctx: Context, sinceMs: Long): List<LogCall> = (readLog(ctx, sinceMs) + WhatsAppCalls.asLog(ctx, sinceMs)).sortedBy { it.startedAtMs }

    /** Opens the SMS app with the number (and text) filled in. */
    fun sms(ctx: Context, phone: String, text: String = "") {
        safeStart(ctx, Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + phone.filter { it.isDigit() || it == '+' }))
            .putExtra("sms_body", text).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Sends a photo/video/PDF with a caption straight into the person's WhatsApp chat. */
    fun whatsappMedia(ctx: Context, phone: String, uri: Uri, mime: String, text: String) {
        val digits = phone.filter { it.isDigit() }
        val pkg = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { runCatching { ctx.packageManager.getPackageInfo(it, 0) }.isSuccess }
        val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TEXT, text)
            .putExtra("jid", "$digits@s.whatsapp.net").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        i.clipData = android.content.ClipData.newRawUri("media", uri)
        if (pkg != null) i.setPackage(pkg)
        com.closeros.app.data.WorkLog.whatsappOpened(ctx)
        safeStart(ctx, if (pkg != null) i else Intent.createChooser(i, "Send with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Starts a normal phone call on the chosen SIM. The phone's own app handles (and records) it. */
    @SuppressLint("MissingPermission")
    fun call(ctx: Context, phone: String, sim: Sim?) {
        val uri = Uri.fromParts("tel", phone, null)
        if (has(ctx, android.Manifest.permission.CALL_PHONE)) {
            val extras = Bundle()
            sim?.handle?.let { extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
            runCatching { ctx.getSystemService(TelecomManager::class.java).placeCall(uri, extras); return }
        }
        safeStart(ctx, Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun whatsapp(ctx: Context, phone: String, text: String = "") {
        val digits = phone.filter { it.isDigit() }
        val uri = Uri.parse("https://wa.me/$digits" + if (text.isNotEmpty()) "?text=${Uri.encode(text)}" else "")
        com.closeros.app.data.WorkLog.whatsappOpened(ctx)
        safeStart(ctx, Intent(Intent.ACTION_VIEW, uri), "WhatsApp isn't installed on this phone")
    }

    /** Call-log entries newer than [sinceMs], oldest first. */
    @SuppressLint("MissingPermission")
    fun readLog(ctx: Context, sinceMs: Long, limit: Int = 2000): List<LogCall> = query(ctx, sinceMs, newestFirst = false, limit = limit)

    /** Reads only the rows needed (the phone's database does the limiting), oldest or newest first. */
    @SuppressLint("MissingPermission")
    private fun query(ctx: Context, sinceMs: Long, newestFirst: Boolean, limit: Int): List<LogCall> {
        if (!has(ctx, android.Manifest.permission.READ_CALL_LOG)) return emptyList()
        val sims = sims(ctx)
        val store = com.closeros.app.data.LocalStore(ctx)
        val subs = subs(ctx)
        val out = mutableListOf<LogCall>()
        val cols = arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.PHONE_ACCOUNT_ID, CallLog.Calls.CACHED_NAME)
        // Ask for a few extra rows: some entries (voicemail etc.) are skipped below.
        val uri = CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, (limit + 50).toString()).build()
        val cursor = runCatching { ctx.contentResolver.query(uri, cols, "${CallLog.Calls.DATE} > ?", arrayOf(sinceMs.toString()), "${CallLog.Calls.DATE} ${if (newestFirst) "DESC" else "ASC"}") }
            .getOrNull() ?: ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, cols, "${CallLog.Calls.DATE} > ?", arrayOf(sinceMs.toString()), "${CallLog.Calls.DATE} ${if (newestFirst) "DESC" else "ASC"}")
        val simNumbers = HashMap<Int?, String?>()
        cursor?.use { c ->
            while (c.moveToNext() && out.size < limit) {
                val number = c.getString(1) ?: continue
                val type = c.getInt(2)
                val dir = when (type) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    CallLog.Calls.MISSED_TYPE -> "missed"
                    CallLog.Calls.REJECTED_TYPE, CallLog.Calls.BLOCKED_TYPE -> "rejected"
                    else -> continue
                }
                val accountId = c.getString(5)
                val sub = subs.firstOrNull { it.subscriptionId.toString() == accountId || (it.iccId != null && accountId?.startsWith(it.iccId) == true) }
                val sim = sub?.let { s -> sims.firstOrNull { it.slot == s.simSlotIndex + 1 } }
                val date = c.getLong(3)
                out += LogCall(
                    id = stableId(ctx, c.getLong(0), date), phone = number, direction = dir, startedAtMs = date,
                    // MIUI stores ring time as "duration" for missed calls: only answered calls have talk time.
                    durationSec = if (dir == "incoming" || dir == "outgoing") c.getInt(4) else 0,
                    simSlot = sim?.slot, simLabel = sim?.label, simNumber = simNumbers.getOrPut(sim?.slot) { store.simNumber(sim?.slot) },
                    // The name saved in the phone's contacts (the call log keeps a copy; else look it up).
                    name = c.getString(6)?.takeIf { it.isNotBlank() } ?: contactNames(ctx)[number.filter { it.isDigit() }.takeLast(10)],
                )
            }
        }
        return out
    }

    /** The call-log entry for a call Closer OS just started (same number, after the start time). */
    fun findCall(ctx: Context, phone: String, afterMs: Long): LogCall? {
        val last10 = phone.filter { it.isDigit() }.takeLast(10)
        return readLog(ctx, afterMs - 10_000).lastOrNull { it.phone.filter { ch -> ch.isDigit() }.endsWith(last10) && it.direction == "outgoing" }
    }
}

/** Opens another app or settings screen; shows a short message instead of crashing when the phone has no app for it. */
fun safeStart(ctx: android.content.Context, i: android.content.Intent, missing: String = "No app on this phone can open this") {
    try { ctx.startActivity(i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    catch (e: Exception) { android.widget.Toast.makeText(ctx, missing, android.widget.Toast.LENGTH_LONG).show() }
}
