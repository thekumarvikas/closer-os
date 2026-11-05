package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.CheckIn
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The hourly check-in card: where you stand, your best hours, what to do now — then "Got it — start calling". */
@Composable
fun CheckInScreen(vm: AppViewModel, s: CheckIn.Summary) {
    BackHandler { vm.checkInLater() }
    val zone = runCatching { ZoneId.of(vm.membership?.organization?.timezone ?: "Asia/Kolkata") }.getOrDefault(ZoneId.systemDefault())
    fun min(sec: Int) = if (sec >= 3600) "${sec / 3600} h ${(sec % 3600) / 60} min" else "${sec / 60} min"
    fun t(ms: Long) = Instant.ofEpochMilli(ms).atZone(zone).format(DateTimeFormatter.ofPattern("h:mm a"))
    val accent = when (s.status) { "record", "best_today" -> Color(0xFFB45309); "close", "on_pace" -> Brand.primary; else -> Brand.primaryDark }

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Hourly check-in · ${t(s.slotMs)}", color = Brand.muted, fontSize = 13.sp)
            Text(s.title.substringAfter(" · "), fontSize = 22.sp, fontWeight = FontWeight.Bold, color = accent)

            if (s.saleLines.isNotEmpty()) Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFDCFCE7))) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Sales today: ${s.sales}" + (if (s.salesAmount > 0) " · ₹%,d".format(s.salesAmount) else ""), fontWeight = FontWeight.Bold, color = Color(0xFF166534))
                    s.saleLines.forEach { Text(it, fontSize = 14.sp, color = Color(0xFF166534)) }
                }
            }

            if (s.kind != "morning") Box3("Last hour", listOf("Dialled" to "${s.lastDialled}", "Picked" to "${s.lastPicked}", "Talk" to min(s.lastTalk)))
            if (s.kind != "morning") Box3("Today", listOf("Dialled" to "${s.todayDialled}", "Connected" to "${s.todayConnected}", "Talk" to min(s.todayTalk)))

            // Talk time vs your own best — the game is beating yourself.
            val ref = maxOf(s.bestEverSec, 15 * 60)
            CardBlock("Your talk time vs your best") {
                Bar("Last hour", s.lastTalk, ref, min(s.lastTalk))
                Bar("Best hour today" + (s.bestTodayHour?.let { " (${if (it % 12 == 0) 12 else it % 12} ${if (it < 12) "AM" else "PM"})" } ?: ""), s.bestTodaySec, ref, min(s.bestTodaySec))
                Bar("All-time best" + (s.bestEverLabel?.let { " ($it)" } ?: ""), s.bestEverSec, ref, min(s.bestEverSec))
                if (s.top3.size > 1) Text("Your top hours: " + s.top3.joinToString(" · "), fontSize = 12.sp, color = Brand.muted)
                if (s.streak >= 2) Text("🔥 ${s.streak} strong hours in a row", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                if (s.lastTalk in 1 until ref && s.kind == "hourly") Text("${min(ref - s.lastTalk)} more in an hour = a new record 🏆", fontSize = 13.sp, color = Brand.primaryDark)
            }

            // Today hour by hour.
            if (s.hours.size > 1) CardBlock("Today, hour by hour (talk)") {
                val mx = s.hours.values.maxOrNull()?.coerceAtLeast(1) ?: 1
                s.hours.toSortedMap().forEach { (h, v) -> Bar("${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}", v, mx, min(v), highlight = v == mx) }
            }

            // Targets for today.
            val tg = s.target
            if ((tg.calls ?: 0) + (tg.talk_minutes ?: 0) + (tg.sales ?: 0) > 0) CardBlock("Today's targets") {
                tg.calls?.takeIf { it > 0 }?.let { Bar("Calls dialled", s.todayDialled, it, "${s.todayDialled} / $it") }
                tg.talk_minutes?.takeIf { it > 0 }?.let { Bar("Talk time", s.todayTalk / 60, it, "${s.todayTalk / 60} / $it min") }
                tg.sales?.takeIf { it > 0 }?.let { Bar("Sales", s.sales, it, "${s.sales} / $it") }
                s.needCallsThisHour?.takeIf { it > 0 }?.let { Text("This hour: $it calls keeps you on track", fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
            }

            // Reminder maths per webinar.
            s.reminders.forEach { r ->
                CardBlock("🎓 ${r.name} · starts ${t(r.webinarAt)}") {
                    Text("${r.left} reminder calls left · finish by ${t(r.finishBy)} (${r.minutesLeft / 60} h ${r.minutesLeft % 60} min) · pick-up today ${r.pickupPct}%", fontSize = 14.sp)
                    Line("If everyone picks up", "keep each call under ${secs(r.allPickSec)}")
                    Line("At today's ${r.pickupPct}% pick-up", "keep answered calls under ${secs(r.perAnsweredSec)}")
                    Line("At your usual ${secs(r.usualTalkSec)} per call", if (r.missed > 0) "you'll reach ~${r.canFinish} · ~${r.missed} may be missed" else "you'll reach everyone ✅")
                    if (r.missed > 0) Text("Tip: short calls, and WhatsApp the joining link to the hardest to reach.", fontSize = 13.sp, color = Brand.primaryDark)
                }
            }

            s.tip?.let { Text("💡 $it", fontSize = 14.sp, modifier = Modifier.fillMaxWidth().background(Color(0xFFEFF6FF), RoundedCornerShape(10.dp)).padding(12.dp)) }
            Text(s.goalLine, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
        Column(Modifier.fillMaxWidth().background(Color.White).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = { vm.checkInGo() }, modifier = Modifier.fillMaxWidth().height(54.dp)) {
                Text(if (s.kind == "summary") "Got it ✅" else "Got it — " + s.actionLabel.removePrefix("📞 ").replaceFirstChar { it.lowercase() }, fontSize = 16.sp)
            }
            TextButton(onClick = { vm.checkInLater() }, modifier = Modifier.fillMaxWidth()) { Text("Later", color = Brand.muted) }
        }
    }
}

private fun secs(s: Int) = if (s >= 60) "${s / 60} min${if (s % 60 >= 10) " ${s % 60} s" else ""}" else "$s s"

@Composable
private fun CardBlock(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, fontWeight = FontWeight.SemiBold); content() }
    }
}

@Composable
private fun Box3(title: String, items: List<Pair<String, String>>) {
    CardBlock(title) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items.forEach { (l, v) ->
                Column(Modifier.weight(1f)) { Text(v, fontSize = 20.sp, fontWeight = FontWeight.Bold); Text(l, fontSize = 12.sp, color = Brand.muted) }
            }
        }
    }
}

@Composable
private fun Line(label: String, value: String) {
    Row { Text(label, fontSize = 13.sp, color = Brand.muted, modifier = Modifier.weight(1f)); Text(value, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun Bar(label: String, value: Int, max: Int, text: String, highlight: Boolean = false) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f)); Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        Box(Modifier.fillMaxWidth().height(8.dp).background(Color(0xFFE2E8F0), RoundedCornerShape(4.dp))) {
            Box(Modifier.fillMaxWidth((value.toFloat() / max.coerceAtLeast(1)).coerceIn(0f, 1f)).height(8.dp)
                .background(if (highlight) Color(0xFFF59E0B) else Brand.primary, RoundedCornerShape(4.dp)))
        }
    }
}
