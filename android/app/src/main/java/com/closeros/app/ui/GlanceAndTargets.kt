package com.closeros.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.NoteEntry
import com.closeros.app.data.Progress
import com.closeros.app.data.Repo

/** Home: today's targets with progress bars (set by the manager on the dashboard). */
@Composable
fun TargetsCard(p: Progress) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Today's targets", fontWeight = FontWeight.SemiBold)
            listOf(
                Triple("Calls dialled", p.actual.calls ?: 0, p.target.calls),
                Triple("Conversations", p.actual.conversations ?: 0, p.target.conversations),
                Triple("Talk time (min)", p.actual.talk_minutes ?: 0, p.target.talk_minutes),
                Triple("Sales", p.actual.sales ?: 0, p.target.sales),
            ).filter { (it.third ?: 0) > 0 }.forEach { (label, a, t) ->
                val pct = a * 100 / t!!
                Column {
                    Row { Text(label, fontSize = 14.sp, modifier = Modifier.weight(1f)); Text("$a / $t", fontSize = 14.sp, fontWeight = FontWeight.SemiBold); Text("  $pct%", fontSize = 13.sp, color = Brand.muted) }
                    LinearProgressIndicator(progress = { (a.toFloat() / t).coerceAtMost(1f) }, modifier = Modifier.fillMaxWidth().height(6.dp),
                        color = if (pct >= 100) Color(0xFF10B981) else if (pct >= 70) Color(0xFFF59E0B) else Brand.primary, trackColor = Color(0xFFE2E8F0))
                }
            }
        }
    }
}

/** Queue: a quick look at the next lead before the call — key facts, last call and note, webinar. */
@Composable
fun GlanceCard(vm: AppViewModel, base: Lead) {
    var lead by remember(base.id) { mutableStateOf(base) }
    var notes by remember(base.id) { mutableStateOf<List<NoteEntry>?>(null) }
    LaunchedEffect(base.id) {
        runCatching { Repo.lead(base.id) }.getOrNull()?.let { lead = it }
        notes = runCatching { Repo.leadNotes(base.id) }.getOrDefault(emptyList())
    }
    val l = lead
    val tags = leadTags(vm, l)
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(l.name.ifBlank { fmtPhone(l.phone) }, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(fmtPhone(l.phone), l.profession, l.company, l.city).filter { it.isNotBlank() }.joinToString(" · "), color = Brand.muted, fontSize = 14.sp)
            if (tags.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tags.forEach { t -> Text(t.text, fontSize = 12.sp, color = t.fg, modifier = Modifier.background(t.bg, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp)) }
            }
            l.latestBatch?.let { b ->
                Text("🎥 ${b.batch?.name ?: "Webinar"}: " + when { b.watch_minutes == null -> "attendance not uploaded"; b.watch_minutes > 0 -> "watched ${b.watch_minutes} min"; else -> "didn't join" }, fontSize = 14.sp)
            }
            l.key_facts?.takeIf { it.isNotBlank() }?.let {
                Text("📌 $it", fontSize = 14.sp, modifier = Modifier.fillMaxWidth().background(Color(0xFFFFFBEB), RoundedCornerShape(8.dp)).padding(10.dp))
            }
            val last = notes?.firstOrNull()
            val lastOutcome = vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.label
            when {
                notes == null -> Text("Loading last call…", fontSize = 13.sp, color = Brand.muted)
                l.last_call_at == null && last == null -> Text("First call to this lead", fontSize = 14.sp, color = Brand.primaryDark)
                else -> Column(Modifier.fillMaxWidth().background(Color(0xFFF8FAFC), RoundedCornerShape(8.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Last call: " + listOfNotNull(l.last_call_at?.let { fmtWhen(it) }, lastOutcome).joinToString(" · "), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    last?.let { n ->
                        Text(listOfNotNull(n.text, n.tags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" }).joinToString("  "), fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Text("${fmtWhen(n.at)}${n.by?.let { " · $it" } ?: ""}", fontSize = 11.sp, color = Brand.muted)
                    }
                }
            }
        }
    }
}
