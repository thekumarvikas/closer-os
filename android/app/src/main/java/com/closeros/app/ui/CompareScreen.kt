package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Repo
import kotlinx.serialization.json.*
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.roundToInt

/** One measure of the comparison report (same list and rules as the dashboard's Reports → Compare periods). */
private class Measure(val group: String, val label: String, val pct: Boolean = false, val lowerBetter: Boolean = false,
                      val fmt: (Double) -> String, val v: (JsonObject) -> Double?)

private fun JsonObject.d(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
private fun ratio(a: Double, b: Double) = if (b > 0) a / b else null
private val num: (Double) -> String = { "%,d".format(it.roundToInt()) }
private val one: (Double) -> String = { if (it >= 10) "%,d".format(it.roundToInt()) else "%.1f".format(it) }
private val pc: (Double) -> String = { "${(it * 100).roundToInt()}%" }
private val talk: (Double) -> String = { fmtDur(it.roundToInt()) }

private val MEASURES = listOf(
    Measure("Totals", "All calls", fmt = num) { it.d("calls") },
    Measure("Totals", "Dialled", fmt = num) { it.d("dialled") },
    Measure("Totals", "Received", fmt = num) { it.d("received") },
    Measure("Totals", "Missed / declined", lowerBetter = true, fmt = num) { it.d("missed") },
    Measure("Totals", "Not picked up (dialled)", lowerBetter = true, fmt = num) { it.d("not_picked") },
    Measure("Totals", "Conversations", fmt = num) { it.d("conversations") },
    Measure("Totals", "Talk time", fmt = talk) { it.d("talk_sec") },
    Measure("Totals", "Follow-ups called", fmt = num) { it.d("fu_on_time") + it.d("fu_late") },
    Measure("Totals", "Sales", fmt = num) { it.d("sales") },
    Measure("Uniques", "Unique numbers", fmt = num) { it.d("uniq_numbers") },
    Measure("Uniques", "Unique numbers talked to", fmt = num) { it.d("uniq_reached") },
    Measure("Uniques", "Leads dialled", fmt = num) { it.d("leads_dialled") },
    Measure("Uniques", "Leads talked to", fmt = num) { it.d("leads_reached") },
    Measure("Uniques", "New leads called (first time)", fmt = num) { it.d("new_called") },
    Measure("Averages", "Calls per day", fmt = one) { ratio(it.d("calls"), it.d("active_days")) },
    Measure("Averages", "Talk time per day", fmt = talk) { ratio(it.d("talk_sec"), it.d("active_days")) },
    Measure("Averages", "Talk per conversation", fmt = talk) { ratio(it.d("talk_sec"), it.d("conversations")) },
    Measure("Averages", "Dials per sale", lowerBetter = true, fmt = one) { ratio(it.d("dialled"), it.d("sales")) },
    Measure("Averages", "First call to a new lead", lowerBetter = true, fmt = talk) { it["response_median_sec"]?.jsonPrimitive?.doubleOrNull },
    Measure("Percentages", "Pick-up rate", pct = true, fmt = pc) { ratio(it.d("picked"), it.d("dialled")) },
    Measure("Percentages", "Conversation rate", pct = true, fmt = pc) { ratio(it.d("conversations"), it.d("calls")) },
    Measure("Percentages", "Missed calls called back", pct = true, fmt = pc) { ratio(it.d("missed") - it.d("never_attended"), it.d("missed")) },
    Measure("Percentages", "Follow-ups on time", pct = true, fmt = pc) { ratio(it.d("fu_on_time"), it.d("fu_due")) },
    Measure("Percentages", "New assigned leads called", pct = true, fmt = pc) { ratio(it.d("assigned_called"), it.d("assigned")) },
    Measure("Percentages", "Conversion (sales ÷ leads talked to)", pct = true, fmt = pc) { ratio(it.d("sales"), it.d("leads_reached")) },
)

private typealias Range = Pair<LocalDate, LocalDate>

/** The period you look at. */
private fun mainPeriods(today: LocalDate): List<Pair<String, Range>> {
    val mon = today.minusDays((today.dayOfWeek.value - 1).toLong())
    val m1 = today.withDayOfMonth(1)
    return listOf(
        "Today" to (today to today),
        "Yesterday" to (today.minusDays(1) to today.minusDays(1)),
        "This week" to (mon to today),
        "Last week" to (mon.minusDays(7) to mon.minusDays(1)),
        "Last 7 days" to (today.minusDays(6) to today),
        "This month" to (m1 to today),
        "Last month" to (m1.minusMonths(1) to m1.minusDays(1)),
    )
}

/** What it is compared with: the same number of days just before, the same days a week / month earlier. */
private fun compareWith(kind: String, r: Range): Range {
    val days = java.time.temporal.ChronoUnit.DAYS.between(r.first, r.second) + 1
    return when (kind) {
        "week" -> r.first.minusWeeks(1) to r.second.minusWeeks(1)
        "month" -> r.first.minusMonths(1) to r.second.minusMonths(1)
        else -> r.first.minusDays(days) to r.first.minusDays(1)
    }
}

private val dShort = java.time.format.DateTimeFormatter.ofPattern("d MMM")
private fun Range.label(): String = if (first == second) dShort.format(first) else
    if (first.month == second.month && first.year == second.year) "${first.dayOfMonth}–${dShort.format(second)}" else "${dShort.format(first)} – ${dShort.format(second)}"

/** Reports → Compare periods: you choose the period AND what to compare it with; both date ranges are shown. */
@Composable
fun CompareScreen(vm: AppViewModel, users: List<String>?, whoLabel: String, onClose: () -> Unit) {
    BackHandler { onClose() }
    val m = vm.membership ?: return
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    val today = remember { LocalDate.now(zone) }
    val ps = remember { mainPeriods(today) }
    var main by remember { mutableStateOf(ps.first().second) }
    var mainName by remember { mutableStateOf<String?>("Today") }
    var withKind by remember { mutableStateOf("before") }           // before | week | month | custom
    var custom by remember { mutableStateOf<Range?>(null) }
    val other = if (withKind == "custom") custom ?: compareWith("before", main) else compareWith(withKind, main)
    var cur by remember { mutableStateOf<JsonObject?>(null) }
    var prev by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    fun pick(start: LocalDate?, done: (Range) -> Unit) {
        val s0 = start ?: today
        android.app.DatePickerDialog(ctx, { _, y, mo, d ->
            val a = LocalDate.of(y, mo + 1, d)
            android.app.DatePickerDialog(ctx, { _, y2, mo2, d2 -> done(a to maxOf(a, LocalDate.of(y2, mo2 + 1, d2))) }, a.year, a.monthValue - 1, a.dayOfMonth)
                .apply { setTitle("Until"); datePicker.minDate = a.atStartOfDay(zone).toInstant().toEpochMilli(); datePicker.maxDate = System.currentTimeMillis() }.show()
        }, s0.year, s0.monthValue - 1, s0.dayOfMonth).apply { setTitle("From"); datePicker.maxDate = System.currentTimeMillis() }.show()
    }
    LaunchedEffect(main, other) {
        cur = null; prev = null; error = null
        fun range(r: Range) = r.first.atStartOfDay(zone).toInstant() to r.second.plusDays(1).atStartOfDay(zone).toInstant()
        runCatching {
            val (a, b) = range(main); val (c, d) = range(other)
            Repo.report("period_summary", m.org_id, a, b, users).jsonObject["total"]!!.jsonObject to
                Repo.report("period_summary", m.org_id, c, d, users).jsonObject["total"]!!.jsonObject
        }.onSuccess { cur = it.first; prev = it.second }
            .onFailure { error = if (!vm.online) "No internet — and no saved copy of this period yet." else com.closeros.app.data.SafeError.forUser(it, "Couldn't load") }
    }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Default.ArrowBack, "Back") }
            Column {
                Text("Compare periods", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(whoLabel, fontSize = 13.sp, color = Brand.muted)
            }
        }
        Text("1 · Period", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Brand.muted, modifier = Modifier.padding(start = 16.dp, top = 6.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ps.forEach { (n, r) -> FilterChip(mainName == n, { mainName = n; main = r }, { Text(n) }) }
            FilterChip(mainName == null, { pick(main.first) { mainName = null; main = it } }, { Text("Pick dates") })
        }
        Text("2 · Compare with", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Brand.muted, modifier = Modifier.padding(start = 16.dp, top = 4.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("before" to "The period just before", "week" to "Same days last week", "month" to "Same days last month").forEach { (k, l) ->
                FilterChip(withKind == k, { withKind = k }, { Text(l) })
            }
            FilterChip(withKind == "custom", { pick(other.first) { custom = it; withKind = "custom" } }, { Text("Pick dates") })
        }
        // Both date ranges, spelled out.
        Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f).background(Color(0xFFE6F4F1), RoundedCornerShape(10.dp)).padding(10.dp)) {
                Text("This period", fontSize = 11.sp, color = Brand.muted); Text(main.label(), fontWeight = FontWeight.Bold, fontSize = 15.sp)
            }
            Column(Modifier.weight(1f).background(Color(0xFFF1F5F9), RoundedCornerShape(10.dp)).padding(10.dp)) {
                Text("Compared with", fontSize = 11.sp, color = Brand.muted); Text(other.label(), fontWeight = FontWeight.Bold, fontSize = 15.sp)
            }
        }
        error?.let { Text(it, color = Brand.red, modifier = Modifier.padding(16.dp)) }
        val c = cur; val p = prev
        if (c == null || p == null) { if (error == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        LazyColumn(contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(MEASURES.groupBy { it.group }.toList()) { (group, list) ->
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp)) {
                        Text(group.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Brand.muted)
                        list.forEach { ms ->
                            val a = ms.v(c); val b = ms.v(p)
                            Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                                Text(ms.label, fontSize = 14.sp)
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Text(a?.let(ms.fmt) ?: "—", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                                    Text("vs ${b?.let(ms.fmt) ?: "—"}", fontSize = 13.sp, color = Brand.muted)
                                    Delta(ms, a, b)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Delta(ms: Measure, a: Double?, b: Double?) {
    if (a == null || b == null) return
    val diff = if (ms.pct) (a - b) * 100 else if (b == 0.0) (if (a == 0.0) 0.0 else null) else (a - b) / b * 100
    if (diff == null) { Text("new", fontSize = 11.sp, color = Brand.muted); return }
    val r = diff.roundToInt()
    if (r == 0) { Text("=", fontSize = 11.sp, color = Brand.muted); return }
    val good = (r > 0) != ms.lowerBetter
    Text("${if (r > 0) "▲" else "▼"} ${abs(r)}${if (ms.pct) " pts" else "%"}", fontSize = 11.sp, fontWeight = FontWeight.Medium,
        color = if (good) Color(0xFF059669) else Color(0xFFDC2626))
}
