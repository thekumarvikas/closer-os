package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.material.icons.filled.Send
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadFilters
import com.closeros.app.data.LocalLeads
import com.closeros.app.data.TalkBands

/** Default filters shown when the company hasn't chosen its own (dashboard Settings → App lead filters). */
val defaultLeadFilters = listOf("followup", "outcome", "stage", "source", "category", "city", "never_called")

/** Leads tab: search, company-chosen filters, and picking leads to call in a queue. */
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun LeadsTab(vm: AppViewModel, onCall: (Lead) -> Unit) {
    var showFilters by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (vm.filterOptions == null) vm.loadFilterOptions() }
    BackHandler(enabled = vm.selectMode) { vm.selectMode = false; vm.selected.clear() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp, 12.dp, 16.dp, 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(vm.leadsQuery, { vm.search(it) }, placeholder = { Text("Search name or phone") }, singleLine = true,
                leadingIcon = { Icon(Icons.Default.Search, null) }, modifier = Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = vm.leadFilters.count > 0, onClick = { showFilters = true },
                label = { Text(if (vm.leadFilters.count > 0) "Filters (${vm.leadFilters.count})" else "Filter") })
            if (vm.leadFilters.count > 0) TextButton(onClick = { vm.applyFilters(LeadFilters()) }) { Text("Clear") }
            Spacer(Modifier.weight(1f))
            FilterChip(selected = vm.selectMode, onClick = { vm.selectMode = !vm.selectMode; if (!vm.selectMode) vm.selected.clear() },
                label = { Text(if (vm.selectMode) "Selecting" else "Select to call / WhatsApp") })
        }
        if (vm.selectMode) Row(Modifier.fillMaxWidth().background(Brand.light).padding(12.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (vm.selected.isEmpty()) "Tap leads to pick them" else "${vm.selected.size} selected", modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            TextButton(onClick = { vm.leads.forEach { if (!it.do_not_call) vm.selected[it.id] = it } }) { Text("All") }
            if (vm.isSolo) { IconButton(onClick = { vm.eventPickFor = vm.selected.values.toList() }, enabled = vm.selected.isNotEmpty()) { Text("📅", fontSize = 18.sp) } }
            IconButton(onClick = { vm.seqPick = AppViewModel.SeqPick(vm.selected.keys.toList(), "${vm.selected.size} lead${if (vm.selected.size == 1) "" else "s"}") }, enabled = vm.selected.isNotEmpty()) { Text("📨", fontSize = 18.sp) }
            OutlinedButton(onClick = { vm.waChooseFor = vm.selected.values.toList() }, enabled = vm.selected.isNotEmpty(), contentPadding = PaddingValues(horizontal = 10.dp)) {
                Icon(Icons.Default.Send, null, Modifier.size(16.dp), tint = Color(0xFF16A34A)); Spacer(Modifier.width(4.dp)); Text("WA ${vm.selected.size}") }
            Spacer(Modifier.width(6.dp))
            Button(onClick = { vm.callSelected() }, enabled = vm.selected.isNotEmpty(), contentPadding = PaddingValues(horizontal = 12.dp)) { Icon(Icons.Default.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Call ${vm.selected.size}") }
        } else if (vm.leads.isNotEmpty()) TextButton(onClick = { vm.startQueue(vm.leads.toList()) }, modifier = Modifier.padding(horizontal = 4.dp)) {
            Icon(Icons.Default.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Call all ${vm.leads.size}${if (vm.leadsEnd) "" else "+"} in a queue")
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(vm.leads.distinctBy { it.id }, key = { it.id }) { l ->
                if (vm.selectMode) {
                    val on = vm.selected.containsKey(l.id)
                    Row(Modifier.fillMaxWidth().background(if (on) Color(0xFFE6F4F1) else Color.White, RoundedCornerShape(10.dp))
                        .combinedClickable(enabled = !l.do_not_call, onClick = { vm.toggleSelect(l) }).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(on, { vm.toggleSelect(l) }, enabled = !l.do_not_call)
                        Column(Modifier.weight(1f)) {
                            Text(l.name.ifBlank { fmtPhone(l.phone) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(listOfNotNull(l.profession, l.city, vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.label, l.next_follow_up_at?.let { "next ${fmtWhen(it)}" })
                                .filter { it.isNotBlank() }.joinToString(" · "), fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } else Box(Modifier.combinedClickable(onClick = { vm.openLeadId = l.id }, onLongClick = { vm.selectMode = true; vm.toggleSelect(l) })) { LeadCard(vm, l, onCall) }
            }
            item {
                if (vm.leadsLoading) Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else if (vm.leads.isEmpty()) Text(if (vm.leadFilters.count > 0) "No leads match these filters." else "No leads yet. Leads assigned to you on the dashboard appear here.",
                    color = Brand.muted, modifier = Modifier.padding(16.dp))
                else if (!vm.leadsEnd) LaunchedEffect(vm.leads.size) { vm.loadMoreLeads() }
            }
        }
    }
    if (showFilters) FilterSheet(vm) { showFilters = false }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FilterSheet(vm: AppViewModel, onClose: () -> Unit) {
    var f by remember { mutableStateOf(vm.leadFilters) }
    val o = vm.filterOptions
    val enabled = o?.enabled ?: (defaultLeadFilters + (o?.custom?.map { "custom.${it.key}" } ?: emptyList()))
    fun <T> Set<T>.flip(v: T) = if (v in this) this - v else this + v
    ModalBottomSheet(onDismissRequest = onClose) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp, 0.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Filter leads", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            if (o == null) { Text("Loading…", color = Brand.muted); return@Column }
            @Composable fun Section(title: String, content: @Composable () -> Unit) {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
            }
            // Call type / effort filters — always available.
            Section("Last call") {
                listOf("any" to "Any", "talked" to "Talked", "not_picked" to "Not picked up", "missed" to "Missed their call", "never" to "Never called",
                    "tried3" to "Tried 3+, never talked").forEach { (k, l) -> FilterChip(f.lastCall == k, { f = f.copy(lastCall = k) }, { Text(l) }) }
            }
            Section("Total talk time with the lead") {
                val ctx = androidx.compose.ui.platform.LocalContext.current
                val counts = remember { runCatching { LocalLeads.all(ctx).groupingBy { TalkBands.of(it.total_talk_sec) }.eachCount() }.getOrDefault(emptyMap()) }
                TalkBands.all.forEach { b ->
                    val n = counts[b.key]
                    FilterChip(b.key in f.talk, { f = f.copy(talk = f.talk.flip(b.key)) }, { Text(b.label + (n?.let { " · $it" } ?: "")) })
                }
            }
            // Events (individual app: own events; company: webinars / sales events).
            val events = vm.batches.orEmpty()
            LaunchedEffect(Unit) { if (vm.batches == null) vm.loadBatches(quiet = true) }
            if (events.isNotEmpty()) Section(if (vm.isSolo) "Event" else "Webinar / event") {
                events.forEach { e -> FilterChip(e.id in f.events, { f = f.copy(events = f.events.flip(e.id)) }, { Text(e.name) }) }
            }
            Section("WhatsApp") {
                listOf("any" to "Any", "yes" to "Messaged", "no" to "Not messaged").forEach { (k, l) -> FilterChip(f.messaged == k, { f = f.copy(messaged = k) }, { Text(l) }) }
                FilterChip(f.hot, { f = f.copy(hot = !f.hot) }, { Text("⚡ Close to converting") })
            }
            vm.membership?.organization?.tagGroups?.forEach { g ->
                Section(g.name) { g.tags.forEach { t -> FilterChip(t in f.tags, { f = f.copy(tags = f.tags.flip(t)) }, { Text(t) }) } }
            }
            enabled.forEach { key ->
                when {
                    key == "followup" -> Section("Next call") {
                        listOf("all" to "Any", "overdue" to "Overdue", "today" to "Due today", "upcoming" to "Later", "none" to "Not scheduled").forEach { (k, l) ->
                            FilterChip(f.followup == k, { f = f.copy(followup = k) }, { Text(l) }) }
                    }
                    key == "outcome" && vm.outcomes.isNotEmpty() -> Section("Last outcome") {
                        vm.outcomes.forEach { oc -> FilterChip(oc.id in f.outcomes, { f = f.copy(outcomes = f.outcomes.flip(oc.id)) }, { Text(oc.label) }) }
                    }
                    key == "stage" && o.stages.isNotEmpty() -> Section("Stage") {
                        o.stages.forEach { s -> FilterChip(s.id in f.stages, { f = f.copy(stages = f.stages.flip(s.id)) }, { Text(s.name) }) }
                    }
                    key == "source" && o.sources.isNotEmpty() -> Section("Source") {
                        o.sources.forEach { s -> FilterChip(s in f.sources, { f = f.copy(sources = f.sources.flip(s)) }, { Text(s) }) }
                    }
                    key == "campaign" && o.campaigns.isNotEmpty() -> Section("Campaign") {
                        o.campaigns.forEach { s -> FilterChip(s in f.campaigns, { f = f.copy(campaigns = f.campaigns.flip(s)) }, { Text(s) }) }
                    }
                    key == "category" && o.categories.isNotEmpty() -> Section("Profession group") {
                        o.categories.forEach { s -> FilterChip(s.id in f.categories, { f = f.copy(categories = f.categories.flip(s.id)) }, { Text(s.name) }) }
                    }
                    key == "city" && o.cities.isNotEmpty() -> Section("City") {
                        o.cities.forEach { s -> FilterChip(s in f.cities, { f = f.copy(cities = f.cities.flip(s)) }, { Text(s) }) }
                    }
                    key == "never_called" -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(f.neverCalled, { f = f.copy(neverCalled = it) }); Text("Never called yet")
                    }
                    key.startsWith("custom.") -> o.custom.firstOrNull { "custom.${it.key}" == key }?.takeIf { it.values.isNotEmpty() }?.let { c ->
                        Section(c.label) {
                            c.values.forEach { v ->
                                val cur = f.custom[c.key].orEmpty()
                                FilterChip(v in cur, { f = f.copy(custom = f.custom + (c.key to cur.flip(v))) }, { Text(v) })
                            }
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { f = LeadFilters() }, modifier = Modifier.weight(1f)) { Text("Clear") }
                Button(onClick = { vm.applyFilters(f); onClose() }, modifier = Modifier.weight(1f)) { Text("Show leads") }
            }
        }
    }
}
