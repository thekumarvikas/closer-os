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
fun OutcomeScreen(vm: AppViewModel, popup: Boolean = false) {
    val p = vm.pending ?: return
    val log = vm.pendingLog
    val ctx = LocalContext.current
    val zone = ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata")
    val choices = outcomesFor(vm.outcomes, p.purpose, log?.direction, log?.durationSec)
    var outcome by remember { mutableStateOf<Outcome?>(null) }
    var followAt by remember { mutableStateOf<ZonedDateTime?>(null) }
    var noFollow by remember { mutableStateOf(false) }
    var notes by remember { mutableStateOf("") }
    var noteTags by remember { mutableStateOf(emptyList<String>()) }
    var lead by remember { mutableStateOf<com.closeros.app.data.Lead?>(null) }
    LaunchedEffect(p.leadId) { lead = runCatching { com.closeros.app.data.Repo.lead(p.leadId) }.getOrNull() }
    var amount by remember { mutableStateOf("") }
    var product by remember { mutableStateOf("") }
    var interest by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var profession by remember { mutableStateOf(p.profession.orEmpty()) }
    var categoryId by remember { mutableStateOf(p.categoryId) }
    val askProfession = p.batchId != null || p.profession.isNullOrBlank()
    if (!popup) BackHandler { vm.message = "Save the outcome first" }
    // Saved on the laptop instead? This screen closes by itself.
    LaunchedEffect(p) { while (true) { kotlinx.coroutines.delay(4_000); vm.checkOutcomeSavedElsewhere() } }

    // Next call in two taps: a day, then a time (30-minute slots). "In 1 hour" is one tap.
    val now = ZonedDateTime.now(zone)
    val today = now.toLocalDate()
    var day by remember { mutableStateOf<java.time.LocalDate?>(null) }
    fun slotsFor(d: java.time.LocalDate): List<ZonedDateTime> = (0 until 26).map { i -> d.atTime(9, 0).plusMinutes(30L * i).atZone(zone) }
        .filter { it.isAfter(now.plusMinutes(10)) }
    fun pickOtherDate() {
        val start = day ?: today.plusDays(3)
        DatePickerDialog(ctx, { _, y, m, d -> day = java.time.LocalDate.of(y, m + 1, d); followAt = null; noFollow = false },
            start.year, start.monthValue - 1, start.dayOfMonth).apply { datePicker.minDate = System.currentTimeMillis() - 1000 }.show()
    }
    fun pickOtherTime() {
        val d = day ?: today
        TimePickerDialog(ctx, { _, h, min -> followAt = d.atTime(h, min).atZone(zone); noFollow = false }, now.hour + 1, 0, false).show()
    }

    val canSave = outcome != null && (noFollow || followAt != null) && !busy &&
        (outcome?.form != "sale" || amount.isNotBlank())

    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!popup) Text("How did the call go?", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
            Column(Modifier.padding(14.dp)) {
                Text(p.leadName.ifBlank { fmtPhone(p.phone) }, fontWeight = FontWeight.SemiBold)
                Text(
                    when {
                        log == null -> "Call not found in the phone's call log yet"
                        log.direction == "incoming" -> "Received call · talked ${fmtDur(log.durationSec)}" + (log.simLabel?.let { " · $it" } ?: "")
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

        if (askProfession && vm.categories.isNotEmpty()) {
            Text("Profession", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(profession, { profession = it }, label = { Text("What do they do? e.g. civil engineer, shop owner") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                vm.categories.forEach { c -> Chip(c.name, categoryId == c.id) { categoryId = if (categoryId == c.id) null else c.id } }
            }
        }

        Text("Next call", fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val inHour = now.plusHours(1).withSecond(0).withNano(0)
            Chip("In 1 hour", !noFollow && followAt == inHour) { followAt = inHour; day = null; noFollow = false }
            if (slotsFor(today).isNotEmpty()) Chip("Today", day == today && !noFollow) { day = today; followAt = null; noFollow = false }
            Chip("Tomorrow", day == today.plusDays(1) && !noFollow) { day = today.plusDays(1); followAt = null; noFollow = false }
            Chip(today.plusDays(2).format(DateTimeFormatter.ofPattern("EEE d MMM")), day == today.plusDays(2) && !noFollow) { day = today.plusDays(2); followAt = null; noFollow = false }
            val other = day?.takeIf { it.isAfter(today.plusDays(2)) }
            Chip(other?.format(DateTimeFormatter.ofPattern("EEE d MMM")) ?: "Other date", other != null && !noFollow) { pickOtherDate() }
            Chip("No follow-up needed", noFollow) { noFollow = true; followAt = null; day = null }
        }
        day?.let { d ->
            Text("Time on ${d.format(DateTimeFormatter.ofPattern("EEE d MMM"))}", fontSize = 13.sp, color = Brand.muted)
            val slots = slotsFor(d)
            val listState = androidx.compose.foundation.lazy.rememberLazyListState()
            androidx.compose.foundation.lazy.LazyRow(state = listState, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(slots.size) { i -> val t = slots[i]; Chip(t.format(DateTimeFormatter.ofPattern("h:mm a")), followAt == t) { followAt = t; noFollow = false } }
                item { Chip("Other time", followAt != null && slots.none { it == followAt }) { pickOtherTime() } }
            }
        }
        followAt?.let { Text("Next call: " + it.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a")), color = Brand.primaryDark, fontWeight = FontWeight.SemiBold) }

        lead?.let { l -> KeyFactsCard(l) { t -> lead = l.copy(key_facts = t) } }
        NoteEditor(notes, { notes = it }, noteTags, { noteTags = it }, vm.membership?.organization?.noteTags.orEmpty(), "Notes from this call")

        Button(onClick = {
            val o = outcome ?: return@Button
            val m = vm.membership ?: run { vm.message = "Still loading your company — try again in a moment"; return@Button }
            val at = followAt
            if (!noFollow && at == null) return@Button
            busy = true
            val payload = buildJsonObject {
                put("id", vm.newCallId()); put("org_id", m.org_id); put("lead_id", p.leadId)
                put("phone", p.phone); put("direction", log?.direction ?: "outgoing"); put("purpose", p.purpose)
                p.batchId?.let { put("batch_id", it) }
                put("started_at", Instant.ofEpochMilli(log?.startedAtMs ?: p.startedAtMs).toString())
                put("duration_sec", log?.durationSec ?: 0)
                log?.simSlot?.let { put("sim_slot", it) }; log?.simLabel?.let { put("sim_label", it) }
                log?.simNumber?.let { put("sim_number", it) }
                put("device_id", PhoneCalls.deviceId(ctx)); put("from_dialer_queue", false)
                put("outcome_id", o.id)
                put("outcome_data", buildJsonObject {
                    amount.filter { it.isDigit() }.toLongOrNull()?.let { put(if (o.form == "sale") "amount" else "deal_value", it) }
                    if (product.isNotBlank()) put("product", product)
                    if (interest.isNotBlank()) put("interest", interest)
                    if (noteTags.isNotEmpty()) put("note_tags", kotlinx.serialization.json.JsonArray(noteTags.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                })
                if (notes.isNotBlank()) put("notes", notes.trim())
                if (profession.isNotBlank() && profession.trim() != p.profession) put("profession", profession.trim())
                if (categoryId != null && categoryId != p.categoryId) put("profession_category_id", categoryId)
                if (noFollow) put("no_follow_up", true) else at?.let { put("follow_up_at", it.toInstant().toString()) }
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

/**
 * Outcomes that make sense for this kind of call:
 *  - incoming, answered → no "no answer / busy / rejected" types (they called you)
 *  - dialled, 0 s → only "not connected" types (+ wrong number / do not call)
 *  - dialled, under 20 s → everything, "not connected" first (may have been an operator message)
 *  - dialled, 20 s or more → conversation types first, "not connected" last
 * [direction] null = not known yet (pop-up's first second): everything.
 */
fun outcomesFor(all: List<Outcome>, purpose: String, direction: String?, durationSec: Int?): List<Outcome> {
    val list = all.filter { it.is_active && (it.purpose == purpose || it.purpose == "both") }.sortedBy { it.position }
    val noContact = { o: Outcome -> o.category == "not_connected" }
    val invalid = { o: Outcome -> o.category == "invalid" }
    val talk = durationSec ?: 0
    return when {
        direction == null -> list
        direction == "incoming" -> list.filterNot(noContact)
        direction != "outgoing" -> list.filter { noContact(it) || invalid(it) }.ifEmpty { list }
        talk == 0 -> list.filter { noContact(it) || invalid(it) }.ifEmpty { list }
        talk < 20 -> list.sortedBy { if (noContact(it)) 0 else 1 }
        else -> list.sortedBy { if (noContact(it)) 1 else 0 }
    }
}
