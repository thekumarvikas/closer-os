package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.BatchRow
import com.closeros.app.data.BatchSummary
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ───────────── Webinars & events ─────────────

@Composable
fun BatchesScreen(vm: AppViewModel) {
    BackHandler { vm.showBatches = false }
    LaunchedEffect(Unit) { vm.loadBatches() }
    val zone = ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata")
    val list = vm.batches
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showBatches = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Text("Webinars & events", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.loadBatches() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        if (vm.isManager) Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Switch(vm.listEveryone, { vm.listEveryone = it })
            Spacer(Modifier.width(8.dp)); Text(if (vm.listEveryone) "Showing my whole team's leads" else "Showing only my leads", fontSize = 14.sp)
        }
        if (list == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (list.isEmpty()) item { Text("No webinars or events with leads for you in the last 4 months. They're created on the dashboard (Events & Batches).", color = Brand.muted) }
            items(list.distinctBy { it.id }, key = { it.id }) { b ->
                val at = runCatching { Instant.parse(b.webinar_at).atZone(zone) }.getOrNull()
                val upcoming = at?.toInstant()?.isAfter(Instant.now()) == true
                val rem = if (vm.listEveryone) b.reminder_all else b.reminder_mine
                val sal = if (vm.listEveryone) b.sales_all else b.sales_mine
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(b.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                        Text("${b.kind.replaceFirstChar { it.uppercase() }} · ${at?.format(DateTimeFormatter.ofPattern("EEE dd MMM, h:mm a")) ?: ""}" +
                            if (upcoming) " · upcoming" else if (b.zoom_uploaded) " · ${b.attended} attended" else " · attendance not uploaded yet",
                            color = Brand.muted, fontSize = 13.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (upcoming) {
                                Button(onClick = { vm.openBatchList(b, "reminder") }, enabled = rem > 0) { Text("Reminder calls ($rem)") }
                                OutlinedButton(onClick = { vm.openBatchList(b, "sales") }, enabled = sal > 0) { Text("Sales ($sal)") }
                            } else {
                                Button(onClick = { vm.openBatchList(b, "sales") }, enabled = sal > 0) { Text("Sales calls ($sal)") }
                                OutlinedButton(onClick = { vm.openBatchList(b, "reminder") }, enabled = rem > 0) { Text("Reminder ($rem)") }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ───────────── One webinar's calling list: filter + sort ─────────────

@Serializable
data class ListPrefs(
    val attendance: String = "all",      // all | hot | attended | low | absent
    val status: String = "all",          // all | new | not_talked | talked | due
    val cats: List<String> = emptyList(),// profession groups, in the rep's priority order ("none" = no group)
    val outcomes: List<String> = emptyList(),
    val sources: List<String> = emptyList(),
    val repeat: String = "all",          // all | new | repeat
    val hideBought: Boolean = true,
    val search: String = "",
    val sort1: String = "watch_desc",
    val sort2: String = "none",
)

private val prefsJson = Json { ignoreUnknownKeys = true }

val sortOptions = listOf(
    "watch_desc" to "Watch time: highest first",
    "watch_asc" to "Watch time: lowest first",
    "cat_order" to "Profession group: my order",
    "reg_new" to "Registered: newest first",
    "reg_old" to "Registered: oldest first",
    "attempts_asc" to "Fewest calls first",
    "last_called_old" to "Not called for longest",
    "followup_soon" to "Next call due soonest",
    "name" to "Name A–Z",
    "city" to "City A–Z",
)

private fun comparatorFor(key: String, cats: List<String>): Comparator<BatchRow>? = when (key) {
    "watch_desc" -> compareByDescending<BatchRow> { it.watch_minutes ?: -1 }
    "watch_asc" -> compareBy { it.watch_minutes ?: Int.MAX_VALUE }
    "cat_order" -> compareBy { cats.indexOf(it.category_id ?: "none").let { i -> if (i < 0) Int.MAX_VALUE else i } }
    "reg_new" -> compareByDescending { it.registered_at ?: "" }
    "reg_old" -> compareBy { it.registered_at ?: "~" }
    "attempts_asc" -> compareBy { it.attempts }
    "last_called_old" -> compareBy { it.last_called_at ?: "" }
    "followup_soon" -> compareBy { it.next_follow_up_at ?: "~" }
    "name" -> compareBy { it.name.lowercase().ifBlank { "~" } }
    "city" -> compareBy { it.city?.lowercase()?.ifBlank { null } ?: "~" }
    else -> null
}

fun applyPrefs(rows: List<BatchRow>, p: ListPrefs, hot: Int): List<BatchRow> {
    val now = Instant.now().toString()
    val q = p.search.trim().lowercase()
    val filtered = rows.filter { r ->
        val w = r.watch_minutes ?: 0
        (when (p.attendance) { "hot" -> r.is_hot; "attended" -> w > 0; "low" -> w in 1 until hot; "absent" -> w == 0; else -> true }) &&
        (when (p.status) { "new" -> r.attempts == 0; "not_talked" -> r.attempts > 0 && !r.talked; "talked" -> r.talked
            "due" -> r.next_follow_up_at != null && r.next_follow_up_at <= now; else -> true }) &&
        (p.cats.isEmpty() || (r.category_id ?: "none") in p.cats) &&
        (p.outcomes.isEmpty() || (r.last_outcome_id ?: "none") in p.outcomes) &&
        (p.sources.isEmpty() || (r.source ?: "") in p.sources) &&
        (when (p.repeat) { "new" -> !r.is_repeat; "repeat" -> r.is_repeat; else -> true }) &&
        (!p.hideBought || !r.bought) && !r.do_not_call &&
        (q.isEmpty() || listOfNotNull(r.name, r.profession, r.company, r.city, r.category, r.phone).any { it.lowercase().contains(q) })
    }
    val c1 = comparatorFor(p.sort1, p.cats) ?: return filtered
    val c2 = comparatorFor(p.sort2, p.cats)
    return filtered.sortedWith(if (c2 != null) c1.then(c2) else c1)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BatchListScreen(vm: AppViewModel) {
    val (batch, purpose) = vm.openList ?: return
    BackHandler { vm.openList = null }
    var prefs by remember(purpose) {
        mutableStateOf(vm.store.listPrefs(purpose)?.let { runCatching { prefsJson.decodeFromString<ListPrefs>(it) }.getOrNull() }
            ?: ListPrefs(sort1 = if (purpose == "sales") "watch_desc" else "attempts_asc", sort2 = if (purpose == "sales") "none" else "reg_new"))
    }
    fun update(p: ListPrefs) { prefs = p; vm.store.setListPrefs(purpose, prefsJson.encodeToString(p)) }
    var showFilters by remember { mutableStateOf(false) }
    val rows = vm.listRows
    val shown = remember(rows, prefs) { rows?.let { applyPrefs(it, prefs, batch.hot_minutes) } ?: emptyList() }

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.openList = null }) { Icon(Icons.Default.ArrowBack, "Back") }
            Column(Modifier.weight(1f)) {
                Text(if (purpose == "sales") "Sales calls" else "Reminder calls", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(batch.name, fontSize = 13.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = { vm.loadList() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        if (rows == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }

        LazyColumn(contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Showing ${shown.size} of ${rows.size}", fontWeight = FontWeight.SemiBold)
                                Text("Sorted: " + (sortOptions.firstOrNull { it.first == prefs.sort1 }?.second ?: "") +
                                    (sortOptions.firstOrNull { it.first == prefs.sort2 }?.second?.let { ", then $it" } ?: ""), fontSize = 12.sp, color = Brand.muted)
                            }
                            TextButton(onClick = { showFilters = !showFilters }) { Text(if (showFilters) "Done" else "Sort & filter") }
                        }
                        if (showFilters) FilterPanel(vm, rows, prefs, purpose, batch, ::update)
                        Button(onClick = { vm.callList(shown) }, enabled = shown.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(48.dp)) {
                            Icon(Icons.Default.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Call these ${shown.size} in order")
                        }
                    }
                }
            }
            if (shown.isEmpty()) item { Text("No leads match these filters.", color = Brand.muted, modifier = Modifier.padding(8.dp)) }
            itemsIndexed(shown.distinctBy { it.id }, key = { _, r -> r.id }) { i, r -> BatchRowCard(vm, r, i + 1) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterPanel(vm: AppViewModel, rows: List<BatchRow>, p: ListPrefs, purpose: String, batch: BatchSummary, update: (ListPrefs) -> Unit) {
    fun toggle(list: List<String>, v: String) = if (v in list) list - v else list + v
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(p.search, { update(p.copy(search = it)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            label = { Text("Search profession, company, city, name") }, placeholder = { Text("e.g. engineer") })

        Label("Sort by")
        SortPicker(p.sort1, false) { update(p.copy(sort1 = it)) }
        Label("Then by")
        SortPicker(p.sort2, true) { update(p.copy(sort2 = it)) }

        if (purpose == "sales" || batch.zoom_uploaded) {
            Label("Webinar attendance")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("all" to "All", "hot" to "🔥 ${batch.hot_minutes}+ min", "attended" to "Attended", "low" to "Joined < ${batch.hot_minutes} min", "absent" to "Didn't attend")
                    .forEach { (k, l) -> Pill("$l (${count(rows, p.copy(attendance = k), batch.hot_minutes)})", p.attendance == k) { update(p.copy(attendance = k)) } }
            }
        }

        Label("Calling status")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("all" to "All", "new" to "Not called yet", "not_talked" to "Called, no talk", "talked" to "Talked", "due" to "Follow-up due")
                .forEach { (k, l) -> Pill("$l (${count(rows, p.copy(status = k), batch.hot_minutes)})", p.status == k) { update(p.copy(status = k)) } }
        }

        val groups = rows.groupBy { it.category_id ?: "none" }
        Label("Profession group — tap in your order of priority")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val names = vm.categories.associate { it.id to it.name }
            groups.keys.sortedBy { k -> vm.categories.indexOfFirst { it.id == k }.let { if (it < 0) 999 else it } }.forEach { k ->
                val i = p.cats.indexOf(k)
                Pill((if (i >= 0) "${i + 1}. " else "") + (names[k] ?: groups[k]?.firstOrNull()?.category ?: "No group") + " (${groups[k]?.size ?: 0})", i >= 0) {
                    val cats = toggle(p.cats, k)
                    update(p.copy(cats = cats, sort1 = if (cats.size > 1 && p.cats.size <= 1 && p.sort1 != "cat_order") "cat_order" else p.sort1,
                        sort2 = if (cats.size > 1 && p.cats.size <= 1 && p.sort1 != "cat_order") p.sort1 else p.sort2))
                }
            }
        }
        if (p.cats.size > 1) Text("Leads are called group by group in this order when sorted by \"Profession group: my order\".", fontSize = 12.sp, color = Brand.muted)

        val outs = rows.mapNotNull { it.last_outcome_id }.distinct()
        if (outs.isNotEmpty()) {
            Label("Last outcome")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                (outs + "none").forEach { k ->
                    val label = if (k == "none") "No outcome yet" else vm.outcomes.firstOrNull { it.id == k }?.label ?: "Other"
                    Pill("$label (${rows.count { (it.last_outcome_id ?: "none") == k }})", k in p.outcomes) { update(p.copy(outcomes = toggle(p.outcomes, k))) }
                }
            }
        }

        val sources = rows.mapNotNull { it.source?.ifBlank { null } }.distinct()
        if (sources.size > 1) {
            Label("Lead source")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                sources.forEach { s -> Pill("$s (${rows.count { it.source == s }})", s in p.sources) { update(p.copy(sources = toggle(p.sources, s))) } }
            }
        }

        Label("New or repeat registrations")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("all" to "All", "new" to "New", "repeat" to "Repeat").forEach { (k, l) -> Pill(l, p.repeat == k) { update(p.copy(repeat = k)) } }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(p.hideBought, { update(p.copy(hideBought = it)) }); Text("Hide people who already bought", fontSize = 14.sp)
        }
        TextButton(onClick = { update(ListPrefs(sort1 = p.sort1, sort2 = p.sort2)) }) { Text("Clear all filters") }
    }
}

private fun count(rows: List<BatchRow>, p: ListPrefs, hot: Int) = applyPrefs(rows, p.copy(sort1 = "none", sort2 = "none"), hot).size

@Composable
private fun SortPicker(value: String, allowNone: Boolean, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val opts = (if (allowNone) listOf("none" to "Nothing else") else emptyList()) + sortOptions
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(opts.firstOrNull { it.first == value }?.second ?: "Choose", modifier = Modifier.weight(1f)); Text("▾") }
        DropdownMenu(open, { open = false }) {
            opts.forEach { (k, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { onPick(k); open = false }) }
        }
    }
}

@Composable private fun Label(t: String) = Text(t, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)

@Composable
private fun Pill(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(label,
        modifier = Modifier.background(if (selected) Brand.primary else Color.White, RoundedCornerShape(50))
            .border(1.dp, if (selected) Brand.primary else Color(0xFFCBD5E1), RoundedCornerShape(50))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp),
        color = if (selected) Color.White else Color(0xFF1E293B), fontSize = 13.sp)
}

@Composable
private fun BatchRowCard(vm: AppViewModel, r: BatchRow, n: Int) {
    Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).clickable { vm.openLeadId = r.id }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text("$n", color = Brand.muted, fontSize = 12.sp, modifier = Modifier.width(28.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(r.name.ifBlank { fmtPhone(r.phone) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                r.watch_minutes?.let { w ->
                    Spacer(Modifier.width(6.dp))
                    Text(if (r.is_hot) "🔥 $w min" else if (w > 0) "$w min" else "absent", fontSize = 12.sp,
                        color = if (r.is_hot) Color(0xFFC2410C) else if (w > 0) Brand.primaryDark else Brand.muted,
                        modifier = Modifier.background(if (r.is_hot) Color(0xFFFFEDD5) else Color(0xFFF1F5F9), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
                }
            }
            Text(listOfNotNull(r.category, r.profession?.takeIf { it.isNotBlank() && it != r.category }, r.city).joinToString(" · ").ifBlank { "No profession yet" },
                fontSize = 13.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val last = r.last_outcome_id?.let { id -> vm.outcomes.firstOrNull { it.id == id }?.label }
            Text((if (r.attempts == 0) "Not called yet" else "${r.attempts} call${if (r.attempts > 1) "s" else ""}" + (if (r.talked) " · talked" else " · no talk yet")) +
                (last?.let { " · $it" } ?: "") + (if (r.is_repeat) " · repeat" else "") + (if (r.bought) " · bought" else ""),
                fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = { vm.callFromList(r) }) { Icon(Icons.Default.Call, "Call", tint = Brand.primary) }
    }
}
