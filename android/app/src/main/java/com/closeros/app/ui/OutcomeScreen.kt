package com.closeros.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.Outcome
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Shown after every call started from Closer OS. The rep must choose an outcome AND either a next
 * call time or "No follow-up needed" before calling anyone else.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OutcomeScreen(vm: AppViewModel) {
    val p = vm.pending ?: return
    val log = vm.pendingLog
    val ctx = LocalContext.current
    val zone = ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata")
    val choices = vm.outcomes.filter { it.purpose == p.purpose || it.purpose == "both" }
    var outcome by remember { mutableStateOf<Outcome?>(null) }
    var followAt by remember { mutableStateOf<ZonedDateTime?>(null) }
    var noFollow by remember { mutableStateOf(false) }
    var notes by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var product by remember { mutableStateOf("") }
    var interest by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    BackHandler { vm.message = "Save the outcome first" }

    // Quick picks for the next call; "Pick date & time" opens the normal Android pickers.
    val now = ZonedDateTime.now(zone)
    val quick = listOf(
        "In 1 hour" to now.plusHours(1),
        "Today 6 PM" to now.withHour(18).withMinute(0).withSecond(0).let { if (it.isBefore(now.plusMinutes(30))) now.plusDays(1).withHour(11).withMinute(0) else it },
        "Tomorrow 11 AM" to now.plusDays(1).withHour(11).withMinute(0).withSecond(0),
        "Tomorrow 6 PM" to now.plusDays(1).withHour(18).withMinute(0).withSecond(0),
        "In 2 days" to now.plusDays(2).withHour(11).withMinute(0).withSecond(0),
    )
    fun pickCustom() {
        val start = followAt ?: now.plusDays(1)
        DatePickerDialog(ctx, { _, y, m, d ->
            TimePickerDialog(ctx, { _, h, min -> followAt = ZonedDateTime.of(LocalDateTime.of(y, m + 1, d, h, min), zone); noFollow = false },
                start.hour, start.minute, false).show()
        }, start.year, start.monthValue - 1, start.dayOfMonth).apply { datePicker.minDate = System.currentTimeMillis() - 1000 }.show()
    }

    val canSave = outcome != null && (noFollow || followAt != null) && !busy &&
        (outcome?.form != "sale" || amount.isNotBlank())

    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("How did the call go?", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
            Column(Modifier.padding(14.dp)) {
                Text(p.leadName.ifBlank { fmtPhone(p.phone) }, fontWeight = FontWeight.SemiBold)
                Text(
                    when {
                        log == null -> "Call not found in the phone's call log yet"
                        log.durationSec > 0 -> "Talked ${fmtDur(log.durationSec)}" + (log.simLabel?.let { " · $it" } ?: "")
                        else -> "Not answered" + (log.simLabel?.let { " · $it" } ?: "")
                    }, color = Brand.muted, fontSize = 14.sp,
                )
            }
        }

        Text("Outcome", fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            choices.forEach { o -> Chip(o.label, outcome?.id == o.id) { outcome = o } }
        }

        when (outcome?.form) {
            "interest" -> {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Hot", "Warm", "Cold").forEach { Chip(it, interest == it) { interest = it } }
                }
                OutlinedTextField(amount, { amount = it.filter { c -> c.isDigit() } }, label = { Text("Potential deal value (₹)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            }
            "sale" -> {
                OutlinedTextField(amount, { amount = it.filter { c -> c.isDigit() } }, label = { Text("Amount paid (₹) *") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(product, { product = it }, label = { Text("Product / course") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        }

        Text("Next call", fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            quick.forEach { (label, t) -> Chip(label, !noFollow && followAt == t) { followAt = t; noFollow = false } }
            Chip(followAt?.takeIf { f -> quick.none { it.second == f } }?.format(DateTimeFormatter.ofPattern("dd MMM, h:mm a")) ?: "Pick date & time",
                !noFollow && followAt != null && quick.none { it.second == followAt }) { pickCustom() }
            Chip("No follow-up needed", noFollow) { noFollow = true; followAt = null }
        }

        OutlinedTextField(notes, { notes = it }, label = { Text("Notes (optional)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)

        Button(onClick = {
            busy = true
            val o = outcome!!
            val payload = buildJsonObject {
                put("id", vm.newCallId()); put("org_id", vm.membership!!.org_id); put("lead_id", p.leadId)
                put("phone", p.phone); put("direction", "outgoing"); put("purpose", p.purpose)
                p.batchId?.let { put("batch_id", it) }
                put("started_at", Instant.ofEpochMilli(log?.startedAtMs ?: p.startedAtMs).toString())
                put("duration_sec", log?.durationSec ?: 0)
                log?.simSlot?.let { put("sim_slot", it) }; log?.simLabel?.let { put("sim_label", it) }
                log?.simNumber?.let { put("sim_number", it) }
                put("device_id", PhoneCalls.deviceId(ctx)); put("from_dialer_queue", false)
                put("outcome_id", o.id)
                put("outcome_data", buildJsonObject {
                    if (amount.isNotBlank()) put(if (o.form == "sale") "amount" else "deal_value", amount.toLong())
                    if (product.isNotBlank()) put("product", product)
                    if (interest.isNotBlank()) put("interest", interest)
                })
                if (notes.isNotBlank()) put("notes", notes.trim())
                if (noFollow) put("no_follow_up", true) else put("follow_up_at", followAt!!.toInstant().toString())
            }
            vm.saveOutcome(payload) { busy = false }
        }, enabled = canSave, modifier = Modifier.fillMaxWidth().height(54.dp)) { Text(if (busy) "Saving…" else "Save", fontSize = 17.sp) }

        if (outcome == null || (!noFollow && followAt == null)) {
            Text("Choose an outcome and the next call time (or “No follow-up needed”).", fontSize = 13.sp, color = Brand.muted)
        }
        if (log == null) TextButton(onClick = { vm.discardAndContinue() }) { Text("The call didn't happen — discard") }
    }
}

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(label,
        modifier = Modifier
            .background(if (selected) Brand.primary else Color.White, RoundedCornerShape(50))
            .border(1.dp, if (selected) Brand.primary else Color(0xFFCBD5E1), RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        color = if (selected) Color.White else Color(0xFF1E293B), fontSize = 14.sp)
}
