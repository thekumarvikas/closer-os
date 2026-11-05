package com.closeros.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
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
import com.closeros.app.data.FollowUp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Same rule as the dashboard: on time = called within 15 minutes of the due time. */
private const val GRACE_MS = 15 * 60_000L

enum class FuState { Upcoming, DueNow, NotCalled, OnTime, Late }

fun fuState(f: FollowUp, now: Long): FuState {
    val due = runCatching { com.closeros.app.data.parseInstant(f.due_at).toEpochMilli() }.getOrDefault(now)
    val dialled = f.dialled_at?.let { runCatching { com.closeros.app.data.parseInstant(it).toEpochMilli() }.getOrNull() }
    return when {
        dialled != null && dialled <= due + GRACE_MS -> FuState.OnTime
        dialled != null -> FuState.Late
        now > due + GRACE_MS -> FuState.NotCalled
        now >= due -> FuState.DueNow
        else -> FuState.Upcoming
    }
}

private fun mins(ms: Long): String {
    val m = (ms / 60_000).coerceAtLeast(1)
    return when { m >= 1440 -> "${m / 1440}d ${m % 1440 / 60}h"; m >= 60 -> "${m / 60}h ${m % 60}m"; else -> "$m min" }
}

@Composable
fun FollowUpsTabs(vm: AppViewModel) {
    val zone = runCatching { ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata") }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { vm.refreshHome() }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(30_000); now = System.currentTimeMillis() } }
    val today = LocalDate.now(zone)
    val endOfToday = today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
    fun dueMs(f: FollowUp) = runCatching { com.closeros.app.data.parseInstant(f.due_at).toEpochMilli() }.getOrDefault(0)

    val pending = vm.followUps
    val overdue = pending.filter { fuState(it, now) == FuState.NotCalled }.sortedBy { it.due_at }
    val dueNow = pending.filter { fuState(it, now) == FuState.DueNow || (fuState(it, now) == FuState.Upcoming && dueMs(it) < endOfToday) }.sortedBy { it.due_at }
    val upcoming = pending.filter { fuState(it, now) == FuState.Upcoming && dueMs(it) >= endOfToday }.sortedBy { it.due_at }
    // Called (pending ones already dialled, waiting for the outcome, plus finished ones of the last 7 days).
    val pendingDialled = pending.filter { it.dialled_at != null }
    val past = (vm.pastFollowUps + pendingDialled).distinctBy { it.id }.sortedByDescending { it.due_at }
    val late = past.filter { fuState(it, now) == FuState.Late || (it.dialled_at == null && fuState(it, now) == FuState.NotCalled) }
    val onTime = past.filter { fuState(it, now) == FuState.OnTime }

    val tabs = listOf(
        "today" to "Today (${dueNow.size})",
        "overdue" to "Not called (${overdue.size})",
        "upcoming" to "Upcoming (${upcoming.size})",
        "late" to "Called late (${late.count { it.dialled_at != null }})",
        "ontime" to "On time (${onTime.size})",
    )
    var tab by remember { mutableStateOf(if (overdue.isNotEmpty()) "overdue" else "today") }
    val shown = when (tab) { "overdue" -> overdue - pendingDialled.toSet(); "upcoming" -> upcoming; "late" -> late.filter { it.dialled_at != null }; "ontime" -> onTime; else -> dueNow - pendingDialled.toSet() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp, 12.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Follow-ups", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.refreshHome(); now = System.currentTimeMillis() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        // Last 7 days at a glance.
        val done = onTime.size + late.count { it.dialled_at != null }
        val missedCount = vm.pastFollowUps.count { it.dialled_at == null } + overdue.size
        Text("Last 7 days: ${onTime.size} on time · ${late.count { it.dialled_at != null }} late · $missedCount not called" +
            if (done + missedCount > 0) " · ${onTime.size * 100 / (done + missedCount)}% on time" else "",
            fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(horizontal = 16.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tabs.forEach { (k, l) -> FilterChip(selected = tab == k, onClick = { tab = k }, label = { Text(l) },
                colors = if (k == "overdue" && overdue.isNotEmpty()) FilterChipDefaults.filterChipColors(labelColor = Brand.red) else FilterChipDefaults.filterChipColors()) }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (tab in setOf("overdue", "today") && shown.isNotEmpty()) item {
                Button(onClick = { vm.startFollowUpQueue() }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Call due follow-ups in a queue")
                }
            }
            if (shown.isEmpty()) item {
                Text(when (tab) {
                    "overdue" -> "Nothing missed. 👍"; "upcoming" -> "No follow-ups after today."; "late" -> "No late follow-ups in the last 7 days."
                    "ontime" -> "No follow-ups called on time in the last 7 days yet."; else -> "No more follow-ups due today."
                }, color = Brand.muted, modifier = Modifier.padding(8.dp))
            }
            items(shown.distinctBy { it.id }, key = { it.id }) { f -> FollowUpCard(vm, f, now, zone) }
        }
    }
}

@Composable
private fun FollowUpCard(vm: AppViewModel, f: FollowUp, now: Long, zone: ZoneId) {
    val due = runCatching { com.closeros.app.data.parseInstant(f.due_at) }.getOrNull()
    val dueMs = due?.toEpochMilli() ?: now
    val st = fuState(f, now)
    val dueDay = due?.atZone(zone)?.toLocalDate()
    val today = LocalDate.now(zone)
    val dayText = when (dueDay) { today -> "Today"; today.plusDays(1) -> "Tomorrow"; today.minusDays(1) -> "Yesterday"
        else -> dueDay?.format(DateTimeFormatter.ofPattern("EEE dd MMM")) ?: "" }
    val timeText = due?.atZone(zone)?.format(DateTimeFormatter.ofPattern("h:mm a")) ?: ""
    val (badge, color, bg) = when (st) {
        FuState.Upcoming -> Triple("In ${mins(dueMs - now)}", Brand.primaryDark, Color(0xFFECFDF5))
        FuState.DueNow -> Triple("Due now", Color(0xFFB45309), Color(0xFFFEF3C7))
        FuState.NotCalled -> Triple("Not called · ${mins(now - dueMs)} late", Brand.red, Color(0xFFFEE2E2))
        FuState.OnTime -> Triple("Called on time", Brand.primaryDark, Color(0xFFD1FAE5))
        FuState.Late -> Triple("Called ${mins((f.dialled_at?.let { com.closeros.app.data.parseInstant(it).toEpochMilli() } ?: now) - dueMs)} late", Color(0xFFC2410C), Color(0xFFFFEDD5))
    }
    Card(Modifier.fillMaxWidth().clickable { vm.openLeadId = f.lead_id }, colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(76.dp)) {
                Text(timeText, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text(dayText, fontSize = 12.sp, color = Brand.muted)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(f.lead?.name?.ifBlank { null } ?: fmtPhone(f.lead?.phone ?: ""), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(if (!f.lead?.name.isNullOrBlank()) fmtPhone(f.lead?.phone ?: "") else null,
                    f.lead?.let { callsLine(it.call_count, it.conversation_count) }).joinToString(" · "), fontSize = 12.sp, color = Brand.muted)
                Text(badge, fontSize = 12.sp, color = color, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.background(bg, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
                listOfNotNull(if (f.purpose == "reminder") "Reminder call" else null, f.reason, f.notes).joinToString(" · ").takeIf { it.isNotBlank() }?.let {
                    Text(it, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (f.status == "pending") IconButton(onClick = { vm.callLeadById(f.lead_id) }) { Icon(Icons.Default.Call, "Call", tint = Brand.primary) }
        }
    }
}
