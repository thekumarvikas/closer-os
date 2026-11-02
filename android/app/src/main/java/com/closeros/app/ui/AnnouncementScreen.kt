package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Announcement

/** Message from management: stays until the rep confirms they've read it. */
@Composable
fun AnnouncementScreen(vm: AppViewModel, a: Announcement) {
    BackHandler { vm.message = "Please read and acknowledge this message first" }
    var read by remember(a.id) { mutableStateOf(false) }
    LaunchedEffect(a.id) { vm.acknowledge(a, ack = false) }   // marks it as seen
    val accent = if (a.urgent) Brand.red else Brand.primary
    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text(if (a.urgent) "🔴 Urgent message" else "📢 Message from management", color = accent, fontWeight = FontWeight.Bold)
        if (vm.announcements.size > 1) Text("1 of ${vm.announcements.size}", color = Brand.muted, fontSize = 13.sp)
        Text(a.title, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(listOfNotNull(a.from, fmtWhen(a.created_at)).joinToString(" · "), color = Brand.muted, fontSize = 13.sp)
        Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
            Text(a.body, fontSize = 17.sp, lineHeight = 26.sp, modifier = Modifier.padding(16.dp))
        }
        Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).clickable { read = !read }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(read, { read = it }); Text("I have read and understood this message", fontWeight = FontWeight.SemiBold)
        }
        Button(onClick = { vm.acknowledge(a, ack = true) }, enabled = read, modifier = Modifier.fillMaxWidth().height(54.dp),
            colors = ButtonDefaults.buttonColors(containerColor = accent)) { Text("Acknowledge", fontSize = 17.sp) }
        Text("Your manager sees when you acknowledged it.", fontSize = 12.sp, color = Brand.muted, modifier = Modifier.align(Alignment.CenterHorizontally))
    }
}

/** The company's plan has ended (after the grace period). Nothing to buy here — the owner renews on the dashboard. */
@Composable
fun PlanEndedScreen(vm: AppViewModel) {
    Column(Modifier.fillMaxSize().background(Brand.bg).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Closer OS is paused", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Your company's Closer OS plan has ended. Your leads, calls and notes are safe. Please ask your company owner or manager to renew it.",
            color = Brand.muted, fontSize = 16.sp, lineHeight = 24.sp)
        OutlinedButton(onClick = { vm.refreshHome() }) { Text("Check again") }
        TextButton(onClick = { vm.signOut() }) { Text("Sign out") }
    }
}
