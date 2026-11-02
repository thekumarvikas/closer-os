package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import com.closeros.app.data.Backend
import com.closeros.app.data.BoardRow
import com.closeros.app.data.Repo

private val medals = listOf("🥇", "🥈", "🥉")

/** Home card: my rank today. */
@Composable
fun LeaderboardCard(vm: AppViewModel) {
    val rows = vm.leaderboard
    if (rows.size < 2) return
    val me = rows.indexOfFirst { it.user_id == Backend.uid }
    Card(Modifier.fillMaxWidth().clickable { vm.showLeaderboard = true }, colors = CardDefaults.cardColors(containerColor = Color(0xFFFFFBEB))) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("🏆 Leaderboard today", fontWeight = FontWeight.SemiBold)
                Text(if (me >= 0) "You are #${me + 1} of ${rows.size} · leader: ${rows[0].name.substringBefore(' ')} (${fmtDur(rows[0].talk_sec)})"
                     else "Leader: ${rows[0].name} · ${fmtDur(rows[0].talk_sec)}", fontSize = 13.sp, color = Brand.muted)
            }
            Text("Open ›", color = Brand.primary, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun LeaderboardScreen(vm: AppViewModel) {
    BackHandler { vm.showLeaderboard = false }
    var period by remember { mutableStateOf("today") }
    var metric by remember { mutableStateOf("talk") }
    var rows by remember { mutableStateOf<List<BoardRow>?>(null) }
    LaunchedEffect(period) { rows = null; rows = vm.membership?.let { runCatching { Repo.leaderboard(it.organization, period) }.getOrNull() } ?: emptyList() }
    val sorted = rows?.sortedByDescending { when (metric) { "conv" -> it.conversations; "calls" -> it.calls; "sales" -> it.sales; else -> it.talk_sec } }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showLeaderboard = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Text("🏆 Leaderboard", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("today" to "Today", "week" to "This week", "month" to "This month").forEach { (k, l) -> FilterChip(period == k, { period = k }, { Text(l) }) }
        }
        Row(Modifier.padding(12.dp, 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("talk" to "Talk time", "conv" to "Conversations", "calls" to "Calls", "sales" to "Sales").forEach { (k, l) -> FilterChip(metric == k, { metric = k }, { Text(l) }) }
        }
        if (sorted == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (sorted.isEmpty()) item { Text("No one to show yet.", color = Brand.muted) }
            itemsIndexed(sorted, key = { _, r -> r.user_id }) { i, r ->
                val mine = r.user_id == Backend.uid
                Row(Modifier.fillMaxWidth().background(if (mine) Brand.light else Color.White, RoundedCornerShape(10.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(medals.getOrNull(i) ?: "#${i + 1}", fontSize = 20.sp, modifier = Modifier.width(44.dp))
                    Column(Modifier.weight(1f)) {
                        Text(r.name + if (mine) " (you)" else "", fontWeight = FontWeight.SemiBold)
                        Text("${fmtDur(r.talk_sec)} talk · ${r.conversations} conversations · ${r.calls} calls · ${r.sales} sales", fontSize = 12.sp, color = Brand.muted)
                    }
                    Text(when (metric) { "conv" -> "${r.conversations}"; "calls" -> "${r.calls}"; "sales" -> "${r.sales}"; else -> fmtDur(r.talk_sec) }, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                }
            }
        }
    }
}

/** "Best time to call" hint for a lead (their usual pick-up hour, or the team's best hour). */
@Composable
fun BestTimeLine(leadId: String) {
    var bt by remember(leadId) { mutableStateOf<com.closeros.app.data.BestTime?>(null) }
    LaunchedEffect(leadId) { bt = Repo.bestTime(leadId) }
    val b = bt ?: return
    val h = b.hour
    val label = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
    Text(if (b.source == "lead") "⏰ Best time to call: around $label (picked up ${b.picked} of ${b.tries} calls then)"
         else "⏰ Best time to call: around $label (your team's best hour — ${b.rate}% pick up)", fontSize = 13.sp, color = Color(0xFF92400E))
}
