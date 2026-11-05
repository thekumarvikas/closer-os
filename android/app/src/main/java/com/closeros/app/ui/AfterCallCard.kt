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
    // While the call-log entry is still being read (first second), assume an outcome is needed.
    // Every call is treated alike: leads and numbers not in the lead list get the same outcome step.
    val needs = (lead != null || !info.checking) && (c == null || AfterCall.needsOutcome(c))
    val notInList = lead == null && !info.checking
    val number = info.number.orEmpty()
    val choices = outcomesFor(co.outcomes, info.purpose, c?.direction, c?.durationSec)
    var outcome by remember { mutableStateOf<Outcome?>(null) }
    // The call's details arrive a moment later: drop a choice that no longer fits this kind of call.
    LaunchedEffect(choices) { if (outcome != null && choices.none { it.id == outcome?.id }) outcome = null }
    var next by remember { mutableStateOf<ZonedDateTime?>(null) }
    var noFollow by remember { mutableStateOf(false) }
    // Each outcome suggests its next step (e.g. Busy → in 1 hour, Not interested → no follow-up).
    LaunchedEffect(outcome) {
        val o = outcome ?: return@LaunchedEffect
        val opts = quickTimes(zone)
        when (o.next_default) {
            "none" -> { noFollow = true; next = null }
            "30d" -> { noFollow = false; next = ZonedDateTime.now(zone).toLocalDate().plusDays(30).atTime(11, 0).atZone(zone) }
            null, "pick" -> { noFollow = false; next = null }
            else -> opts.firstOrNull { it.first == o.next_default }?.let { noFollow = false; next = it.third }
        }
    }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Step 2 after saving (or the WhatsApp button): pick a message right on the card.
    var savedLine by remember { mutableStateOf<String?>(null) }
    var waStep by remember { mutableStateOf(false) }
    var sendingWa by remember { mutableStateOf(false) }
    val maxH = (LocalConfiguration.current.screenHeightDp * 0.8f).dp

    fun open(i: Intent) { onClose(); com.closeros.app.calls.safeStart(ctx, i) }
    fun fullForm(mode: String) {
        if (c == null) { Toast.makeText(ctx, "One moment…", Toast.LENGTH_SHORT).show(); return }
        open(afterCallIntent(ctx, info, mode))
    }

    Column(Modifier.padding(horizontal = 12.dp).fillMaxWidth().heightIn(max = maxH)
        .shadow(16.dp, RoundedCornerShape(20.dp)).background(Color.White, RoundedCornerShape(20.dp))) {
        // Header: who, and how the call went.
        Column(Modifier.fillMaxWidth().background(Brand.primary, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Closer OS · call ended", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = Color.White) }
            }
            Text(lead?.name?.ifBlank { null } ?: info.contactName ?: number.ifBlank { null }?.let(::fmtPhone) ?: "Call ended", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(if ((lead?.name.isNullOrBlank() && info.contactName == null) || number.isBlank()) null else fmtPhone(number), c?.let(::callLine) ?: "Call ended", c?.simLabel).joinToString(" · "),
                color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp)
            if (notInList) Text(if (info.lookupFailed) "Couldn't check the lead list (no internet)" else "Not in lead list",
                color = Color.White, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)
                    .background(Color.White.copy(alpha = 0.2f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 3.dp))
            lead?.let { l ->
                val about = listOfNotNull(callsLine(l.dial_count, l.conversation_count), l.profession, l.company, l.city).filter { it.isNotBlank() }.joinToString(" · ")
                if (about.isNotBlank()) Text(about, color = Color.White.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                l.key_facts?.takeIf { it.isNotBlank() }?.let { Text("📌 $it", color = Color(0xFFFDE68A), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }

        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                waStep -> WhatsAppStep(info, savedLine, sendingWa, onSending = { sendingWa = it }, onEdit = { fullForm("whatsapp") }, onClose = onClose)
                needs -> {
                    Text("Outcome", fontWeight = FontWeight.SemiBold)
                    if (choices.isEmpty()) Text("Open the full form to save the outcome.", color = Brand.muted, fontSize = 14.sp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        choices.forEach { o -> PopChip(o.label, outcome?.id == o.id) { outcome = o } }
                    }
                    Text("Next call", fontWeight = FontWeight.SemiBold)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        quickTimes(zone).forEach { (_, label, t) -> PopChip(label, !noFollow && next == t) { next = t; noFollow = false } }
                        PopChip("No follow-up", noFollow) { noFollow = true; next = null }
                        PopChip("Other time…", false) { fullForm(if (lead == null) "add" else "outcome") }
                    }
                    error?.let { Text(it, color = Brand.red, fontSize = 13.sp) }
                    val sale = outcome?.form == "sale"
                    Button(onClick = {
                        val o = outcome ?: return@Button
                        if (sale) { fullForm(if (lead == null) "add" else "outcome"); return@Button }
                        saving = true; error = null
                        scope.launch {
                            val r = saveQuick(ctx, info, lead, o, next, noFollow)
                            saving = false
                            // Saved: step 2 on the same card — send a WhatsApp message, or close and dial the next.
                            if (r == null) {
                                savedLine = "✓ Saved: ${o.label} · " + (if (noFollow) "no follow-up" else next?.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a")) ?: "")
                                waStep = true
                            } else error = r
                        }
                    }, enabled = c != null && !saving && outcome != null && (noFollow || next != null), modifier = Modifier.fillMaxWidth().height(50.dp)) {
                        Text(when { saving -> "Saving…"; sale -> "Continue — add the amount"; else -> "Save" }, fontSize = 16.sp)
                    }
                    TextButton(onClick = { fullForm(if (lead == null) "add" else "outcome") }, modifier = Modifier.fillMaxWidth()) {
                        Text(if (lead == null) "Add with name & details" else "More options (notes, other date, amount)") }
                    if (notInList) PersonalButtons(number, co.prefix, onClose)
                    if (notInList) Text("Saving adds this number to your leads, so the next call is reminded.", fontSize = 12.sp, color = Brand.muted)
                }
                lead == null && info.checking -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp))
                    Text("Checking if this number is a lead…", color = Brand.muted, fontSize = 14.sp)
                }
                lead != null -> Text(if (c?.direction == "missed" || c?.direction == "rejected") "Missed call from your lead — call back?" else "Call with your lead.",
                    color = Brand.muted, fontSize = 14.sp)
                else -> {
                    Text(if (c?.direction == "missed" || c?.direction == "rejected") "Missed call — call back?" else "Call ended.", color = Brand.muted, fontSize = 14.sp)
                    OutlinedButton(onClick = { fullForm("add") }, modifier = Modifier.fillMaxWidth()) { Text("+ Add as a lead") }
                    PersonalButtons(number, co.prefix, onClose)
                }
            }
        }

        // Quick actions, like a caller-ID card.
        HorizontalDivider(color = Color(0xFFE2E8F0))
        if (number.isNotBlank()) Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            Action("📞", "Call") {
                onClose()
                val sim = PhoneCalls.sims(ctx).firstOrNull { it.slot == c?.simSlot }
                PhoneCalls.call(ctx, number, sim)
            }
            Action("💬", "WhatsApp") { waStep = true }
            Action("✉️", "SMS") { onClose(); PhoneCalls.sms(ctx, number) }
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

/** One-tap next-call times on the card (same order as the app): in 30 min / 1 / 2 / 3 h, today 6 PM, tomorrow, day after. */
private fun quickTimes(zone: ZoneId): List<Triple<String, String, ZonedDateTime>> {
    val now = ZonedDateTime.now(zone).withSecond(0).withNano(0)
    val today = now.toLocalDate()
    val out = mutableListOf(Triple("30m", "In 30 min", now.plusMinutes(30)), Triple("1h", "1 hour", now.plusHours(1)),
        Triple("2h", "2 hours", now.plusHours(2)), Triple("3h", "3 hours", now.plusHours(3)))
    val evening = today.atTime(18, 0).atZone(zone)
    if (evening.isAfter(now.plusMinutes(90))) out += Triple("today", "Today 6 PM", evening)
    out += Triple("tomorrow", "Tomorrow 11 AM", today.plusDays(1).atTime(11, 0).atZone(zone))
    val d2 = today.plusDays(2)
    out += Triple("2d", "${d2.format(DateTimeFormatter.ofPattern("EEE"))} 11 AM", d2.atTime(11, 0).atZone(zone))
    return out
}

/** Saves from the card. Returns null when saved (or kept on the phone to send later), else the reason it can't be saved. */
private suspend fun saveQuick(ctx: Context, info: AfterCall.Info, lead: Lead?, o: Outcome, next: ZonedDateTime?, noFollow: Boolean): String? {
    val c = info.call ?: return "One moment — still reading the call"
    val co = info.co
    val store = LocalStore(ctx)
    val payload = buildJsonObject {
        put("id", c.id); put("org_id", co.orgId)
        // Not in the lead list yet: the server adds it as a lead (named after the phone contact).
        if (lead != null) put("lead_id", lead.id) else { put("create_lead", true); info.contactName?.let { put("lead_name", it) } }
        put("phone", lead?.phone ?: com.closeros.app.ui.normalizePhone(c.phone, co.prefix)); put("direction", c.direction); put("purpose", info.purpose)
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
    if (sent.isSuccess) com.closeros.app.data.AppEvents.bumpLeads()   // Leads tab + call history refresh now
    if (info.appCall != null && store.pendingCall == info.appCall) store.pendingCall = null   // the app won't ask again
    AfterCall.cancelNotification(ctx)
    CallSync.syncNow(ctx)
    return null
}

fun afterCallIntent(ctx: Context, info: AfterCall.Info, mode: String): Intent {
    val c = requireNotNull(info.call); val lead = info.lead
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

/** Step 2: the company's and the rep's WhatsApp messages, one tap to send (with any attached file). */
@Composable
private fun WhatsAppStep(info: AfterCall.Info, savedLine: String?, sending: Boolean, onSending: (Boolean) -> Unit, onEdit: () -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val co = info.co
    val number = info.number.orEmpty()
    val lead = info.lead ?: Lead(id = "", org_id = co.orgId, phone = number)
    val company = co.templates.filter { it.owner_id == null }
    val mine = co.templates.filter { it.owner_id != null }
    fun send(t: com.closeros.app.data.Template) {
        val text = fillTemplateText(t.body, lead, co.name, co.timezone, co.repName)
        // Counted only after the rep confirms it went (asked next time Closer OS is open).
        LocalStore(ctx).addWaPending(LocalStore.WaPending(java.util.UUID.randomUUID().toString(), lead.id.ifBlank { null }, number,
            lead.name.ifBlank { info.contactName ?: "" }, t.id, t.name, "popup", System.currentTimeMillis()))
        val path = t.media_path
        if (path == null) { onClose(); PhoneCalls.whatsapp(ctx, number, text); return }
        onSending(true)
        scope.launch {
            runCatching {
                val f = Repo.templateMediaFile(ctx, path, t.media_name)
                val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
                PhoneCalls.whatsappMedia(ctx, number, uri, t.media_type ?: "*/*", text)
            }.onFailure { Toast.makeText(ctx, "Couldn't get the attachment — sending the text only", Toast.LENGTH_SHORT).show(); PhoneCalls.whatsapp(ctx, number, text) }
            onSending(false); onClose()
        }
    }
    savedLine?.let { Text(it, color = Brand.green, fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
    Text("Send a WhatsApp message?", fontWeight = FontWeight.SemiBold)
    if (sending) Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)); Text("Getting the attachment…", fontSize = 14.sp, color = Brand.muted)
    }
    if (co.templates.isEmpty()) Text("No saved messages yet — tap \"Write a message\".", color = Brand.muted, fontSize = 14.sp)
    listOf("Company messages" to company, "My messages" to mine).forEach { (title, list) ->
        if (list.isNotEmpty()) Text(title, fontSize = 12.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold)
        list.forEach { t ->
            Column(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(12.dp)).clickable(enabled = !sending) { send(t) }.padding(12.dp)) {
                Text((if (t.media_path != null) "📎 " else "") + t.name, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(fillTemplateText(t.body, lead, co.name, co.timezone, co.repName), fontSize = 13.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onEdit, enabled = !sending, modifier = Modifier.weight(1f)) { Text("✏️ Write / edit · 📁 files", fontSize = 13.sp) }
        Button(onClick = onClose, enabled = !sending, modifier = Modifier.weight(1f)) { Text("Close") }
    }
}

/** For numbers not in the lead list: close for a personal call, or never ask again for this number. */
@Composable
private fun PersonalButtons(number: String, prefix: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onClose, modifier = Modifier.weight(1f)) { Text("Personal call — skip", fontSize = 13.sp) }
        OutlinedButton(onClick = {
            LocalStore(ctx).addPersonalNumber(com.closeros.app.ui.normalizePhone(number, prefix))
            Toast.makeText(ctx, "Won't ask again for this number", Toast.LENGTH_SHORT).show(); onClose()
        }, modifier = Modifier.weight(1f)) { Text("Never ask for this number", fontSize = 13.sp) }
    }
}
