package com.closeros.app.ui

// Lead at a glance (owner, Nov 24 2026): fact tiles on top, the best WhatsApp messages as one-tap buttons,
// and payment details (UPI / bank / this webinar's links) with Copy and Send. Same rules as the dashboard's lead drawer.

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.CallRow
import com.closeros.app.data.Intents
import com.closeros.app.data.Lead
import com.closeros.app.data.Template
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val WaGreen = Color(0xFF16A34A)

@Composable
private fun Tile(label: String, value: String?, strong: Boolean = false, modifier: Modifier = Modifier) {
    Column(modifier.background(Color(0xFFF1F5F9), RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 7.dp)) {
        Text(label, fontSize = 11.sp, color = Brand.muted, maxLines = 1)
        Text(value?.takeIf { it.isNotBlank() } ?: "—", fontSize = 14.sp, fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The facts a caller needs in 3 seconds. */
@Composable
fun LeadFactTiles(vm: AppViewModel, l: Lead, calls: List<CallRow>) {
    val org = vm.membership?.organization
    val b = l.latestBatch
    val zone = runCatching { java.time.ZoneId.of(org?.timezone ?: "Asia/Kolkata") }.getOrDefault(java.time.ZoneId.systemDefault())
    val webinar = b?.batch?.webinar_at?.let { runCatching {
        java.time.format.DateTimeFormatter.ofPattern("d MMM").withZone(zone).format(com.closeros.app.data.parseInstant(it)) }.getOrNull() }
        ?.let { "$it · " + if (b.attended) "attended" else "did not join" }
    val rem = calls.firstOrNull { it.purpose == "reminder" && it.outcome_id != null }
    val outcomes = vm.outcomes.associateBy { it.id }
    val level = listOfNotNull(Intents.of(org, l.intent)?.short, l.score.takeIf { it > 0 }?.let { "🔥 $it" }).joinToString(" · ")
    val rows = listOf(
        Triple("Profession", l.profession, false) to Triple("City / State", listOfNotNull(l.city, l.state).filter { it.isNotBlank() }.joinToString(", "), false),
        Triple("Webinar", webinar, false) to Triple("Watched", b?.watch_minutes?.takeIf { it > 0 }?.let { "$it min" }, true),
        Triple("Level · score", level, false) to Triple("Reminder call", rem?.let { outcomes[it.outcome_id]?.label ?: "done" }, false),
    )
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { (a, c) ->
            if (a.second.isNullOrBlank() && c.second.isNullOrBlank() && a.first == "Webinar") return@forEach   // no webinar row for leads without one
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Tile(a.first, a.second, a.third, Modifier.weight(1f)); Tile(c.first, c.second, c.third, Modifier.weight(1f))
            }
        }
    }
}

/** The company's / my messages as buttons: the ones meant for this lead's last call result first, the rest behind "More". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuickWaButtons(vm: AppViewModel, l: Lead, lastCall: CallRow?) {
    val all = vm.templates
    if (all.isEmpty()) return
    var more by remember { mutableStateOf(false) }
    val cat = when {
        lastCall != null && (lastCall.direction == "missed" || lastCall.direction == "rejected" || lastCall.duration_sec == 0) -> "not_connected"
        else -> vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.category
    }
    val ranked = all.sortedWith(compareByDescending<Template> { cat != null && cat in it.show_for }.thenBy { it.position })
    val shown = if (more) ranked else ranked.take(6)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("WhatsApp — tap a message", fontSize = 12.sp, color = Brand.muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            shown.forEach { t ->
                val best = cat != null && cat in t.show_for
                Text((if (best) "⭐ " else "") + t.name, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.background(WaGreen, RoundedCornerShape(50)).clickable {
                        // Opens the message box with this message filled in — files, Send and the "did it go?" check as always.
                        vm.waDraft = AppViewModel.WaDraft(l).also { d -> d.chosen = t; d.text = vm.fillTemplate(t.body, l) }
                    }.padding(horizontal = 12.dp, vertical = 7.dp))
            }
            if (ranked.size > 6) Text(if (more) "Less" else "More (${ranked.size - 6})", fontSize = 13.sp, color = Brand.muted,
                modifier = Modifier.border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(50)).clickable { more = !more }.padding(horizontal = 12.dp, vertical = 7.dp))
        }
    }
}

/** UPI / bank details (dashboard Settings → Payment details) and the webinar's payment links: Copy or Send in one tap. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PaymentRow(vm: AppViewModel, l: Lead) {
    val ctx = LocalContext.current
    val pd = vm.membership?.organization?.settings?.get("payment_details") as? JsonObject
    fun s(k: String) = (pd?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }
    val b = l.latestBatch?.batch
    val items = buildList {
        b?.pay_link?.takeIf { it.isNotBlank() }?.let { add("Full payment link" to it) }
        b?.token_link?.takeIf { it.isNotBlank() }?.let { add("Reserve-seat link" to it) }
        s("upi_id")?.let { add("UPI" to ("UPI ID: $it" + (s("payee")?.let { p -> "\nName: $p" } ?: ""))) }
        s("bank")?.let { add("Bank details" to it) }
    }
    if (items.isEmpty()) return
    val note = s("note")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Payment", fontSize = 12.sp, color = Brand.muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items.forEach { (label, text) ->
                Row(Modifier.border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(50)), verticalAlignment = Alignment.CenterVertically) {
                    Text("⧉ $label", fontSize = 13.sp, maxLines = 1, modifier = Modifier.clickable { copyText(ctx, text, "$label copied") }.padding(start = 12.dp, end = 8.dp, top = 7.dp, bottom = 7.dp))
                    Text("Send", fontSize = 13.sp, color = WaGreen, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable { PhoneCalls.whatsapp(ctx, l.phone, if (note != null) "$text\n\n$note" else text) }.padding(start = 6.dp, end = 12.dp, top = 7.dp, bottom = 7.dp))
                }
            }
        }
    }
}
