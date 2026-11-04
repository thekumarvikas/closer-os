package com.closeros.app.ui

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.MainActivity
import com.closeros.app.calls.AfterCall
import com.closeros.app.calls.CallSync
import com.closeros.app.calls.LogCall
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.Lead
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Outcome
import com.closeros.app.data.Repo
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * The after-call pop-up (shown over any app). For a lead: tap an outcome + a next-call time + Save,
 * all on the card. "More options" opens the full form (notes, other dates, amount for a sale).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AfterCallCard(info: AfterCall.Info, onClose: () -> Unit) {
    val c = info.call; val lead = info.lead; val co = info.co
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val zone = runCatching { ZoneId.of(co.timezone) }.getOrDefault(ZoneId.systemDefault())
    val needs = lead != null && AfterCall.needsOutcome(c)
    val choices = co.outcomes.filter { it.is_active && (it.purpose == info.purpose || it.purpose == "both") }.sortedBy { it.position }
    var outcome by remember { mutableStateOf<Outcome?>(null) }
    var next by remember { mutableStateOf<ZonedDateTime?>(null) }
    var noFollow by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val maxH = (LocalConfiguration.current.screenHeightDp * 0.8f).dp

    fun open(i: Intent) { onClose(); com.closeros.app.calls.safeStart(ctx, i) }
    fun fullForm(mode: String) = open(afterCallIntent(ctx, info, mode))

    Column(Modifier.padding(horizontal = 12.dp).fillMaxWidth().heightIn(max = maxH)
        .shadow(16.dp, RoundedCornerShape(20.dp)).background(Color.White, RoundedCornerShape(20.dp))) {
        // Header: who, and how the call went.
        Column(Modifier.fillMaxWidth().background(Brand.primary, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Closer OS · call ended", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = Color.White) }
            }
            Text(lead?.name?.ifBlank { null } ?: fmtPhone(c.phone), color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(if (lead?.name.isNullOrBlank()) null else fmtPhone(c.phone), callLine(c), c.simLabel).joinToString(" · "),
                color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp)
            lead?.let { l ->
                val about = listOfNotNull(l.profession, l.company, l.city).filter { it.isNotBlank() }.joinToString(" · ")
                if (about.isNotBlank()) Text(about, color = Color.White.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                l.key_facts?.takeIf { it.isNotBlank() }?.let { Text("📌 $it", color = Color(0xFFFDE68A), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }

        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                needs -> {
                    Text("Outcome", fontWeight = FontWeight.SemiBold)
                    if (choices.isEmpty()) Text("Open the full form to save the outcome.", color = Brand.muted, fontSize = 14.sp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        choices.forEach { o -> PopChip(o.label, outcome?.id == o.id) { outcome = o } }
                    }
                    Text("Next call", fontWeight = FontWeight.SemiBold)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        quickTimes(zone).forEach { (label, t) -> PopChip(label, !noFollow && next == t) { next = t; noFollow = false } }
                        PopChip("No follow-up", noFollow) { noFollow = true; next = null }
                        PopChip("Other time…", false) { fullForm("outcome") }
                    }
                    error?.let { Text(it, color = Brand.red, fontSize = 13.sp) }
                    val sale = outcome?.form == "sale"
                    Button(onClick = {
                        val o = outcome ?: return@Button
                        if (sale) { fullForm("outcome"); return@Button }
                        saving = true; error = null
                        scope.launch {
                            val r = lead?.let { saveQuick(ctx, info, it, o, next, noFollow) } ?: "Lead not found"
                            saving = false
                            // Saved: next step is the WhatsApp message (templates + company files).
                            if (r == null) { Toast.makeText(ctx, "Outcome saved", Toast.LENGTH_SHORT).show(); fullForm("whatsapp") } else error = r
                        }
                    }, enabled = !saving && outcome != null && (noFollow || next != null), modifier = Modifier.fillMaxWidth().height(50.dp)) {
                        Text(when { saving -> "Saving…"; sale -> "Continue — add the amount"; else -> "Save" }, fontSize = 16.sp)
                    }
                    TextButton(onClick = { fullForm("outcome") }, modifier = Modifier.fillMaxWidth()) { Text("More options (notes, other date, amount)") }
                }
                lead != null -> Text(if (c.direction == "missed" || c.direction == "rejected") "Missed call from your lead — call back?" else "Call with your lead.",
                    color = Brand.muted, fontSize = 14.sp)
                info.lookupFailed -> {
                    Text("Couldn't reach Closer OS to check this number (no internet?). Open Closer OS to save the outcome.", color = Brand.muted, fontSize = 14.sp)
                    OutlinedButton(onClick = { open(Intent(ctx, MainActivity::class.java)) }, modifier = Modifier.fillMaxWidth()) { Text("Open Closer OS") }
                }
                else -> {
                    Text("Not in your leads", color = Brand.muted, fontSize = 14.sp)
                    OutlinedButton(onClick = { fullForm("add") }, modifier = Modifier.fillMaxWidth()) { Text("+ Add as a lead") }
                }
            }
        }

        // Quick actions, like a caller-ID card.
        HorizontalDivider(color = Color(0xFFE2E8F0))
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            Action("📞", "Call") {
                onClose()
                val sim = PhoneCalls.sims(ctx).firstOrNull { it.slot == c.simSlot }
                PhoneCalls.call(ctx, c.phone, sim)
            }
            Action("💬", "WhatsApp") { fullForm("whatsapp") }
            Action("✉️", "SMS") { onClose(); PhoneCalls.sms(ctx, c.phone) }
            if (lead != null) Action("👤", "Open lead") { open(Intent(ctx, MainActivity::class.java).putExtra("open_lead", lead.id)) }
        }
    }
}

private fun callLine(c: LogCall) = when {
    c.direction == "missed" -> "Missed call"
    c.direction == "rejected" -> "Declined"
    c.direction == "incoming" -> "Received · talked ${fmtDur(c.durationSec)}"
    c.durationSec > 0 -> "Talked ${fmtDur(c.durationSec)}"
    else -> "Not answered"
}

/** A handful of one-tap next-call times (the full form has every 30-minute slot). */
private fun quickTimes(zone: ZoneId): List<Pair<String, ZonedDateTime>> {
    val now = ZonedDateTime.now(zone).withSecond(0).withNano(0)
    val today = now.toLocalDate()
    val out = mutableListOf("In 1 hour" to now.plusHours(1))
    val evening = today.atTime(18, 0).atZone(zone)
    if (evening.isAfter(now.plusMinutes(90))) out += "Today 6 PM" to evening
    out += "Tomorrow 11 AM" to today.plusDays(1).atTime(11, 0).atZone(zone)
    out += "Tomorrow 6 PM" to today.plusDays(1).atTime(18, 0).atZone(zone)
    val d2 = today.plusDays(2)
    out += "${d2.format(DateTimeFormatter.ofPattern("EEE"))} 11 AM" to d2.atTime(11, 0).atZone(zone)
    return out
}

/** Saves from the card. Returns null when saved (or kept on the phone to send later), else the reason it can't be saved. */
private suspend fun saveQuick(ctx: Context, info: AfterCall.Info, lead: Lead, o: Outcome, next: ZonedDateTime?, noFollow: Boolean): String? {
    val c = info.call; val co = info.co
    val store = LocalStore(ctx)
    val payload = buildJsonObject {
        put("id", c.id); put("org_id", co.orgId); put("lead_id", lead.id)
        put("phone", lead.phone); put("direction", c.direction); put("purpose", info.purpose)
        info.appCall?.batchId?.let { put("batch_id", it) }
        put("started_at", Instant.ofEpochMilli(c.startedAtMs).toString()); put("duration_sec", c.durationSec)
        c.simSlot?.let { put("sim_slot", it) }; c.simLabel?.let { put("sim_label", it) }; c.simNumber?.let { put("sim_number", it) }
        put("device_id", PhoneCalls.deviceId(ctx)); put("from_dialer_queue", false)
        put("outcome_id", o.id); put("outcome_data", buildJsonObject { })
        if (noFollow) put("no_follow_up", true) else next?.let { put("follow_up_at", it.toInstant().toString()) }
    }
    val sent = runCatching { Repo.logCall(payload) }
    if (sent.isFailure) {
        val err = sent.exceptionOrNull()?.message.orEmpty()
        if (err.contains("next call time") || err.contains("Unknown outcome") || err.contains("Lead not found"))
            return err.substringAfter("ERROR:").trim().ifEmpty { "Couldn't save — open the full form" }
        store.addToOutbox(payload)   // no internet: sent automatically later
    }
    store.markLogged(c.id)
    if (info.appCall != null && store.pendingCall == info.appCall) store.pendingCall = null   // the app won't ask again
    AfterCall.cancelNotification(ctx)
    CallSync.syncNow(ctx)
    return null
}

fun afterCallIntent(ctx: Context, info: AfterCall.Info, mode: String): Intent {
    val c = info.call; val lead = info.lead
    return Intent(ctx, AfterCallActivity::class.java)
        .putExtra("mode", mode).putExtra("log_id", c.id).putExtra("started", c.startedAtMs).putExtra("phone", c.phone)
        .putExtra("lead_id", lead?.id).putExtra("lead_name", lead?.name).putExtra("lead_phone", lead?.phone).putExtra("profession", lead?.profession)
        .putExtra("purpose", info.purpose).putExtra("batch_id", info.appCall?.batchId).putExtra("app_call", info.appCall != null)
}

@Composable
private fun PopChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(label,
        modifier = Modifier
            .background(if (selected) Brand.primary else Color.White, RoundedCornerShape(50))
            .border(1.dp, if (selected) Brand.primary else Color(0xFFCBD5E1), RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        color = if (selected) Color.White else Color(0xFF1E293B), fontSize = 14.sp)
}

@Composable
private fun Action(icon: String, label: String, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(icon, fontSize = 22.sp)
        Text(label, fontSize = 12.sp, color = Color(0xFF334155))
    }
}
