package com.closeros.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Alignment
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
    // Reminder or sales: set by where the call came from or worked out for the lead; the rep can switch it.
    var purpose by remember(p) { mutableStateOf(p.purpose) }
    val choices = outcomesFor(vm.outcomes, purpose, log?.direction, log?.durationSec)
    var outcome by remember { mutableStateOf<Outcome?>(null) }
    // Dialled and nobody picked up (0 s): "Didn't pick" is already chosen — one tap on Save.
    LaunchedEffect(choices, log?.id) {
        if (outcome != null && choices.none { it.id == outcome?.id }) outcome = null
        if (outcome == null && log != null && log.direction == "outgoing" && log.durationSec == 0)
            outcome = choices.firstOrNull { it.code == "no_answer" || it.code == "r_didnt_pick" } ?: choices.firstOrNull { it.category == "not_connected" }
    }
    var followAt by remember { mutableStateOf<ZonedDateTime?>(null) }
    var noFollow by remember { mutableStateOf(false) }
    var notes by remember { mutableStateOf("") }
    var noteTags by remember { mutableStateOf(emptyList<String>()) }
    var factValues by remember { mutableStateOf(emptyMap<String, String>()) }
    var lead by remember { mutableStateOf<com.closeros.app.data.Lead?>(null) }
    LaunchedEffect(p.leadId) { lead = runCatching { com.closeros.app.data.Repo.lead(p.leadId) }.getOrNull() }
    // A reminder call-back must be before the webinar starts.
    val webinarAt = if (purpose == "reminder") com.closeros.app.data.CallPurpose.webinarOf(lead, p.batchId)?.takeIf { it.isAfter(Instant.now()) } else null
    fun beforeStart(t: ZonedDateTime) = webinarAt == null || t.toInstant().isBefore(webinarAt)
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
    /** Which "in X" chip is chosen (times are counted from when this screen opened). */
    var quick by remember { mutableStateOf<String?>(null) }
    val base = remember { ZonedDateTime.now(zone).withSecond(0).withNano(0) }
    // The outcome's suggested next step (set per outcome on the dashboard), e.g. Busy → in 1 hour.
    LaunchedEffect(outcome) {
        val o = outcome ?: return@LaunchedEffect
        val t = ZonedDateTime.now(zone).toLocalDate()
        quick = null; day = null; noFollow = false; followAt = null
        when (o.next_default) {
            "30m", "1h", "2h", "3h" -> quickIns.firstOrNull { it.first == o.next_default }?.let { (k, m, _) -> quick = k; followAt = base.plusMinutes(m) }
            "today" -> day = t
            "tomorrow" -> { day = t.plusDays(1); followAt = t.plusDays(1).atTime(11, 0).atZone(zone) }
            "2d" -> { day = t.plusDays(2); followAt = t.plusDays(2).atTime(11, 0).atZone(zone) }
            "30d" -> { day = t.plusDays(30); followAt = t.plusDays(30).atTime(11, 0).atZone(zone) }
            "none" -> noFollow = true
        }
        // Reminder: a suggested time after the webinar starts becomes "30 min before start".
        if (webinarAt != null && followAt?.let { !beforeStart(it) } == true) {
            val pre = webinarAt.minusSeconds(1800).atZone(zone).withSecond(0).withNano(0)
            if (pre.isAfter(ZonedDateTime.now(zone).plusMinutes(5))) { followAt = pre; quick = "prestart"; day = null } else { followAt = null; quick = null; day = null }
        }
    }
    fun slotsFor(d: java.time.LocalDate): List<ZonedDateTime> = (0 until 26).map { i -> d.atTime(9, 0).plusMinutes(30L * i).atZone(zone) }
        .filter { it.isAfter(now.plusMinutes(10)) && beforeStart(it) }
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

        // Reminder or sales call — one tap to switch (shown when the lead is in a webinar / event).
        if (lead?.batch_leads?.isNotEmpty() == true || purpose == "reminder") Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Call type", color = Brand.muted, fontSize = 14.sp)
            Chip("Sales", purpose == "sales") { if (purpose != "sales") { purpose = "sales"; outcome = null } }
            Chip("Reminder", purpose == "reminder") { if (purpose != "reminder") { purpose = "reminder"; outcome = null } }
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
        webinarAt?.let { Text("Webinar starts at ${it.atZone(zone).format(DateTimeFormatter.ofPattern("h:mm a"))} — call back before that", fontSize = 13.sp, color = Brand.muted) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // One tap: in 30 min / 1 / 2 / 3 hours. Two taps: a day, then a 30-minute slot.
            quickIns.filter { (_, mins, _) -> beforeStart(base.plusMinutes(mins)) }.forEach { (key, mins, label) ->
                Chip(label, !noFollow && quick == key) { quick = key; followAt = base.plusMinutes(mins); day = null; noFollow = false }
            }
            webinarAt?.let { w -> val pre = w.minusSeconds(1800).atZone(zone).withSecond(0).withNano(0)
                if (pre.isAfter(now.plusMinutes(5))) Chip("30 min before start (${pre.format(DateTimeFormatter.ofPattern("h:mm a"))})", !noFollow && quick == "prestart") {
                    quick = "prestart"; followAt = pre; day = null; noFollow = false } }
            if (slotsFor(today).isNotEmpty()) Chip("Today", day == today && !noFollow) { day = today; followAt = null; noFollow = false; quick = null }
            if (slotsFor(today.plusDays(1)).isNotEmpty()) Chip("Tomorrow", day == today.plusDays(1) && !noFollow) { day = today.plusDays(1); followAt = null; noFollow = false; quick = null }
            if (slotsFor(today.plusDays(2)).isNotEmpty()) Chip(today.plusDays(2).format(DateTimeFormatter.ofPattern("EEE d MMM")), day == today.plusDays(2) && !noFollow) { day = today.plusDays(2); followAt = null; noFollow = false; quick = null }
            val other = day?.takeIf { it.isAfter(today.plusDays(2)) }
            if (webinarAt == null) Chip(other?.format(DateTimeFormatter.ofPattern("EEE d MMM")) ?: "Other date", other != null && !noFollow) { pickOtherDate() }
            Chip("No follow-up", noFollow) { noFollow = true; followAt = null; day = null; quick = null }
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
        // Facts the company wants on every lead (e.g. Budget, Decision maker): one tap each, saved on the lead.
        val facts = vm.membership?.organization?.leadFacts.orEmpty()
        facts.forEach { f ->
            val cur = factValues[f.key] ?: lead?.custom?.get(f.key)?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            Text(f.label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                f.options.forEach { o -> Chip(o, cur == o) { factValues = factValues + (f.key to o) } }
            }
        }
        NoteEditor(notes, { notes = it }, noteTags, { noteTags = it }, emptyList(), "Notes from this call",
            groups = vm.membership?.organization?.tagGroups.orEmpty())

        Button(onClick = {
            val o = outcome ?: return@Button
            val m = vm.membership ?: run { vm.message = "Still loading your company — try again in a moment"; return@Button }
            val at = followAt
            if (!noFollow && at == null) return@Button
            busy = true
            val payload = buildJsonObject {
                put("id", vm.newCallId()); put("org_id", m.org_id); put("lead_id", p.leadId)
                put("phone", p.phone); put("direction", log?.direction ?: "outgoing"); put("purpose", purpose)
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
                if (factValues.isNotEmpty()) put("lead_custom", buildJsonObject { factValues.forEach { (k, v) -> put(k, v) } })
                if (noteTags.isNotEmpty()) put("lead_tags", kotlinx.serialization.json.JsonArray(noteTags.map { kotlinx.serialization.json.JsonPrimitive(it) }))
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
/** Outcomes that only make sense when WE dialled (shown nowhere for a received call). */
val DIALLED_ONLY = setOf("not_in_service", "invalid_number", "r_invalid", "r_out_of_service", "someone_else", "r_someone_else")

fun outcomesFor(all: List<Outcome>, purpose: String, direction: String?, durationSec: Int?): List<Outcome> {
    // Positive first, negative last: sale → interested → still talking → not interested → disqualified.
    val list = all.filter { it.is_active && (it.purpose == purpose || it.purpose == "both") }
        .filter { direction == null || direction == "incoming" || it.shown_on != "incoming" }   // received-only outcomes never on a dialled call
        .sortedWith(compareBy({ outcomeRank(it) }, { it.position }))
    val noContact = { o: Outcome -> o.category == "not_connected" }
    val talk = durationSec ?: 0
    return when {
        direction == null -> list
        // They called us (answered, missed or declined): nothing about failing to reach them or a dead number.
        direction != "outgoing" -> list.filterNot { noContact(it) || it.code in DIALLED_ONLY || it.shown_on == "outgoing" }
        // Dialled, nobody answered: only "couldn't reach them" kinds.
        talk == 0 -> list.filter { noContact(it) || it.code in DEAD_NUMBER }.ifEmpty { list }
        // A few seconds: could be an operator message or a quick hang-up — everything, "couldn't reach" first.
        talk < 20 -> list.sortedBy { if (noContact(it)) 0 else 1 }
        // They talked: nothing about not reaching them or a dead number; "disconnected after intro" only for short talks.
        else -> list.filterNot { noContact(it) || it.code in DEAD_NUMBER || (talk >= 60 && it.code in SHORT_TALK_ONLY) }.ifEmpty { list }
    }
}

/** Conversation outcomes that aren't progress (shown after the positive ones). */
val LOW_CONNECTED = setOf("language", "someone_else", "r_someone_else", "disconnected", "r_disconnected", "call_back", "r_call_later", "r_repeated")

/** Order of outcome groups: 0 sale · 1 interested · 2 still talking · 3 low-value conversation · 4 not interested · 5 disqualified · 6 couldn't reach. */
fun outcomeRank(o: Outcome): Int = when {
    o.category == "won" -> 0
    o.category == "positive" -> 1
    o.code in LOW_CONNECTED -> 3
    o.category == "connected" -> 2
    o.category == "lost" -> 4
    o.category == "invalid" -> 5
    o.category == "not_connected" -> 6
    else -> 2
}

/** Dead / wrong-line numbers: only possible when the call didn't really connect. */
val DEAD_NUMBER = setOf("not_in_service", "invalid_number", "r_invalid", "r_out_of_service", "incoming_na", "r_incoming_na")
/** Only fits a short conversation. */
val SHORT_TALK_ONLY = setOf("disconnected", "r_disconnected")

/** One-tap next-call options: key, minutes from now, label. */
val quickIns = listOf(Triple("30m", 30L, "In 30 min"), Triple("1h", 60L, "1 hour"), Triple("2h", 120L, "2 hours"), Triple("3h", 180L, "3 hours"))
