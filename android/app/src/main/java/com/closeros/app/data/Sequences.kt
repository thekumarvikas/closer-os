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
    val id: String, val sequence_id: String, val sequence: String = "", val position: Int = 1, val total: Int = 1, val due_at: String = "",
    val body: String = "", val media_path: String? = null, val media_type: String? = null, val media_name: String? = null, val lead: Lead,
) {
    /** As a message for the WhatsApp queue. */
    fun template() = Template(id = "seq:$sequence_id:$position", name = "$sequence · message $position of $total", body = body,
        media_path = media_path, media_type = media_type, media_name = media_name)
}
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
    private fun err(t: Throwable) = t.message.orEmpty().let { m ->
        Regex("\"message\":\"([^\"]+)\"").find(m)?.groupValues?.get(1) ?: m.substringAfter("ERROR:", m).substringBefore('\n').trim().take(160)
    }
    fun friendly(t: Throwable): String = if (Net.isNetworkError(t) || !Net.isOnline) "No internet — try again when you're online" else err(t)

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

/** One notification a day ("📨 12 WhatsApp messages due today") at the hour the person picks (Settings). */
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
            .setContentTitle("📨 $n WhatsApp message${if (n == 1) "" else "s"} due today")
            .setContentText("Tap to send them one by one").setAutoCancel(true).setContentIntent(pi).build()
        runCatching { nm.notify(8810, notif) }
    }
}
