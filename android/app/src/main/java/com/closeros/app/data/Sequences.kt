package com.closeros.app.data

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.closeros.app.MainActivity
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.storage.storage
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.LocalTime

/**
 * WhatsApp sequences: a set of messages sent to a lead over days (Day 0, Day 2, Day 5… or around an event).
 * The server plans what is due when; the app sends them one tap per lead through the WhatsApp queue.
 */
@Serializable data class SeqMessage(
    val id: String? = null, val position: Int = 0,
    /** start = days after the lead joined (+ time of day) · event = minutes before the event (negative = after). */
    val anchor: String = "start", val day_offset: Int = 0, val send_time: String = "10:00", val minutes_before: Int? = null,
    val body: String = "", val media_path: String? = null, val media_type: String? = null, val media_name: String? = null,
)

@Serializable data class Sequence(
    val id: String = "", val name: String = "", val owner_id: String? = null, val company: Boolean = false, val mine: Boolean = true,
    val owner_name: String? = null, val start_outcomes: List<String> = emptyList(), val messages: List<SeqMessage> = emptyList(),
    val active_mine: Int = 0, val active_all: Int = 0, val done_all: Int = 0,
)

@Serializable data class SeqDue(
    /** sequence = a message of a WhatsApp sequence · scheduled = one message scheduled for this lead. */
    val id: String, val kind: String = "sequence", val sequence_id: String? = null, val sequence: String = "", val position: Int = 1, val total: Int = 1, val due_at: String = "",
    val body: String = "", val media_path: String? = null, val media_type: String? = null, val media_name: String? = null, val lead: Lead,
) {
    /** As a message for the WhatsApp queue. */
    fun template() = Template(id = "seq:${sequence_id ?: id}:$position", name = if (kind == "scheduled") "Scheduled message" else "$sequence · message $position of $total", body = body,
        media_path = media_path, media_type = media_type, media_name = media_name)
}
@Serializable data class WaScheduled(
    val id: String, val lead_id: String? = null, val lead_name: String? = null, val phone: String? = null, val due_at: String = "",
    val body: String = "", val media_path: String? = null, val media_type: String? = null, val media_name: String? = null, val mine: Boolean = true,
)
@Serializable data class SeqStats(val active: Int = 0, val paused: Int = 0, val done: Int = 0, val stopped: Int = 0, val due_today: Int = 0,
    val sent_on_time: Int = 0, val sent_late: Int = 0, val skipped: Int = 0, val bought: Int = 0)
@Serializable data class SeqLeadRow(val id: String, val lead_id: String, val name: String = "", val phone: String = "", val status: String = "active",
    val stop_reason: String? = null, val next_pos: Int? = null, val next_due_at: String? = null, val sent_count: Int = 0,
    val started_at: String? = null, val user_id: String? = null, val user_name: String? = null, val bought: Boolean = false)
@Serializable data class SeqDetail(val stats: SeqStats = SeqStats(), val leads: List<SeqLeadRow> = emptyList(), val total: Int = 0)

@Serializable data class SeqDueList(val due: List<SeqDue> = emptyList(), val later_today: Int = 0)

@Serializable data class LeadSeq(
    val id: String, val sequence_id: String, val name: String = "", val status: String = "active", val stop_reason: String? = null,
    val next_pos: Int? = null, val next_due_at: String? = null, val sent_count: Int = 0, val total: Int = 0,
    val user_id: String? = null, val started_at: String? = null,
)

/** Free individual app: 2 sequences × 3 messages, last message by Day 7, no automatic start. Pro / company: 50 messages, Day 365. */
object SeqLimits {
    fun free(ctx: Context) = Unlocks.adsOn(ctx)
    fun maxSequences(ctx: Context) = if (free(ctx)) 2 else Int.MAX_VALUE
    fun maxMessages(ctx: Context) = if (free(ctx)) 3 else 50
    fun maxDay(ctx: Context) = if (free(ctx)) 7 else 365
}

object Seqs {
    private val db get() = Backend.client.postgrest
    fun friendly(t: Throwable): String = SafeError.forUser(t, "Something went wrong — please try again")

    suspend fun list(orgId: String): List<Sequence> =
        json.decodeFromString(Repo.savedText("srv:sequences:$orgId") { db.rpc("sequences", buildJsonObject { put("p_org", orgId) }).data })

    suspend fun save(orgId: String, p: JsonObject): String =
        db.rpc("save_sequence", buildJsonObject { put("p_org", orgId); put("p", p) }).data.trim().trim('"')

    suspend fun archive(id: String) { db.rpc("archive_sequence", buildJsonObject { put("p_id", id) }) }

    /** Returns (started, skipped). */
    suspend fun start(seqId: String, leadIds: Collection<String>, batchId: String?, how: String = "manual"): Pair<Int, Int> {
        val r = json.parseToJsonElement(db.rpc("start_sequence", buildJsonObject {
            put("p_seq", seqId); put("p_leads", buildJsonArray { leadIds.distinct().forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            batchId?.let { put("p_batch", it) }; put("p_how", how)
        }).data) as JsonObject
        return (r["started"]?.jsonPrimitive?.intOrNull ?: 0) to (r["skipped"]?.jsonPrimitive?.intOrNull ?: 0)
    }

    suspend fun setLead(id: String, action: String) { db.rpc("set_sequence_lead", buildJsonObject { put("p_id", id); put("p_action", action) }) }

    suspend fun forLead(leadId: String): List<LeadSeq> =
        json.decodeFromString(Repo.savedText("srv:lead_sequences:$leadId") { db.rpc("lead_sequences", buildJsonObject { put("p_lead", leadId) }).data })

    suspend fun due(orgId: String): SeqDueList =
        json.decodeFromString(Repo.savedText("srv:seq_due:$orgId") { db.rpc("my_sequence_due", buildJsonObject { put("p_org", orgId) }).data })

    suspend fun mark(id: String, sent: Boolean) { db.rpc("sequence_mark", buildJsonObject { put("p_id", id); put("p_sent", sent) }) }

    // ── Scheduled WhatsApp messages ──
    suspend fun scheduleWa(leadId: String, at: java.time.Instant, body: String, media: Triple<String, String, String>?, id: String? = null): String =
        db.rpc("schedule_wa", buildJsonObject {
            put("p_lead", leadId); put("p_due", at.toString()); put("p_body", body); id?.let { put("p_id", it) }
            media?.let { (p, t, n) -> put("p_media", buildJsonObject { put("path", p); put("type", t); put("name", n) }) }
        }).data.trim().trim('"')
    suspend fun markScheduled(id: String, sent: Boolean) { db.rpc("wa_scheduled_mark", buildJsonObject { put("p_id", id); put("p_sent", sent) }) }
    suspend fun myScheduled(orgId: String): List<WaScheduled> =
        json.decodeFromString(Repo.savedText("srv:my_wa_scheduled:$orgId") { db.rpc("my_wa_scheduled", buildJsonObject { put("p_org", orgId) }).data })
    suspend fun leadScheduled(leadId: String): List<WaScheduled> =
        json.decodeFromString(Repo.savedText("srv:lead_wa_scheduled:$leadId") { db.rpc("lead_wa_scheduled", buildJsonObject { put("p_lead", leadId) }).data })

    // ── Sequence details ──
    suspend fun detail(seqId: String): SeqDetail =
        json.decodeFromString(Repo.savedText("srv:sequence_detail:$seqId") { db.rpc("sequence_detail", buildJsonObject { put("p_seq", seqId) }).data })
    suspend fun setLeads(ids: Collection<String>, action: String): Int = db.rpc("set_sequence_leads", buildJsonObject {
        put("p_ids", buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }); put("p_action", action)
    }).data.trim().toIntOrNull() ?: 0

    /** A photo / video / PDF from the phone for a message (managers and individual owners): stored in the company's media. */
    suspend fun uploadMedia(ctx: Context, orgId: String, uri: Uri): Triple<String, String, String> {
        val cr = ctx.contentResolver
        val type = cr.getType(uri) ?: "application/octet-stream"
        val name = runCatching { cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } }.getOrNull()
            ?: "file"
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn't read the file")
        if (bytes.size > 16 * 1024 * 1024) error("The file is bigger than 16 MB")
        val path = "$orgId/seq/${java.util.UUID.randomUUID()}-${name.replace(Regex("[^A-Za-z0-9._-]"), "_")}"
        Backend.client.storage.from("template-media").upload(path, bytes) { upsert = false }
        return Triple(path, type, name)
    }

    /** "Day 0 · 10:00 AM" / "1 day before the event". */
    fun whenText(m: SeqMessage): String {
        if (m.anchor == "event") {
            val mb = m.minutes_before ?: 0
            val a = kotlin.math.abs(mb)
            val amount = when { a == 0 -> ""; a % 1440 == 0 -> "${a / 1440} day${if (a / 1440 > 1) "s" else ""}"; a % 60 == 0 -> "${a / 60} hour${if (a / 60 > 1) "s" else ""}"; else -> "$a min" }
            return if (mb == 0) "When the event starts" else "$amount ${if (mb > 0) "before" else "after"} the event"
        }
        val t = runCatching { LocalTime.parse(m.send_time).format(java.time.format.DateTimeFormatter.ofPattern("h:mm a")) }.getOrDefault(m.send_time)
        return "Day ${m.day_offset} · $t"
    }
}

/** One notification a day ("12 WhatsApp messages due today") at the hour the person picks (Settings). */
object SeqAlerts {
    private const val CH = "sequences"
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences("seq", Context.MODE_PRIVATE)
    /** Hour of the day for the reminder; -1 = off. */
    fun hour(ctx: Context) = p(ctx).getInt("hour", 10)
    fun setHour(ctx: Context, h: Int) = p(ctx).edit().putInt("hour", h).remove("day").apply()

    suspend fun check(ctx: Context, orgId: String) {
        val h = hour(ctx)
        if (h < 0 || LocalTime.now().hour < h) return
        val today = LocalDate.now().toString()
        if (p(ctx).getString("day", null) == today) return
        val n = Seqs.due(orgId).due.size
        p(ctx).edit().putString("day", today).apply()
        if (n == 0) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "WhatsApp sequences", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = PendingIntent.getActivity(ctx, 8810, Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("open_tab", "sequences"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notif = NotificationCompat.Builder(ctx, CH).setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("💬 $n WhatsApp message${if (n == 1) "" else "s"} due today")
            .setContentText("Tap to send them one by one").setAutoCancel(true).setContentIntent(pi).build()
        runCatching { nm.notify(8810, notif) }
    }
}

/** Scheduled WhatsApp messages: an alarm at the chosen time → "Send WhatsApp to X now" → one tap opens WhatsApp ready. */
object WaSchedAlarms {
    private const val CH = "wa_scheduled"
    private fun pi(ctx: Context, s: WaScheduled, flags: Int) = PendingIntent.getBroadcast(ctx, 7000 + (s.id.hashCode() and 0xFFFF),
        Intent(ctx, WaScheduledReceiver::class.java).putExtra("id", s.id).putExtra("name", s.lead_name.orEmpty().ifBlank { s.phone.orEmpty() })
            .putExtra("body", s.body.take(200)), flags or PendingIntent.FLAG_IMMUTABLE)

    fun scheduleAll(ctx: Context, list: List<WaScheduled>) = list.forEach { schedule(ctx, it) }

    fun schedule(ctx: Context, s: WaScheduled) {
        val at = runCatching { parseInstant(s.due_at).toEpochMilli() }.getOrNull() ?: return
        if (at < System.currentTimeMillis() - 60_000) return
        val am = ctx.getSystemService(android.app.AlarmManager::class.java)
        val p = pi(ctx, s, PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, p)
            else am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, p)
        }
    }

    fun cancel(ctx: Context, id: String) {
        val p = PendingIntent.getBroadcast(ctx, 7000 + (id.hashCode() and 0xFFFF), Intent(ctx, WaScheduledReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) ?: return
        ctx.getSystemService(android.app.AlarmManager::class.java).cancel(p)
        ctx.getSystemService(NotificationManager::class.java).cancel(7000 + (id.hashCode() and 0xFFFF))
    }

    fun notify(ctx: Context, id: String, name: String, body: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Scheduled WhatsApp messages", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(ctx, 7000 + (id.hashCode() and 0xFFFF), Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("open_tab", "wa_due"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CH).setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("💬 Send WhatsApp to $name now").setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setContentIntent(open)
            .addAction(0, "Send", open).build()
        runCatching { nm.notify(7000 + (id.hashCode() and 0xFFFF), n) }
    }
}

class WaScheduledReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        WaSchedAlarms.notify(ctx, i.getStringExtra("id") ?: return, i.getStringExtra("name").orEmpty(), i.getStringExtra("body").orEmpty())
    }
}
