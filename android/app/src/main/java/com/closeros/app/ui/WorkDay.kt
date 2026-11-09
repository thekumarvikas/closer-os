package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.IdName
import com.closeros.app.data.Repo
import com.closeros.app.data.WorkLog
import kotlinx.serialization.json.*
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val hm = DateTimeFormatter.ofPattern("h:mm a")
private fun clock(ms: Long) = hm.format(java.time.Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

/** Home: Start my day → working (Break · End day) → on a break (Back to work). */
@Composable
fun WorkDayBar(vm: AppViewModel) {
    val ctx = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(30_000); tick++ } }
    var askBreak by remember { mutableStateOf(false) }
    var askEnd by remember { mutableStateOf(false) }
    @Suppress("UNUSED_VARIABLE") val t = tick
    val shift = vm.membership?.organization?.settings?.get("efficiency")?.jsonObject?.get("shift_start")?.jsonPrimitive?.contentOrNull ?: "10:00"
    when {
        WorkLog.onBreak(ctx) -> {
            val mins = ((System.currentTimeMillis() - WorkLog.breakSinceMs(ctx)) / 60_000).toInt()
            Row(Modifier.fillMaxWidth().background(Color(0xFFFEF3C7), RoundedCornerShape(12.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("☕ On ${WorkLog.breakType(ctx)?.lowercase() ?: "a"} break · $mins min", fontWeight = FontWeight.SemiBold, color = Color(0xFF92400E))
                    Text("Breaks today: ${WorkLog.breakMinutesToday(ctx)} min", fontSize = 12.sp, color = Color(0xFF92400E))
                }
                Button(onClick = { WorkLog.endBreak(ctx); tick++ }) { Text("Back to work") }
            }
        }
        WorkLog.dayStarted(ctx) && !WorkLog.dayEnded(ctx) -> Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(12.dp))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🟢 Working since ${clock(WorkLog.dayStartMs(ctx))}", fontSize = 14.sp, color = Color(0xFF065F46), modifier = Modifier.weight(1f))
            TextButton(onClick = { askBreak = true }) { Text("☕ Break") }
            TextButton(onClick = { askEnd = true }) { Text("End day", color = Brand.muted) }
        }
        WorkLog.dayEnded(ctx) -> Row(Modifier.fillMaxWidth().background(Color(0xFFF1F5F9), RoundedCornerShape(12.dp))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Day ended at ${clock(WorkLog.dayEndMs(ctx))} ✓", fontSize = 14.sp, color = Brand.muted, modifier = Modifier.weight(1f))
            TextButton(onClick = { WorkLog.startDay(ctx); tick++ }) { Text("Start again") }
        }
        else -> Button(onClick = { WorkLog.startDay(ctx); tick++; vm.message = "Have a great day! 💪" }, modifier = Modifier.fillMaxWidth().height(50.dp)) {
            Text("▶ Start my day", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("  · shift ${runCatching { hm.format(java.time.LocalTime.parse(shift)) }.getOrDefault(shift)}", fontSize = 13.sp)
        }
    }
    if (askBreak) AlertDialog(onDismissRequest = { askBreak = false }, title = { Text("Take a break") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Lunch" to "🍱", "Tea" to "☕", "Personal" to "🙋").forEach { (k, e) ->
                    OutlinedButton(onClick = { WorkLog.startBreak(ctx, k); askBreak = false; tick++ }, modifier = Modifier.fillMaxWidth()) { Text("$e $k break") }
                }
                Text("Tap \"Back to work\" on Home when you return.", fontSize = 12.sp, color = Brand.muted)
            }
        }, confirmButton = {}, dismissButton = { TextButton(onClick = { askBreak = false }) { Text("Cancel") } })
    if (askEnd) AlertDialog(onDismissRequest = { askEnd = false }, title = { Text("End your day?") },
        text = { Text("Calls you make later still count, but your working day ends now.") },
        confirmButton = { Button(onClick = { WorkLog.endDay(ctx); askEnd = false; tick++ }) { Text("End day") } },
        dismissButton = { TextButton(onClick = { askEnd = false }) { Text("Not yet") } })
}

private fun JsonObject.n(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
private fun JsonObject.ni(k: String) = this[k]?.jsonPrimitive?.intOrNull
private fun hmDur(sec: Double): String { val m = (sec / 60).toInt(); return if (m >= 60) "${m / 60}h ${m % 60}m" else "${m}m" }
private fun scoreColor(s: Int?) = when { s == null -> Brand.muted; s >= 75 -> Color(0xFF059669); s >= 50 -> Color(0xFFD97706); else -> Color(0xFFDC2626) }

/** Time buckets in the same order and colours as the dashboard. */
private val BUCKETS = listOf(
    Triple("calling", "Calling", Color(0xFF166534)), Triple("wa", "WhatsApp", Color(0xFF22C55E)), Triple("crm", "Updating leads", Color(0xFF2563EB)),
    Triple("app", "Other work in app", Color(0xFF93C5FD)), Triple("between", "Between tasks", Color(0xFFCBD5E1)),
    Triple("break", "Break", Color(0xFFF59E0B)), Triple("idle", "Idle", Color(0xFFEF4444)))

@Composable
private fun TimeBar(t: JsonObject, height: Int = 14) {
    val total = BUCKETS.sumOf { t.n(it.first) }.coerceAtLeast(1.0)
    Row(Modifier.fillMaxWidth().height(height.dp).background(Color(0xFFF1F5F9), RoundedCornerShape(6.dp))) {
        BUCKETS.forEach { (k, _, c) -> val v = t.n(k); if (v > 0) Box(Modifier.weight((v / total).toFloat()).fillMaxHeight().background(c)) }
    }
}

/** Efficiency: 4 scores + overall, where the time went, lead efficiency, hour by hour. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EfficiencyScreen(vm: AppViewModel) {
    BackHandler { vm.showEfficiency = false }
    val m = vm.membership ?: return
    val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    val today = LocalDate.now(zone)
    val me = com.closeros.app.data.Backend.uid
    var period by remember { mutableStateOf("Today") }
    var who by remember { mutableStateOf(me) }
    var team by remember { mutableStateOf<List<IdName>>(emptyList()) }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var hours by remember { mutableStateOf<JsonArray?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val periods = mapOf("Today" to (today to today), "Yesterday" to (today.minusDays(1) to today.minusDays(1)),
        "Last 7 days" to (today.minusDays(6) to today), "This month" to (today.withDayOfMonth(1) to today))
    LaunchedEffect(Unit) { if (vm.isManager) team = runCatching { Repo.teamBrief(m.org_id) }.getOrDefault(emptyList()) }
    LaunchedEffect(period, who) {
        data = null; hours = null; error = null
        val (f, t) = periods[period]!!
        runCatching { Repo.efficiency(m.org_id, f, t, listOfNotNull(who)) }.onSuccess { data = it }
            .onFailure { error = if (!vm.online) "No internet — and no saved copy yet." else it.message?.substringAfter("ERROR:")?.take(140) ?: "Couldn't load" }
        if (f == t && who != null) hours = runCatching { Repo.workHours(m.org_id, who!!, f)["hours"]?.jsonArray }.getOrNull()
    }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showEfficiency = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("⚡ Efficiency", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            periods.keys.forEach { p -> FilterChip(period == p, { period = p }, { Text(p) }) }
        }
        if (vm.isManager && team.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(who == me, { who = me }, { Text("Me") })
            team.filter { it.id != me }.forEach { p -> FilterChip(who == p.id, { who = p.id }, { Text(p.name.substringBefore(' ')) }) }
        }
        error?.let { Text(it, color = Brand.red, modifier = Modifier.padding(16.dp)) }
        val p = data?.get("people")?.jsonArray?.firstOrNull()?.jsonObject
        if (data == null) { if (error == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        if (p == null) { Text("No work recorded for this period yet. Tap \"Start my day\" on Home when you begin.", color = Brand.muted, modifier = Modifier.padding(16.dp)); return }
        val sc = p["scores"]!!.jsonObject; val t = p["time"]!!.jsonObject; val d = p["detail"]!!.jsonObject; val l = p["leads"]!!.jsonObject
        LazyColumn(contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${sc.ni("overall") ?: "—"}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = scoreColor(sc.ni("overall")))
                            Text("  overall score", color = Brand.muted)
                        }
                        listOf("time" to "⏱ Time", "calling" to "📞 Calling", "conversion" to "💰 Conversion", "discipline" to "✅ Discipline").forEach { (k, label) ->
                            val v = sc.ni(k)
                            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(label, fontSize = 14.sp, modifier = Modifier.width(120.dp))
                                Box(Modifier.weight(1f).height(10.dp).background(Color(0xFFF1F5F9), RoundedCornerShape(5.dp))) {
                                    Box(Modifier.fillMaxWidth(((v ?: 0) / 100f).coerceIn(0f, 1f)).fillMaxHeight().background(scoreColor(v), RoundedCornerShape(5.dp)))
                                }
                                Text(v?.toString() ?: "—", fontWeight = FontWeight.SemiBold, modifier = Modifier.width(40.dp).padding(start = 8.dp))
                            }
                        }
                    }
                }
            }
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val win = t.n("window"); val brk = t.n("break")
                        Text("Where the time went", fontWeight = FontWeight.SemiBold)
                        Text("Working day ${hmDur(win)} · productive ${hmDur(p.n("productive"))} (${if (win - brk > 0) (100 * p.n("productive") / (win - brk)).toInt() else 0}%)", fontSize = 13.sp, color = Brand.muted)
                        TimeBar(t)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            BUCKETS.forEach { (k, label, c) -> if (t.n(k) > 0) Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(9.dp).background(c, RoundedCornerShape(2.dp))); Text(" $label ${hmDur(t.n(k))}", fontSize = 12.sp)
                            } }
                        }
                        Text("Talk time ${hmDur(t.n("talk"))} · ${t.n("wa_msgs").toInt()} WhatsApp messages · breaks ${hmDur(brk)}", fontSize = 13.sp)
                    }
                }
            }
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Leads", fontWeight = FontWeight.SemiBold)
                        Text("Unique leads worked: ${l.ni("unique") ?: 0}", fontSize = 14.sp)
                        Text("New leads connected: ${l.ni("new_connected") ?: 0} of ${l.ni("new") ?: 0}", fontSize = 14.sp)
                        Text("Follow-up leads connected: ${l.ni("followup_connected") ?: 0} of ${l.ni("followup") ?: 0}", fontSize = 14.sp)
                        Text("Dials ${d.ni("dials") ?: 0}${d.ni("target_calls")?.let { " (target $it a day)" } ?: ""} · conversations ${d.ni("conversations") ?: 0} · follow-ups on time ${d.ni("fu_on_time") ?: 0} of ${d.ni("fu_due") ?: 0} · outcomes filled ${d.ni("with_outcome") ?: 0} of ${d.ni("lead_calls") ?: 0}",
                            fontSize = 12.sp, color = Brand.muted)
                    }
                }
            }
            hours?.takeIf { it.isNotEmpty() }?.let { hs ->
                item { Text("Hour by hour", fontWeight = FontWeight.SemiBold) }
                hs.forEach { h -> val o = h.jsonObject; val hr = o.ni("hour") ?: 0
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(java.time.LocalTime.of(hr, 0).format(DateTimeFormatter.ofPattern("h a")) + "–" + java.time.LocalTime.of((hr + 1) % 24, 0).format(DateTimeFormatter.ofPattern("h a")),
                                fontSize = 12.sp, modifier = Modifier.width(78.dp))
                            Box(Modifier.weight(1f)) { TimeBar(o, 12) }
                            Text(hmDur(o.n("talk")), fontSize = 12.sp, color = Brand.muted, modifier = Modifier.width(52.dp).padding(start = 6.dp))
                        }
                    }
                }
                item { Text("Bar = the hour split as above · right = talk time", fontSize = 11.sp, color = Brand.muted) }
            }
        }
    }
}
