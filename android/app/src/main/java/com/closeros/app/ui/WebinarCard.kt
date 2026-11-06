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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadWebinar
import com.closeros.app.data.Repo
import com.closeros.app.data.parseInstant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val hm = DateTimeFormatter.ofPattern("h:mm a")
private fun clock(iso: String?) = iso?.let { runCatching { parseInstant(it).atZone(ZoneId.systemDefault()).format(hm) }.getOrNull() }
private fun day(iso: String?) = iso?.let { runCatching { parseInstant(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM")) }.getOrNull() }

/** Lead page: each webinar with watch time, join/leave, the pitch, chat messages, poll answers and warmth. */
@Composable
fun LeadWebinarsCard(lead: Lead) {
    var rows by remember(lead.id) { mutableStateOf<List<LeadWebinar>?>(null) }
    LaunchedEffect(lead.id) { rows = runCatching { Repo.leadWebinars(lead.id) }.getOrNull() }
    val list = rows
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("🎥 Webinars", fontWeight = FontWeight.SemiBold)
            if (list == null) {
                // Offline / still loading: what the phone already knows.
                lead.batch_leads.sortedByDescending { it.batch?.webinar_at ?: "" }.forEach { b ->
                    Text("${b.batch?.name ?: "Webinar"}: " + when { b.watch_minutes == null -> "attendance not uploaded"; b.watch_minutes > 0 -> "watched ${b.watch_minutes} min"; else -> "didn't join" } +
                        (b.warm_reason?.let { " · $it" } ?: ""), fontSize = 14.sp, color = Brand.muted)
                }
                return@Column
            }
            list.forEachIndexed { i, w ->
                if (i > 0) HorizontalDivider(color = Color(0xFFE2E8F0))
                val attended = (w.watch_minutes ?: 0) > 0
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(w.name + if (w.is_repeat) " · repeated" else "", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        day(w.webinar_at)?.let { Text(it + (clock(w.webinar_at)?.let { c -> " · $c" } ?: ""), fontSize = 12.sp, color = Brand.muted) }
                    }
                    if (w.warmth > 0) {
                        val (bg, fg, l) = when { w.warmth >= 70 -> Triple(Color(0xFFFFEDD5), Color(0xFF9A3412), "🔥 Hot"); w.warmth >= 40 -> Triple(Color(0xFFFEF3C7), Color(0xFF92400E), "Warm")
                            else -> Triple(Color(0xFFF1F5F9), Brand.muted, "Cold") }
                        Text("$l · ${w.warmth}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = fg,
                            modifier = Modifier.background(bg, RoundedCornerShape(12.dp)).padding(horizontal = 8.dp, vertical = 2.dp))
                    }
                }
                when {
                    !w.zoom_uploaded -> Text("Attendance not uploaded yet", fontSize = 14.sp, color = Brand.muted)
                    !attended -> Text("Didn't join", fontSize = 14.sp, color = Brand.muted)
                    else -> {
                        val sess = w.sessions.orEmpty().mapNotNull { s -> clock(s.join)?.let { j -> "$j–${clock(s.leave) ?: "?"}" } }
                        Text("Watched ${w.watch_minutes} min" + if (sess.isNotEmpty()) " · " + sess.joinToString(", ") else "", fontSize = 14.sp)
                        if (w.pitch_minute != null) Text(
                            (if (w.saw_pitch == true) "🎯 Present at the pitch" else "✗ Missed the pitch") + (clock(w.pitch_at)?.let { " ($it)" } ?: "") +
                                if (w.at_pitch == null) " · by minutes watched" else "",
                            fontSize = 14.sp, color = if (w.saw_pitch == true) Color(0xFF047857) else Color(0xFFB45309), fontWeight = FontWeight.SemiBold)
                    }
                }
                if (w.chat.isNotEmpty()) Column(Modifier.fillMaxWidth().background(Color(0xFFF0F9FF), RoundedCornerShape(8.dp)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("💬 Chat (${w.chat.size})", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF075985))
                    w.chat.forEach { c -> Text(((clock(c.at) ?: c.minute?.let { "min $it" })?.let { "$it  " } ?: "") + c.message, fontSize = 14.sp) }
                } else if (w.chat_uploaded && attended) Text("💬 No chat messages", fontSize = 12.sp, color = Brand.muted)
                if (w.polls.isNotEmpty()) Column(Modifier.fillMaxWidth().background(Color(0xFFF5F3FF), RoundedCornerShape(8.dp)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("📊 Polls · answered ${w.polls.map { it.question }.distinct().size} of ${w.poll_questions}", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF5B21B6))
                    w.polls.forEach { p -> Text("${p.question} → ${p.answer}", fontSize = 14.sp) }
                } else if (w.polls_uploaded && attended) Text("📊 Didn't answer the polls", fontSize = 12.sp, color = Brand.muted)
            }
        }
    }
}
