package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.closeros.app.data.CallReview

private fun pctColor(p: Int?) = when { p == null -> Color(0xFF94A3B8); p >= 80 -> Color(0xFF059669); p >= 60 -> Color(0xFFD97706); else -> Color(0xFFDC2626) }

/** The rep's call reviews: score per checklist item, what went well, what to improve, coaching tasks. */
@Composable
fun FeedbackScreen(vm: AppViewModel) {
    BackHandler { vm.showFeedback = false }
    LaunchedEffect(Unit) { vm.loadReviews() }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showFeedback = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Text("My call feedback", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (vm.reviews.isEmpty()) item { Text("No reviews yet. When your manager reviews one of your calls, the feedback appears here.", color = Brand.muted) }
            items(vm.reviews.distinctBy { it.id }, key = { it.id }) { r -> ReviewCard(vm, r) }
        }
    }
}

@Composable
private fun ReviewCard(vm: AppViewModel, r: CallReview) {
    LaunchedEffect(r.id) { if (r.seen_at == null) vm.markReview(r, taskDone = false) }
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(r.lead_name?.ifBlank { null } ?: fmtPhone(r.phone), fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(r.started_at?.let { "Call ${fmtWhen(it)}" }, if (r.duration_sec > 0) fmtDur(r.duration_sec) else null, r.reviewer?.let { "reviewed by $it" }).joinToString(" · "),
                        fontSize = 12.sp, color = Brand.muted)
                }
                Text(r.score_pct?.let { "$it%" } ?: "—", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = pctColor(r.score_pct))
            }
            if (r.seen_at == null) Text("NEW", fontSize = 11.sp, color = Color.White, fontWeight = FontWeight.Bold,
                modifier = Modifier.background(Brand.primary, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
            r.scores.filterValues { it in 1..5 }.forEach { (item, v) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(item, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text("★".repeat(v) + "☆".repeat(5 - v), fontSize = 15.sp, color = if (v >= 4) Color(0xFF059669) else if (v == 3) Color(0xFFD97706) else Color(0xFFDC2626))
                }
            }
            r.went_well?.let { Text("👍 $it", fontSize = 14.sp) }
            r.improve?.let { Text("🎯 $it", fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
            r.task?.let { t ->
                Column(Modifier.fillMaxWidth().background(if (r.task_done_at == null) Color(0xFFFFFBEB) else Color(0xFFECFDF5), RoundedCornerShape(8.dp)).padding(10.dp)) {
                    Text("Coaching task" + (r.task_due?.let { " · due $it" } ?: ""), fontSize = 12.sp, color = Brand.muted)
                    Text(t, fontSize = 14.sp)
                    if (r.task_done_at == null) TextButton(onClick = { vm.markReview(r, taskDone = true) }) { Text("✓ Mark as done") }
                    else Text("Done ✓", color = Color(0xFF059669), fontSize = 13.sp)
                }
            }
            if (r.recording_status == "uploaded" && r.recording_path != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Listen to the call ", fontSize = 13.sp, color = Brand.muted); RecordingPlayer(r.call_id, r.recording_path)
            }
        }
    }
}
