package com.closeros.app.ui

import com.closeros.app.calls.safeStart
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.closeros.app.calls.CallSync
import com.closeros.app.calls.PhoneSetup
import kotlinx.coroutines.launch

/** "Phone setup": every permission and setting in one list, each turned on from here. */
@Composable
fun SetupChecklistScreen(vm: AppViewModel, onBack: () -> Unit) {
    val ctx = LocalContext.current
    var tick by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    val items = remember(tick, vm.setupTick) { PhoneSetup.items(ctx) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { tick++ }
    BackHandler { onBack() }
    val needed = items.filter { it.required }
    val pending = items.filter { !it.done }
    val done = items.filter { it.done }
    var showDone by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    // Back from Android settings: start at the top again, where the next pending step now is.
    LaunchedEffect(tick) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(scroll).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") }
            Text("Phone setup", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        Text(if (pending.isEmpty()) "All set ✓" else "${needed.count { it.done }} of ${needed.size} essentials done" +
            (if (pending.isNotEmpty()) " · step ${items.size - pending.size + 1} of ${items.size}" else ""), color = Brand.muted)
        LinearProgressIndicator(progress = { (items.size - pending.size).toFloat() / items.size.coerceAtLeast(1) }, Modifier.fillMaxWidth())
        // Still to do, essentials first; the first one is the next step.
        Section(null, pending.sortedBy { if (it.required) 0 else 1 }, vm, ask, highlightFirst = true) { tick++ }
        if (done.isNotEmpty()) {
            Text((if (showDone) "▴ " else "▾ ") + "Done (${done.size})", fontWeight = FontWeight.SemiBold, color = Brand.primaryDark,
                modifier = Modifier.fillMaxWidth().clickable { showDone = !showDone }.padding(vertical = 8.dp))
            if (showDone) Section(null, done, vm, ask) { tick++ }
        }
    }
}

@Composable
private fun Section(title: String?, list: List<PhoneSetup.Item>, vm: AppViewModel,
                    ask: androidx.activity.result.ActivityResultLauncher<Array<String>>,
                    highlightFirst: Boolean = false, refresh: () -> Unit) {
    if (list.isEmpty()) return
    val ctx = LocalContext.current
    title?.let { Text(it, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
    list.forEachIndexed { idx, it ->
        val next = highlightFirst && idx == 0
        if (next) Text("NEXT STEP", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Brand.primaryDark)
        Card(colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = if (next) Modifier.border(2.dp, Brand.primary, RoundedCornerShape(12.dp)) else Modifier) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.size(28.dp).clip(CircleShape).background(if (it.done) Brand.primary else Color(0xFFFDE68A)), contentAlignment = Alignment.Center) {
                    if (it.done) Icon(Icons.Default.Check, null, tint = Color.White, modifier = Modifier.size(18.dp)) else Text("!", fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(it.title, fontWeight = FontWeight.SemiBold)
                    Text(it.why, fontSize = 14.sp, color = Brand.muted)
                    it.warning?.let { w -> Text(w, fontSize = 13.sp, color = Brand.red) }
                    // Already done (or marked done by mistake): open the setting again, or undo a "Done" tap.
                    if (it.done && (it.kind == PhoneSetup.Kind.Confirm || it.intent != null || it.key == "recfolder")) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = {
                            when {
                                it.key == "recfolder" -> PhoneSetup.pickRecordingsFolder(ctx)
                                it.intent != null -> runCatching { safeStart(ctx, it.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), fallback = it.fallback, fallbackNote = it.fallbackSteps) }
                            }
                        }, contentPadding = PaddingValues(horizontal = 4.dp)) { Text(if (it.key == "recfolder") "Change folder" else "Open setting again", fontSize = 13.sp) }
                        if (it.kind == PhoneSetup.Kind.Confirm) TextButton(onClick = { vm.store.unconfirm(it.key); refresh() }, contentPadding = PaddingValues(horizontal = 4.dp)) {
                            Text("Not done yet? Undo", fontSize = 13.sp, color = Brand.muted) }
                    }
                    if (!it.done) {
                        it.steps?.let { s -> Text(s, fontSize = 13.sp, color = Brand.primaryDark) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                when {
                                    it.kind == PhoneSetup.Kind.Runtime -> ask.launch(it.perms.toTypedArray())
                                    it.key == "recfolder" -> PhoneSetup.pickRecordingsFolder(ctx)
                                    it.intent != null -> runCatching { safeStart(ctx, it.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), fallback = it.fallback, fallbackNote = it.fallbackSteps) }
                                        .onFailure { _ -> safeStart(ctx, Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                }
                            }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text(if (it.kind == PhoneSetup.Kind.Runtime) "Allow" else if (it.key == "autorecord") "Open recording setting" else "Turn on") }
                            if (it.key == "whatsapp" && android.os.Build.VERSION.SDK_INT >= 33) OutlinedButton(onClick = {
                                safeStart(ctx, Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            }) { Text("Open app info") }
                            if (it.kind == PhoneSetup.Kind.Confirm) OutlinedButton(onClick = { vm.store.confirm(it.key); refresh() }) { Text("Done") }
                        }
                    }
                }
            }
        }
    }
}

/** Small card on Home while essentials are missing. */
@Composable
fun SetupBanner(vm: AppViewModel) {
    val ctx = LocalContext.current
    var tick by remember { mutableStateOf(0) }
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    val needed = remember(tick) { PhoneSetup.items(ctx).filter { it.required } }
    val missing = needed.count { !it.done }
    if (missing == 0) return
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFFFFBEB)), shape = RoundedCornerShape(12.dp)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Finish phone setup ($missing left)", fontWeight = FontWeight.SemiBold)
                Text("A few switches so every call and reminder is tracked.", fontSize = 13.sp, color = Brand.muted)
            }
            Button(onClick = { vm.showSetup = true }) { Text("Set up") }
        }
    }
}
