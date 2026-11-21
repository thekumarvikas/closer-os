package com.closeros.app.ui

import android.app.DatePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
    var who by remember { mutableStateOf(vm.reportsWho?.also { vm.reportsWho = null } ?: if (vm.isManager && !vm.isSolo) "all" else "me") }
    var team by remember { mutableStateOf<List<IdName>>(emptyList()) }
    var data by remember { mutableStateOf<Rep?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var leadScope by remember { mutableStateOf("all") }   // all = every lead · period = leads assigned in this period
    var status by remember { mutableStateOf<JsonObject?>(null) }
    var lost by remember { mutableStateOf<JsonObject?>(null) }
    var perf by remember { mutableStateOf<JsonObject?>(null) }
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
    var hourIns by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(from, to, who) {
        hourIns = null
        val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        hourIns = runCatching { Repo.report("hour_insights", m.org_id, from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant(), users).jsonObject }.getOrNull()
    }
    LaunchedEffect(from, to) {
        perf = null
        perf = runCatching { Repo.teamPerformance(m.org_id, from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant()) }.getOrNull()
    }
    LaunchedEffect(from, to, who) {
        lost = null
        val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        lost = runCatching { Repo.report("lost_report", m.org_id, from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant(), users).jsonObject }.getOrNull()
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
        // Every number below opens what's behind it: calls for call numbers, leads for lead numbers.
        val drillUsers = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
        val period = when {
            from == to && from == today -> "today"
            from == to && from == today.minusDays(1) -> "yesterday"
            from == to -> from.format(DateTimeFormatter.ofPattern("d MMM"))
            else -> from.format(DateTimeFormatter.ofPattern("d MMM")) + " – " + to.format(DateTimeFormatter.ofPattern("d MMM"))
        }
        fun calls(label: String, key: String) = vm.openCallDrill("$label · $period", from, to, key, drillUsers, onPhone)
        val leadFrom = if (leadScope == "all") null else from.atStartOfDay(zone).toInstant()
        val leadTo = if (leadScope == "all") null else to.plusDays(1).atStartOfDay(zone).toInstant()
        fun leads(label: String, kind: String) = vm.openLeadDrill(label, kind, drillUsers, leadFrom, leadTo, onPhone)
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
                    Triple("All calls", "$calls", "all"), Triple("Dialled", "$out", "dialled"), Triple("Received", "${total.i("inc")}", "received"),
                    Triple("Conversations", "$conn", "conversations"),
                    Triple("Conversation rate", if (calls > 0) "${conn * 100 / calls}%" else "—", "conversations"),
                    Triple("No answer", "${total.i("not_picked")}", "noanswer"),
                    Triple("Missed / declined", "${total.i("missed") + total.i("rejected")}", "missed"),
                    Triple("Never called back", "${total.i("never_attended")}", "never"),
                    Triple("Talk time", fmtDur(total.i("conn_dur")), "conversations"),
                    Triple("Avg. conversation", if (conn > 0) fmtDur(total.i("conn_dur") / conn) else "—", "conversations"),
                    Triple("Unique contacts", "${total.i("uniq")}", "uniq"), Triple("Contacts reached", "${total.i("uniq_conn")}", "reached"))
                tiles.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 10.dp)) {
                        row.forEach { (l, v, key) ->
                            Card(Modifier.weight(1f).clickable { calls(l, key) }, colors = CardDefaults.cardColors(containerColor = Color.White)) {
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
                            .filter { it.third > 0 }.forEach { (l, a, tg) ->
                                val key = when (l) { "Calls dialled" -> "dialled"; "Sales" -> "won"; else -> "conversations" }
                                BarRow(l, a.toFloat() / tg, "$a / $tg · ${a * 100 / tg}%", if (a >= tg) Color(0xFF10B981) else if (a * 10 >= tg * 7) Color(0xFFF59E0B) else Brand.primary) { calls(l, key) } }
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
                    Text("$total leads" + if (who == "all") " (whole team)" else "", fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                        color = Brand.primary, modifier = Modifier.clickable { leads("All leads", "total") })
                    listOf(Triple("Called at least once", st.i("called"), Brand.primary) to "called", Triple("Talked to (reached)", st.i("reached"), Color(0xFF0EA5E9)) to "reached",
                        Triple("Interested now", interested, Color(0xFF34D399)) to "interested", Triple("Sales (won)", won, Color(0xFF10B981)) to "won",
                        Triple("Never called yet", st.i("never_called"), Color(0xFFF59E0B)) to "never").forEach { (t, kind) ->
                        val (l, n, c) = t
                        BarRow(l, if (total > 0) n.toFloat() / total else 0f, "$n · ${pct(n)} of $total", c) { leads(l, kind) }
                    }
                    val byOut = st["by_outcome"]?.jsonArray?.map { it.jsonObject }.orEmpty()
                    if (byOut.isNotEmpty()) {
                        Text("Latest outcome of each lead (% of all $total leads)", fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 4.dp))
                        byOut.forEach { o ->
                            val oc = vm.outcomes.firstOrNull { it.id == o.s("outcome_id") }
                            BarRow(oc?.label ?: "Other", if (total > 0) o.i("leads").toFloat() / total else 0f, "${o.i("leads")} · ${pct(o.i("leads"))}", Brand.primary) {
                                leads("Latest outcome: ${oc?.label ?: "Other"}", "outcome:${o.s("outcome_id")}") }
                        }
                    }
                    val reps = st["by_rep"]?.jsonArray?.map { it.jsonObject }.orEmpty()
                    if (who == "all" && reps.size > 1) {
                        Text("Per person (leads · called · reached · interested · won · conversion)", fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 4.dp))
                        reps.forEach { r ->
                            val t = r.i("total").coerceAtLeast(1)
                            // Tap a person: the whole report switches to them.
                            Text("${team.firstOrNull { it.id == r.s("assigned_to") }?.name ?: "Someone"}: ${r.i("total")} · ${r.i("called") * 100 / t}% · ${r.i("reached") * 100 / t}% · ${r.i("interested")} · ${r.i("won")} · ${r.i("won") * 100 / t}%",
                                fontSize = 13.sp, color = Brand.primary, modifier = Modifier.clickable { r.s("assigned_to")?.let { who = it } }.padding(vertical = 2.dp))
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
                            when (oc?.category) { "won" -> Color(0xFF10B981); "positive" -> Color(0xFF34D399); "lost", "invalid" -> Color(0xFFF87171); "not_connected" -> Color(0xFF94A3B8); else -> Brand.primary }) {
                            calls(oc?.label ?: "Other outcome", "outcome:${o.s("outcome_id")}") }
                    }
                }
            }
            // CRM hygiene for one person (me, or the person picked): six facts, marks = their average. Rows open the leads.
            val perfUser = when (who) { "all" -> null; "me" -> com.closeros.app.data.Backend.uid; else -> who }
            perf?.get("rows")?.jsonArray?.map { it.jsonObject }?.firstOrNull { it.s("user_id") == perfUser }?.let { pr -> item {
                val a = from.atStartOfDay(zone).toInstant(); val b = to.plusDays(1).atStartOfDay(zone).toInstant()
                val uid = perfUser!!
                fun pc(k: String) = pr[k]?.jsonPrimitive?.intOrNull
                val t = perf?.get("target_min")?.jsonPrimitive?.intOrNull ?: 15
                Section("CRM hygiene" + (pc("hygiene")?.let { " · $it marks of 100" } ?: "")) {
                    listOf(
                        Triple("Notes on conversations", "notes_pct", "${pr.i("conv_noted")} of ${pr.i("conv_lead")}") to "no_notes",
                        Triple("Follow-ups called on time", "fu_pct", "${pr.i("fu_on_time")} of ${pr.i("fu_due")} due") to "fu_late",
                        Triple("New leads called within $t min", "fast_pct", "${pr.i("live_fast")} of ${pr.i("live")}") to "slow",
                        Triple("Assigned leads called", "called_pct", "${pr.i("assigned_called")} of ${pr.i("assigned")}") to "not_called",
                        Triple("Profession + city filled", "profile_pct", "${pr.i("profile_filled")} of ${pr.i("profile_talked")} talked to") to "profile_missing",
                        Triple("Days with 5+ calls", "active_pct", "${pr.i("active_days")} of ${pr.i("work_days")} working days") to null,
                    ).forEach { (tr, metric) ->
                        val (label, key, sub) = tr
                        val v = pc(key)
                        BarRow(label, (v ?: 0) / 100f, (v?.let { "$it%" } ?: "—") + " · $sub", Brand.primary,
                            if (metric != null && v != null && v < 100) ({ vm.openPerfLeads("$label — what's missing", a, b, uid, metric) }) else null)
                    }
                    Text("Marks = the average of these six. Tap a row to see the leads that are missing it.", fontSize = 12.sp, color = Brand.muted)
                }
            } }
            // Why leads were lost (reason tapped with a lost outcome). Each row opens those leads.
            lost?.takeIf { it.i("leads") > 0 }?.let { lr -> item {
                val n = lr.i("leads")
                val a = from.atStartOfDay(zone).toInstant(); val b = to.plusDays(1).atStartOfDay(zone).toInstant()
                Section("Why leads were lost ($n)") {
                    lr["reasons"]?.jsonArray?.map { it.jsonObject }.orEmpty().forEach { r ->
                        val key = r.s("reason") ?: "none"
                        val label = com.closeros.app.data.LostReasons.label(m.organization, key) ?: key
                        BarRow(label, r.i("leads").toFloat() / n, "${r.i("leads")} · ${r.i("leads") * 100 / n}% of lost", if (key == "none") Color(0xFF94A3B8) else Color(0xFFF87171)) {
                            vm.openLostLeads("Lost: $label", a, b, drillUsers, key) }
                    }
                }
            } }
            d.followUps?.let { f ->
                if (f.i("due") > 0) item {
                    Section("Follow-ups due in this period") {
                        Text("${f.i("due")} due · ${f.i("on_time")} on time · ${f.i("late")} late · ${f.i("missed")} not called · ${f.i("upcoming")} still upcoming", fontSize = 14.sp,
                            color = Brand.primary, modifier = Modifier.clickable { vm.showReports = false; vm.tab = Tab.FollowUps })
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
                        BarRow(name, u.i("conn_dur").toFloat() / max, "${fmtDur(u.i("conn_dur"))} · ${u.i("conn")}/${u.i("calls")} calls", Brand.primary) { u.s("user_id")?.let { who = it } }
                    }
                }
            }
            val days = d.rows.filter { it.i("g") == 11 && it.s("day") != null }.sortedByDescending { it.s("day") }
            if (days.size > 1) item {
                Section("Day by day") {
                    Row { Text("Day", Modifier.weight(1.3f), fontSize = 12.sp, color = Brand.muted); Text("Calls", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted)
                        Text("Conv.", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted); Text("Talk", Modifier.weight(1.2f), fontSize = 12.sp, color = Brand.muted) }
                    days.forEach { r ->
                        Row(Modifier.fillMaxWidth().clickable { r.s("day")?.let { calls(runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("EEE d MMM")) }.getOrDefault(it), "day:$it") } }.padding(vertical = 3.dp)) {
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
                        val hl = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
                        BarRow(hl, (r?.i("calls") ?: 0).toFloat() / max, "${r?.i("calls") ?: 0} · ${r?.i("conn") ?: 0}", Brand.primary) { calls("Calls at $hl", "hour:$h") }
                    }
                }
            }
            if (hours.isNotEmpty()) item {
                HourInsightsCard(hours, hourIns, team, if (who == "all") null else who, who == "me" || vm.isSolo,
                    today in from..to, zone) { h -> calls("Calls at ${slotOf(h)}", "hour:$h") }
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
private fun BarRow(label: String, frac: Float, value: String, color: Color, onClick: (() -> Unit)? = null) {
    Column(if (onClick != null) Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 2.dp) else Modifier) {
        Row { Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis); Text(value, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
        Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0xFFE2E8F0), RoundedCornerShape(3.dp))) {
            Box(Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).height(6.dp).background(color, RoundedCornerShape(3.dp)))
        }
    }
}


// ---- By hour insights (same rules as the dashboard's box: web components/HourInsights.tsx) ----
private fun hl(h: Int) = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
private fun slotOf(h: Int) = "${hl(h)} – ${hl((h + 1) % 24)}"
private fun pc(a: Int, b: Int) = if (b > 0) a * 100 / b else 0
private data class HR(val hr: Int, val calls: Int, val conn: Int, val talk: Int, val pos: Int, val notPicked: Int = 0)
private fun bestOf(rows: List<HR>): HR? {
    val live = rows.filter { it.conn > 0 || it.pos > 0 }; if (live.isEmpty()) return null
    val mc = live.maxOf { it.conn }.coerceAtLeast(1).toFloat(); val mt = live.maxOf { it.talk }.coerceAtLeast(1).toFloat(); val mp = live.maxOf { it.pos }
    fun sc(r: HR) = (r.conn / mc + r.talk / mt + (if (mp > 0) r.pos / mp.toFloat() else 0f)) / (if (mp > 0) 3 else 2)
    return live.sortedWith(compareByDescending<HR> { sc(it) }.thenByDescending { it.conn }).first()
}

@Composable
private fun HourInsightsCard(hours: Map<Int, JsonObject>, ins: JsonObject?, team: List<IdName>, oneUser: String?, me: Boolean,
                             isToday: Boolean, zone: ZoneId, open: (Int) -> Unit) {
    val arr = { k: String -> (ins?.get(k) as? kotlinx.serialization.json.JsonArray)?.map { it.jsonObject } ?: emptyList() }
    val posBy = arr("hours").associate { it.i("hr") to it }
    val rows = hours.map { (h, r) -> HR(h, r.i("calls"), r.i("conn"), r.i("conn_dur"), posBy[h]?.i("pos") ?: 0, r.i("not_picked")) }
    val best = bestOf(rows) ?: return
    val used = rows.filter { it.calls > 0 }
    val tCalls = used.sumOf { it.calls }; val tConn = used.sumOf { it.conn }; val tTalk = used.sumOf { it.talk }; val tNp = used.sumOf { it.notPicked }
    val hi = used.maxWith(compareBy<HR> { it.conn * 1000 / it.calls }.thenBy { it.calls })
    val most = used.maxBy { it.conn }
    val low = used.filter { it.calls >= 2 }.minByOrNull { it.conn * 1000 / it.calls }
    val busy = used.maxBy { it.calls }
    val outs = arr("outcomes")
    val later = outs.filter { Regex("call_back|call_later|later").containsMatchIn(it.s("code") ?: "") }.maxByOrNull { it.i("n") }
    val posTop = arr("hours").filter { it.i("pos") > 0 }.maxByOrNull { it.i("pos") }
    val noOut = arr("hours").sumOf { it.i("no_outcome") }
    val noOutTop = arr("hours").maxByOrNull { it.i("no_outcome") }
    val team90 = bestOf(arr("team90").map { HR(it.i("hr"), 0, it.i("conn"), it.i("talk"), it.i("pos")) })
    val per = arr("users90").groupBy { it.s("user_id") ?: "" }.mapNotNull { (u, l) -> bestOf(l.map { HR(it.i("hr"), 0, it.i("conn"), it.i("talk"), it.i("pos")) })?.let { u to it } }
        .sortedByDescending { it.second.conn }
    val missedOpen = ins?.i("missed_open") ?: 0
    val you = if (me) "your " else ""
    val now = java.time.ZonedDateTime.now(zone)
    val nowHour = now.hour
    val usedSet = used.map { it.hr }.toSet()
    val empty = (used.minOf { it.hr }..maxOf(20, used.maxOf { it.hr })).filter { it !in usedSet && !(isToday && it >= nowHour) }

    @Composable fun H(t: String) = Text(t, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(top = 10.dp, bottom = 2.dp))
    @Composable fun B(t: String, why: String? = null, onClick: (() -> Unit)? = null) = Column(Modifier.padding(start = 4.dp, bottom = 3.dp).then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)) {
        Text("• $t", fontSize = 13.sp, color = if (onClick != null) Brand.primary else Color.Unspecified)
        if (why != null) Text("   Why: $why", fontSize = 12.sp, color = Brand.muted)
    }
    Section("Best hour & what it means") {
        H("⭐ Best hour${if (isToday) " today" else ""}: ${slotOf(best.hr)}")
        B("${best.conn} conversations · ${fmtDur(best.talk)} of talk" + if (best.pos > 0) " · ${best.pos} positive outcomes" else "")
        B("${pc(best.conn, best.calls)}% of calls picked up (average: ${pc(tConn, tCalls)}%)")
        B("${fmtDur(if (best.conn > 0) best.talk / best.conn else 0)} average talk per conversation (average: ${fmtDur(if (tConn > 0) tTalk / tConn else 0)})")
        H("💡 Also worth knowing")
        B("Highest pick-up: ${slotOf(hi.hr)} (${pc(hi.conn, hi.calls)}% · ${hi.conn} of ${hi.calls} calls)")
        B("Most conversations: ${slotOf(most.hr)} (${most.conn})")
        if (low != null && low.hr != hi.hr) B("Lowest pick-up: ${slotOf(low.hr)} (${pc(low.conn, low.calls)}% · ${low.conn} of ${low.calls} calls)")
        if (busy.hr != best.hr) B("Most calls made: ${slotOf(busy.hr)} (${busy.calls} calls), while the best hour was ${slotOf(best.hr)}")
        if (posTop != null || later != null || noOut > 0) {
            H("🎯 Outcomes by hour")
            posTop?.let { B("Positive outcomes (Interested, Ready to pay): most at ${slotOf(it.i("hr"))} (${it.i("pos")})") }
            later?.let { B("\"${it.s("label")}\": mostly at ${slotOf(it.i("hr"))} (${it.i("n")} times)") }
            outs.filter { it.s("category") == "lost" }.maxByOrNull { it.i("n") }?.let { B("\"${it.s("label")}\": mostly at ${slotOf(it.i("hr"))} (${it.i("n")} times)") }
            if (noOut > 0 && noOutTop != null) B("No outcome saved yet: $noOut calls, most at ${slotOf(noOutTop.i("hr"))}") { open(noOutTop.i("hr")) }
        }
        if (team90 != null) {
            H("🏆 Best hour, last 90 days")
            if (oneUser != null || me) per.firstOrNull()?.let { B("${if (me) "You" else team.firstOrNull { t -> t.id == it.first }?.name ?: "This person"}: ${slotOf(it.second.hr)} · ${it.second.conn} conversations · ${fmtDur(it.second.talk)} of talk") }
            else {
                B("Whole team: ${slotOf(team90.hr)} · ${team90.conn} conversations · ${fmtDur(team90.talk)} of talk")
                per.forEach { (u, b) -> B("${team.firstOrNull { it.id == u }?.name ?: "Someone"}: ${slotOf(b.hr)} · ${b.conn} conversations · ${fmtDur(b.talk)} of talk") }
            }
        }
        if ((ins?.i("missed") ?: 0) > 0) {
            H("📞 Calls to return")
            B("${ins!!.i("missed")} missed incoming calls" + if (missedOpen > 0) ", $missedOpen not called back yet" else ", all called back ✓")
        }
        H("📌 Suggestions")
        B("Put ${you}follow-ups and hot leads at ${slotOf(best.hr)}.",
            "it gave the best mix of conversations and talk (${best.conn} conversations · ${fmtDur(best.talk)}), so the people you most need to reach are most likely to talk then.")
        if (busy.hr != hi.hr && busy.calls >= 3) {
            val move = minOf(10, busy.calls / 3); val gain = (move * (hi.conn.toFloat() / hi.calls - busy.conn.toFloat() / busy.calls)).toInt()
            if (gain > 0) B("Move about $move of the ${busy.calls} calls made at ${slotOf(busy.hr)} to ${slotOf(hi.hr)}. That could give about $gain more conversations.",
                "only ${pc(busy.conn, busy.calls)}% picked up at ${slotOf(busy.hr)}, against ${pc(hi.conn, hi.calls)}% at ${slotOf(hi.hr)}. The same calls reach more people at a better hour.")
        }
        if (tNp > 0) B("Try the $tNp calls that weren't picked up again at ${slotOf(hi.hr)}.",
            "${slotOf(hi.hr)} had the highest pick-up (${pc(hi.conn, hi.calls)}%), so a second try then has the best chance of being answered.")
        if (later != null && later.i("hr") != best.hr) B("Plan the ${later.i("n")} \"${later.s("label")}\" call-backs for ${slotOf(best.hr)}.",
            "people who ask for a call later are interested but were busy. ${slotOf(best.hr)} is when conversations go best.")
        if (missedOpen > 0) B("Call back the $missedOpen missed callers who haven't heard back yet.",
            "they called first, so they want to talk. A quick call back is the easiest conversation of the day, and waiting lets the interest cool.")
        if ((isToday && nowHour <= 20) || empty.isNotEmpty()) {
            H("🕐 Still to come")
            if (isToday && nowHour <= 20) B("The day isn't over yet. It's ${now.format(DateTimeFormatter.ofPattern("h:mm a"))}, so calls from ${hl(nowHour)} – ${hl(21)} will be added as they happen, and the best hour may still change.")
            if (empty.isNotEmpty()) B("${empty.joinToString(", ") { slotOf(it) }} passed without any calls, so there's nothing to compare yet. A few calls then will show whether it works.")
        }
        Text("How \"best hour\" is chosen: conversations, talk time and positive outcomes count equally. Every hour is included.", fontSize = 11.sp, color = Brand.muted, modifier = Modifier.padding(top = 8.dp))
    }
}
