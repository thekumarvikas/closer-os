package com.closeros.app.ui

import android.app.DatePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.IdName
import com.closeros.app.data.ProgressReport
import com.closeros.app.data.Repo
import kotlinx.serialization.json.*
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun JsonObject.i(k: String) = this[k]?.jsonPrimitive?.intOrNull ?: this[k]?.jsonPrimitive?.doubleOrNull?.toInt() ?: 0
private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.contentOrNull

private data class Rep(val rows: List<JsonObject>, val outcomes: List<JsonObject>, val followUps: JsonObject?, val targets: ProgressReport?)

/** Reports in the app: any period, me or (for managers) the team, with breakdowns by outcome, day, hour and person. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReportsScreen(vm: AppViewModel) {
    BackHandler { vm.showReports = false }
    val ctx = LocalContext.current
    val m = vm.membership ?: return
    val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    val today = LocalDate.now(zone)
    var from by remember { mutableStateOf(today) }
    var to by remember { mutableStateOf(today) }
    var who by remember { mutableStateOf(if (vm.isManager && !vm.isSolo) "all" else "me") }
    var team by remember { mutableStateOf<List<IdName>>(emptyList()) }
    var data by remember { mutableStateOf<Rep?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var leadScope by remember { mutableStateOf("all") }   // all = every lead · period = leads assigned in this period
    var status by remember { mutableStateOf<JsonObject?>(null) }
    var onPhone by remember { mutableStateOf(false) }   // true = worked out on this phone
    var compare by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (vm.isManager) team = runCatching { Repo.teamBrief(m.org_id) }.getOrDefault(emptyList()) }
    LaunchedEffect(from, to, who) {
        data = null; error = null
        val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        val a = from.atStartOfDay(zone).toInstant(); val b = to.plusDays(1).atStartOfDay(zone).toInstant()
        // My own numbers: worked out on this phone (no internet needed, includes calls not uploaded yet).
        if (who == "me") {
            runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    val L = com.closeros.app.data.LocalReports
                    val cr = L.callReport(ctx, from, to, zone)["rows"]!!.jsonArray.map { it.jsonObject }
                    val or = L.outcomeReport(ctx, from, to, zone)["rows"]!!.jsonArray.map { it.jsonObject }
                    val fu = L.followUpReport(ctx, m.org_id, from, to, zone).map { it.jsonObject }.firstOrNull()
                    val tg = runCatching { Repo.targetsFor(m.org_id, from, to, users) }.getOrNull()?.let { t ->
                        t.copy(rows = t.rows.map { r -> L.withMyActuals(ctx, r, from, to, zone, vm.outcomes) ?: r }) }
                    Rep(cr, or, fu, tg)
                }
            }.onSuccess { data = it; onPhone = true }.onFailure { error = com.closeros.app.data.SafeError.forUser(it, "Couldn't work out the report") }
            return@LaunchedEffect
        }
        onPhone = false
        runCatching {
            val cr = Repo.report("call_report", m.org_id, a, b, users).jsonObject["rows"]!!.jsonArray.map { it.jsonObject }
            val or = Repo.report("outcome_report", m.org_id, a, b, users).jsonObject["rows"]!!.jsonArray.map { it.jsonObject }
            val fu = runCatching { Repo.report("follow_up_report", m.org_id, a, b, users).jsonArray.map { it.jsonObject }.firstOrNull { it.i("g") == 1 } }.getOrNull()
            val tg = runCatching { Repo.targetsFor(m.org_id, from, to, users) }.getOrNull()
            Rep(cr, or, fu, tg)
        }.onSuccess { data = it }.onFailure { error = com.closeros.app.data.SafeError.forUser(it, "Couldn't load the report") }
    }
    LaunchedEffect(from, to, who, leadScope) {
        status = null
        val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        status = if (who == "me") kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching { com.closeros.app.data.LocalReports.leadStatus(ctx, com.closeros.app.data.Backend.uid, vm.outcomes,
                if (leadScope == "all") null else from.atStartOfDay(zone).toInstant(), if (leadScope == "all") null else to.plusDays(1).atStartOfDay(zone).toInstant()) }.getOrNull()
        } else runCatching {
            if (leadScope == "all") Repo.leadStatus(m.org_id, users, null, null)
            else Repo.leadStatus(m.org_id, users, from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant())
        }.getOrNull()
    }
    fun pickDates() {
        DatePickerDialog(ctx, { _, y, mo, d ->
            val start = LocalDate.of(y, mo + 1, d)
            DatePickerDialog(ctx, { _, y2, mo2, d2 -> from = start; to = maxOf(start, LocalDate.of(y2, mo2 + 1, d2)) }, start.year, start.monthValue - 1, start.dayOfMonth)
                .apply { setTitle("Until"); datePicker.minDate = start.atStartOfDay(zone).toInstant().toEpochMilli(); datePicker.maxDate = System.currentTimeMillis() }.show()
        }, from.year, from.monthValue - 1, from.dayOfMonth).apply { setTitle("From"); datePicker.maxDate = System.currentTimeMillis() }.show()
    }
    if (compare) {
        val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        CompareScreen(vm, users, when (who) { "all" -> "Everyone"; "me" -> "Me"; else -> team.firstOrNull { it.id == who }?.name ?: "" }) { compare = false }
        return
    }
    val presets = listOf("Today" to (today to today), "Yesterday" to (today.minusDays(1) to today.minusDays(1)), "Last 7 days" to (today.minusDays(6) to today),
        "This month" to (today.withDayOfMonth(1) to today), "Last month" to (today.minusMonths(1).withDayOfMonth(1) to today.withDayOfMonth(1).minusDays(1)))
    val df = DateTimeFormatter.ofPattern("dd MMM")

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showReports = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Column {
                Text("Reports", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(if (from == to) from.format(DateTimeFormatter.ofPattern("EEE dd MMM yyyy")) else "${from.format(df)} – ${to.format(df)}", fontSize = 13.sp, color = Brand.muted)
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            presets.forEach { (l, r) -> FilterChip(from == r.first && to == r.second, { if (l == "Today") { from = r.first; to = r.second } else vm.require(com.closeros.app.data.Feature.REPORTS) { from = r.first; to = r.second } }, { Text(l) }) }
            FilterChip(presets.none { from == it.second.first && to == it.second.second }, { vm.require(com.closeros.app.data.Feature.REPORTS) { pickDates() } }, { Text("Pick dates") })
        }
        if (vm.isManager && !vm.isSolo) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(who == "all", { who = "all" }, { Text("Everyone") })
            FilterChip(who == "me", { who = "me" }, { Text("Me") })
            team.filter { it.id != com.closeros.app.data.Backend.uid }.forEach { p -> FilterChip(who == p.id, { who = p.id }, { Text(p.name.substringBefore(' ')) }) }
        }
        val d = data
        if (d != null) Text(if (onPhone) "📱 Counted on this phone — up to the minute, works without internet"
            else if (!vm.online) "📴 No internet — team numbers as last saved" else "☁ Whole team, from Closer OS",
            fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(horizontal = 16.dp))
        if (error != null) Text(error!!, color = Brand.red, modifier = Modifier.padding(16.dp))
        if (d == null) { if (error == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        val total = d.rows.firstOrNull { it.i("g") == 15 } ?: JsonObject(emptyMap())
        val calls = total.i("calls"); val conn = total.i("conn"); val out = total.i("out")
        LazyColumn(contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.require(com.closeros.app.data.Feature.REPORTS) { vm.showLeadWork = true } }, modifier = Modifier.weight(1f)) { Text("📈 Lead work") }
                    OutlinedButton(onClick = { vm.require(com.closeros.app.data.Feature.REPORTS) { vm.showRecipe = true } }, modifier = Modifier.weight(1f)) { Text("💡 Sales insights") }
                }
                Button(onClick = { vm.require(com.closeros.app.data.Feature.REPORTS) { compare = true } }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) { Text("⇅ Compare periods (▲▼ vs before)") }
            }
            item {
                val tiles = listOf(
                    "All calls" to "$calls", "Dialled" to "$out", "Received" to "${total.i("inc")}", "Conversations" to "$conn",
                    "Conversation rate" to (if (calls > 0) "${conn * 100 / calls}%" else "—"), "No answer" to "${total.i("not_picked")}",
                    "Missed / declined" to "${total.i("missed") + total.i("rejected")}", "Never called back" to "${total.i("never_attended")}",
                    "Talk time" to fmtDur(total.i("conn_dur")), "Avg. conversation" to (if (conn > 0) fmtDur(total.i("conn_dur") / conn) else "—"),
                    "Unique contacts" to "${total.i("uniq")}", "Contacts reached" to "${total.i("uniq_conn")}")
                tiles.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 10.dp)) {
                        row.forEach { (l, v) ->
                            Card(Modifier.weight(1f), colors = CardDefaults.cardColors(containerColor = Color.White)) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(l, fontSize = 13.sp, color = Brand.muted)
                                    Text(v, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = if (l.startsWith("Missed") || l.startsWith("Never") || l == "No answer") Brand.red else Color(0xFF0F172A))
                                }
                            }
                        }
                    }
                }
            }
            d.targets?.let { t ->
                val sum = t.rows.fold(IntArray(8)) { acc, r -> acc.also {
                    it[0] += r.actual.calls ?: 0; it[1] += r.target.calls ?: 0; it[2] += r.actual.conversations ?: 0; it[3] += r.target.conversations ?: 0
                    it[4] += r.actual.talk_minutes ?: 0; it[5] += r.target.talk_minutes ?: 0; it[6] += r.actual.sales ?: 0; it[7] += r.target.sales ?: 0 } }
                if (sum[1] + sum[3] + sum[5] + sum[7] > 0) item {
                    Section("Targets (${t.work_days} working day${if (t.work_days == 1) "" else "s"})") {
                        listOf(Triple("Calls dialled", sum[0], sum[1]), Triple("Conversations", sum[2], sum[3]), Triple("Talk time (min)", sum[4], sum[5]), Triple("Sales", sum[6], sum[7]))
                            .filter { it.third > 0 }.forEach { (l, a, tg) -> BarRow(l, a.toFloat() / tg, "$a / $tg · ${a * 100 / tg}%", if (a >= tg) Color(0xFF10B981) else if (a * 10 >= tg * 7) Color(0xFFF59E0B) else Brand.primary) }
                    }
                }
            }
            status?.let { st -> item {
                val total = st.i("total")
                fun pct(n: Int) = if (total > 0) "${n * 100 / total}%" else "—"
                val cat = st["by_category"]?.jsonObject ?: JsonObject(emptyMap())
                val interested = cat["positive"]?.jsonPrimitive?.intOrNull ?: 0
                val won = cat["won"]?.jsonPrimitive?.intOrNull ?: 0
                Section("Leads — where they stand") {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(leadScope == "all", { leadScope = "all" }, { Text("All leads") })
                        FilterChip(leadScope == "period", { leadScope = "period" }, { Text("Assigned in this period") })
                    }
                    Text("$total leads" + if (who == "all") " (whole team)" else "", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    listOf(Triple("Called at least once", st.i("called"), Brand.primary), Triple("Talked to (reached)", st.i("reached"), Color(0xFF0EA5E9)),
                        Triple("Interested now", interested, Color(0xFF34D399)), Triple("Sales (won)", won, Color(0xFF10B981)),
                        Triple("Never called yet", st.i("never_called"), Color(0xFFF59E0B))).forEach { (l, n, c) ->
                        BarRow(l, if (total > 0) n.toFloat() / total else 0f, "$n · ${pct(n)}", c)
                    }
                    val byOut = st["by_outcome"]?.jsonArray?.map { it.jsonObject }.orEmpty()
                    if (byOut.isNotEmpty()) {
                        Text("Latest outcome of each lead (% of all $total leads)", fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 4.dp))
                        byOut.forEach { o ->
                            val oc = vm.outcomes.firstOrNull { it.id == o.s("outcome_id") }
                            BarRow(oc?.label ?: "Other", if (total > 0) o.i("leads").toFloat() / total else 0f, "${o.i("leads")} · ${pct(o.i("leads"))}", Brand.primary)
                        }
                    }
                    val reps = st["by_rep"]?.jsonArray?.map { it.jsonObject }.orEmpty()
                    if (who == "all" && reps.size > 1) {
                        Text("Per person (leads · called · reached · interested · won · conversion)", fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 4.dp))
                        reps.forEach { r ->
                            val t = r.i("total").coerceAtLeast(1)
                            Text("${team.firstOrNull { it.id == r.s("assigned_to") }?.name ?: "Someone"}: ${r.i("total")} · ${r.i("called") * 100 / t}% · ${r.i("reached") * 100 / t}% · ${r.i("interested")} · ${r.i("won")} · ${r.i("won") * 100 / t}%",
                                fontSize = 13.sp)
                        }
                    }
                }
            } }
            val outs = d.outcomes.filter { it.i("g") == 6 && it.s("outcome_id") != null }.sortedByDescending { it.i("calls") }
            if (outs.isNotEmpty()) item {
                val max = outs.maxOf { it.i("calls") }.coerceAtLeast(1)
                Section("Outcomes") {
                    outs.forEach { o ->
                        val oc = vm.outcomes.firstOrNull { it.id == o.s("outcome_id") }
                        BarRow(oc?.label ?: "Other", o.i("calls").toFloat() / max, "${o.i("calls")} · ${o.i("leads")} leads",
                            when (oc?.category) { "won" -> Color(0xFF10B981); "positive" -> Color(0xFF34D399); "lost", "invalid" -> Color(0xFFF87171); "not_connected" -> Color(0xFF94A3B8); else -> Brand.primary })
                    }
                }
            }
            d.followUps?.let { f ->
                if (f.i("due") > 0) item {
                    Section("Follow-ups due in this period") {
                        Text("${f.i("due")} due · ${f.i("on_time")} on time · ${f.i("late")} late · ${f.i("missed")} not called · ${f.i("upcoming")} still upcoming", fontSize = 14.sp)
                        val done = f.i("on_time") + f.i("late") + f.i("missed")
                        if (done > 0) BarRow("On time", f.i("on_time").toFloat() / done, "${f.i("on_time") * 100 / done}%", Color(0xFF10B981))
                    }
                }
            }
            val users = d.rows.filter { it.i("g") == 7 && it.s("user_id") != null }.sortedByDescending { it.i("conn_dur") }
            if (who == "all" && users.size > 1) item {
                val max = users.maxOf { it.i("conn_dur") }.coerceAtLeast(1)
                Section("Team — by talk time") {
                    users.forEach { u ->
                        val name = team.firstOrNull { it.id == u.s("user_id") }?.name ?: "Someone"
                        BarRow(name, u.i("conn_dur").toFloat() / max, "${fmtDur(u.i("conn_dur"))} · ${u.i("conn")}/${u.i("calls")} calls", Brand.primary)
                    }
                }
            }
            val days = d.rows.filter { it.i("g") == 11 && it.s("day") != null }.sortedByDescending { it.s("day") }
            if (days.size > 1) item {
                Section("Day by day") {
                    Row { Text("Day", Modifier.weight(1.3f), fontSize = 12.sp, color = Brand.muted); Text("Calls", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted)
                        Text("Conv.", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted); Text("Talk", Modifier.weight(1.2f), fontSize = 12.sp, color = Brand.muted) }
                    days.forEach { r ->
                        Row(Modifier.padding(vertical = 3.dp)) {
                            Text(runCatching { LocalDate.parse(r.s("day")).format(DateTimeFormatter.ofPattern("EEE dd MMM")) }.getOrDefault(r.s("day") ?: ""), Modifier.weight(1.3f), fontSize = 14.sp)
                            Text("${r.i("calls")}", Modifier.weight(1f), fontSize = 14.sp); Text("${r.i("conn")}", Modifier.weight(1f), fontSize = 14.sp)
                            Text(fmtDur(r.i("conn_dur")), Modifier.weight(1.2f), fontSize = 14.sp)
                        }
                    }
                }
            }
            val hours = d.rows.filter { it.i("g") == 13 && it.s("hr") != null }.associateBy { it.i("hr") }
            if (hours.isNotEmpty()) item {
                val max = hours.values.maxOf { it.i("calls") }.coerceAtLeast(1)
                Section("By hour (calls · conversations)") {
                    (hours.keys.min()..hours.keys.max()).forEach { h ->
                        val r = hours[h]
                        BarRow("${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}", (r?.i("calls") ?: 0).toFloat() / max,
                            "${r?.i("calls") ?: 0} · ${r?.i("conn") ?: 0}", Brand.primary)
                    }
                }
            }
            if (calls == 0) item { Text("No calls in this period.", color = Brand.muted) }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold); content()
        }
    }
}

@Composable
private fun BarRow(label: String, frac: Float, value: String, color: Color) {
    Column {
        Row { Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis); Text(value, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
        Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0xFFE2E8F0), RoundedCornerShape(3.dp))) {
            Box(Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).height(6.dp).background(color, RoundedCornerShape(3.dp)))
        }
    }
}
