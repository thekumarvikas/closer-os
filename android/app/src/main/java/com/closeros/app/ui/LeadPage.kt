package com.closeros.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.CallRow
import com.closeros.app.data.Lead
import com.closeros.app.data.parseInstant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Calls with this number: the larger of the server's count and the phone's own whole call history. */
data class LeadNumbers(val calls: Int, val dialled: Int, val received: Int, val conversations: Int, val talkSec: Int, val wa: Int)

@Composable
fun rememberLeadNumbers(lead: Lead): LeadNumbers {
    val ctx = LocalContext.current
    var ph by remember(lead.id) { mutableStateOf<PhoneCalls.NumberStats?>(null) }
    LaunchedEffect(lead.id) { ph = withContext(Dispatchers.IO) { runCatching { PhoneCalls.statsFor(ctx, lead.phone) }.getOrNull() } }
    val p = ph
    val dialled = maxOf(lead.dial_count, p?.dialled ?: 0)
    val received = maxOf((lead.call_count - lead.dial_count).coerceAtLeast(0), p?.received ?: 0)
    return LeadNumbers(maxOf(lead.call_count, p?.calls ?: 0, dialled + received), dialled, received,
        maxOf(lead.conversation_count, p?.conversations ?: 0), maxOf(lead.total_talk_sec, p?.talkSec ?: 0), lead.wa_count)
}

fun LeadNumbers.line(): String = if (calls == 0 && wa == 0) "📞 Not called yet" else listOfNotNull(
    "📞 $calls call${if (calls == 1) "" else "s"}" + (if (calls > 0) " ($dialled dialled · $received received)" else ""),
    conversations.takeIf { it > 0 }?.let { "$it conversation${if (it == 1) "" else "s"}" },
    talkSec.takeIf { it > 0 }?.let { "${fmtDur(it)} talk" },
    wa.takeIf { it > 0 }?.let { "$it WhatsApp" },
).joinToString(" · ")

/** The one line of numbers on the lead page. */
@Composable
fun LeadStatsLine(vm: AppViewModel, lead: Lead) {
    val n = rememberLeadNumbers(lead)
    Text(n.line(), fontSize = 14.sp, color = Brand.primaryDark, fontWeight = FontWeight.Medium)
}

/** One tap: the lead's details, last call (outcome + purpose), notes and next follow-up — ready to paste for a senior. */
fun copyLead(ctx: Context, vm: AppViewModel, l: Lead, calls: List<CallRow>) {
    val tz = runCatching { ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata") }.getOrDefault(ZoneId.systemDefault())
    val f = DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(tz)
    fun at(iso: String?) = iso?.let { runCatching { f.format(parseInstant(it)) }.getOrNull() }
    val outcomes = vm.outcomes.associateBy { it.id }
    val stats = runCatching { PhoneCalls.statsFor(ctx, l.phone) }.getOrNull()
    val nCalls = maxOf(l.call_count, stats?.calls ?: 0); val nConv = maxOf(l.conversation_count, stats?.conversations ?: 0)
    val talk = maxOf(l.total_talk_sec, stats?.talkSec ?: 0)
    val last = calls.firstOrNull { it.outcome_id != null } ?: calls.firstOrNull()
    val notes = calls.mapNotNull { c -> c.notes?.takeIf { it.isNotBlank() }?.let { (at(c.started_at)?.let { t -> "$t: " } ?: "") + it.trim() } }.take(3)
        .ifEmpty { listOfNotNull(l.last_note?.takeIf { it.isNotBlank() }) }
    val text = buildString {
        appendLine("Lead: ${l.name.ifBlank { "—" }} · ${fmtPhone(l.phone)}")
        listOfNotNull(l.profession, l.company, l.city, l.state).filter { it.isNotBlank() }.joinToString(" · ").takeIf { it.isNotEmpty() }?.let { appendLine(it) }
        listOfNotNull(l.source, l.campaign).filter { it.isNotBlank() }.joinToString(" · ").takeIf { it.isNotEmpty() }?.let { appendLine("Source: $it") }
        if (!l.email.isNullOrBlank()) appendLine("Email: ${l.email}")
        last?.let { c ->
            val purpose = when (c.purpose) { "reminder" -> "Reminder call"; "sales" -> "Sales call"; else -> null }
            appendLine("Last call: " + listOfNotNull(at(c.started_at), purpose, outcomes[c.outcome_id]?.label,
                if (c.duration_sec > 0) "talked ${fmtDur(c.duration_sec)}" else "not answered").joinToString(" · "))
        } ?: l.last_outcome_id?.let { appendLine("Last outcome: ${outcomes[it]?.label ?: "—"}") }
        if (notes.isNotEmpty()) { appendLine("Notes:"); notes.forEach { appendLine("• $it") } }
        l.key_facts?.takeIf { it.isNotBlank() }?.let { appendLine("Key facts: $it") }
        l.pinned.map { it.text }.filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.let { appendLine("Pinned: " + it.joinToString(" | ")) }
        appendLine("Next follow-up: " + (at(l.next_follow_up_at) ?: "not planned"))
        append("Calls: $nCalls" + (if (nConv > 0) " ($nConv conversations" + (if (talk > 0) " · ${fmtDur(talk)} talk" else "") + ")" else ""))
    }
    val cm = ctx.getSystemService(ClipboardManager::class.java)
    cm?.setPrimaryClip(ClipData.newPlainText("Lead details", text))
    Toast.makeText(ctx, "Lead details copied — paste them anywhere", Toast.LENGTH_SHORT).show()
}
