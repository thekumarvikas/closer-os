package com.closeros.app

import androidx.compose.material.icons.filled.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.ui.unit.dp
import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.calls.Sim
import com.closeros.app.data.Lead
import com.closeros.app.ui.*
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.auth.handleDeeplinks

class CloserApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.closeros.app.data.AppLog.install(this)
        com.closeros.app.data.AppCtx.ctx = this
        com.closeros.app.data.Net.init(this)   // knows when there's no internet (app keeps working from the phone's copy)
    }
}

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()
    /** Recordings folder picker, owned by the activity so the choice is never lost — even when another screen
     *  (e.g. a pending call outcome) opens first, or the phone closed the app while the picker was open. */
    val pickRecordingsFolder = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree()) { uri ->
        vm.onRecordingsFolderPicked(uri)
    }
    /** Any file picked inside Closer OS (lead import, sequence / scheduled-message attachment) — owned by the activity so
     *  the result is never lost, even if Android closed the app while the picker was open. */
    val pickFile = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri -> vm.onFilePicked(uri) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CloserTheme { Root(vm) } }
        Monetize.init(this)   // individual app: privacy consent, ads, Google Play subscription (no-op in company builds)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Taps on follow-up notifications: open the lead, or start the call. */
    private fun handle(i: Intent?) {
        // Email confirmation link tapped on this phone → signed in straight away.
        if (i?.data?.scheme == "closeros") {
            runCatching { com.closeros.app.data.Backend.client.handleDeeplinks(i) { vm.message = "✓ Email confirmed — you're signed in" } }
            i.data = null
        }
        i?.getStringExtra("call_lead")?.let {
            // From a follow-up reminder's Call button: close that reminder and call with the right purpose.
            i.getStringExtra("fu_id")?.let { fu -> androidx.core.app.NotificationManagerCompat.from(this).cancel(fu.hashCode()) }
            vm.callLeadById(it, i.getStringExtra("purpose")); i.removeExtra("call_lead") }
        i?.getStringExtra("open_lead")?.let { vm.openLeadId = it; i.removeExtra("open_lead") }
        // Hourly check-in notification: open the card, or "start calling" straight away.
        i?.getStringExtra("checkin")?.let { if (it == "go") vm.checkInGo() else vm.openCheckIn(); i.removeExtra("checkin") }
        i?.getStringExtra("open_tab")?.let { if (it == "leads") { vm.tab = Tab.Leads; vm.reloadLeads() }; if (it == "sequences") { vm.showSequences = true; vm.loadSequences(); vm.loadSeqDue() }
            if (it == "wa_due") vm.startSeqQueue(); i.removeExtra("open_tab") }
    }

    override fun onResume() {
        super.onResume()
        visible = true
        com.closeros.app.calls.AfterCall.Overlay.hide(applicationContext)
        vm.foreground = true
        vm.onResume()
    }

    override fun onPause() {
        super.onPause()
        visible = false
        vm.foreground = false
    }

    companion object {
        /** True while Closer OS is on screen (then no after-call pop-up: the app asks itself). */
        @Volatile var visible = false
    }
}

@Composable
fun Root(vm: AppViewModel) {
    val ctx = LocalContext.current
    var permsAsked by remember { mutableStateOf(requiredPermissions.all { PhoneCalls.has(ctx, it) }) }
    var simChoice by remember { mutableStateOf<Pair<Lead, List<Sim>>?>(null) }

    fun call(lead: Lead) {
        if (lead.do_not_call) { vm.dncAsk = lead; return }   // ask first, then remove the mark and call
        val sims = vm.sims()
        val preferred = sims.firstOrNull { it.slot == vm.store.preferredSim }
        // In a queue, keep using the SIM chosen for the first call instead of asking every time.
        if (sims.size > 1 && !((vm.queueActive || vm.remoteCall) && preferred != null)) simChoice = lead to sims else vm.startCall(lead, preferred ?: sims.firstOrNull())
    }

    LaunchedEffect(vm.callRequest) {
        vm.callRequest?.let { lead -> vm.callRequest = null; if (vm.pending == null) call(lead) else vm.message = "Save the outcome of your last call first" }
    }
    // Desk mode: while the app is on screen, check every 4 seconds if the laptop asked to call someone.
    LaunchedEffect(vm.membership) { while (vm.membership != null && !vm.isSolo) { kotlinx.coroutines.delay(4_000); if (vm.foreground && vm.pending == null) vm.checkCallRequests() } }
    // While the app is on screen, check for announcements every 2 minutes (background sync covers the rest).
    LaunchedEffect(vm.membership) { while (vm.membership != null) { kotlinx.coroutines.delay(120_000); if (vm.foreground) vm.checkAlerts() } }
    vm.signOutWaiting?.let { n ->
        androidx.compose.material3.AlertDialog(onDismissRequest = { vm.signOutWaiting = null },
            title = { Text("$n outcome${if (n > 1) "s" else ""} not uploaded yet") },
            text = { Text("They couldn't be sent — check your internet and try again. If you sign out now, they will be lost.") },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { vm.signOutWaiting = null; vm.signOut() }) { Text("Try again") } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { vm.signOut(force = true) }) { Text("Sign out anyway", color = androidx.compose.ui.graphics.Color(0xFFDC2626)) } })
    }
    LaunchedEffect(vm.message) {
        vm.message?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show(); vm.message = null }
    }

    // Back always closes the screen on top (inner screens with their own Back handling still go first).
    val secondary = vm.showWaToday || vm.showLeadWork || vm.showRecipe || vm.showPlaybook || vm.showFeedback || vm.showDialer || vm.showReports ||
        vm.showLeaderboard || vm.showSequences || vm.editSequence != null || vm.openSequenceId != null || vm.showImport || vm.showContactsPick || vm.openLeadId != null || vm.genericList != null || vm.openList != null || vm.showBatches || vm.todayFilter != null
    androidx.activity.compose.BackHandler(enabled = secondary && vm.pending == null) { vm.closeTop() }
    WaChooseDialog(vm)
    EventPickerDialog(vm)
    SequencePickerDialog(vm)
    AddMenuDialog(vm)
    AddLeadDialog(vm)
    ProAskDialog(vm)
    UnlockDialog(vm)
    WaConfirmDialog(vm)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when {
            vm.status is SessionStatus.Initializing -> Loading()
            vm.status !is SessionStatus.Authenticated && !(vm.status is SessionStatus.RefreshFailure && vm.membership != null) -> LoginScreen(vm)
            vm.loadingOrg && vm.membership == null -> Loading()
            vm.membership == null -> NoCompanyScreen(vm)
            !permsAsked -> PermissionScreen { permsAsked = true; com.closeros.app.calls.CallSync.syncNow(ctx) }
            vm.access?.state == "expired" -> PlanEndedScreen(vm)
            vm.needsSetup -> SetupScreen(vm)
            vm.showSetup -> SetupChecklistScreen(vm) { vm.showSetup = false }
            vm.pending != null -> OutcomeScreen(vm)
            vm.announcements.isNotEmpty() -> AnnouncementScreen(vm, vm.announcements.first())
            vm.checkIn != null -> vm.checkIn?.let { CheckInScreen(vm, it) }
            vm.showRemoveAds -> RemoveAdsScreen(vm)
            vm.waActive -> WaQueueScreen(vm)
            vm.editSequence != null -> vm.editSequence?.let { s -> SequenceEditor(vm, s) }
            vm.showImport -> ImportScreen(vm)
            vm.showContactsPick -> ContactsPickScreen(vm)
            vm.showPlaybook -> WithBanner { PlaybookScreen(vm) }
            vm.showFeedback -> FeedbackScreen(vm)
            vm.showDialer -> DialerScreen(vm)
            vm.openLeadId != null -> vm.openLeadId?.let { id -> LeadDetailScreen(vm, id) { call(it) } }
            vm.genericList != null -> LeadListScreen(vm) { call(it) }
            vm.showLeadWork -> WithBanner { LeadWorkScreen(vm) }
            vm.showRecipe -> WithBanner { RecipeScreen(vm) }
            vm.showWaToday -> WaTodayScreen(vm)
            vm.showReports -> WithBanner { ReportsScreen(vm) }
            vm.showLeaderboard -> LeaderboardScreen(vm)
            vm.openSequenceId != null -> vm.openSequenceId?.let { SequenceDetailScreen(vm, it) }
            vm.showSequences -> WithBanner { SequencesScreen(vm) }
            vm.queueActive -> QueueScreen(vm)
            vm.openList != null -> BatchListScreen(vm)
            vm.showBatches -> BatchesScreen(vm)
            vm.todayFilter != null -> vm.todayFilter?.let { f -> TodayListScreen(vm, f) }
            else -> { TripleBackToExit(vm); Scaffold(topBar = { OfflineBar(vm) }, floatingActionButton = {
                // Dial pad is always one tap away, on every tab.
                if (vm.tab != Tab.Profile && !vm.selectMode) SmallDialFab { vm.showDialer = true }
            }, bottomBar = {
                // Individual app: one small ad above the tabs, on every tab.
                Column { Monetize.Banner()
                NavigationBar {
                    listOf(Triple(Tab.Home, "Home", Icons.Default.Home), Triple(Tab.Leads, "Leads", Icons.Default.Person), Triple(Tab.Calls, "Calls", Icons.Default.Call),
                        Triple(Tab.FollowUps, "Follow-ups", Icons.Default.DateRange), Triple(Tab.Profile, "Settings", Icons.Default.Settings)).forEach { (t, label, icon) ->
                        NavigationBarItem(selected = vm.tab == t, onClick = { vm.tab = t }, icon = { Icon(icon, null) }, label = { Text(label) })
                    }
                } }
            }) { pad ->
                // Swipe left / right to move between the tabs.
                val pager = androidx.compose.foundation.pager.rememberPagerState(initialPage = mainTabs.indexOf(vm.tab).coerceAtLeast(0)) { mainTabs.size }
                LaunchedEffect(vm.tab) { val i = mainTabs.indexOf(vm.tab); if (i >= 0 && pager.currentPage != i) pager.animateScrollToPage(i) }
                LaunchedEffect(pager) { androidx.compose.runtime.snapshotFlow { pager.settledPage }.collect { vm.tab = mainTabs[it] } }
                androidx.compose.foundation.pager.HorizontalPager(pager, Modifier.padding(pad), userScrollEnabled = !vm.selectMode, key = { it }) { page ->
                    when (mainTabs[page]) {
                        Tab.Home -> HomeScreen(vm)
                        Tab.Leads -> LeadsScreen(vm) { call(it) }
                        Tab.Calls -> CallHistoryScreen(vm)
                        Tab.FollowUps -> FollowUpsScreen(vm)
                        Tab.Profile -> ProfileScreen(vm)
                    }
                }
            } }
        }
        vm.dncAsk?.let { l ->
            androidx.compose.material3.AlertDialog(onDismissRequest = { vm.dncAsk = null },
                title = { Text("${l.name.ifBlank { "This lead" }} is marked Do not call") },
                text = { Text("They may have asked not to be called. Remove \"Do not call\" and call now? Your manager can see this change.") },
                confirmButton = { androidx.compose.material3.Button(onClick = { vm.dncAsk = null; vm.setDoNotCall(l, false) { u -> vm.callRequest = u } }) { Text("Remove and call") } },
                dismissButton = { androidx.compose.material3.TextButton(onClick = { vm.dncAsk = null }) { Text("Cancel") } })
        }
        vm.whatsappNext?.let { l -> if (vm.pending == null && vm.announcements.isEmpty()) WhatsAppPicker(vm, l) { vm.whatsappNext = null } }
        simChoice?.let { (lead, sims) ->
            SimPicker(sims, onPick = { simChoice = null; vm.startCall(lead, it) }, onDismiss = { simChoice = null })
        }
    }
}

private val mainTabs = listOf(Tab.Home, Tab.Leads, Tab.Calls, Tab.FollowUps, Tab.Profile)

/** Back on the main tabs: go to Home first; on Home, press back 3 times quickly to leave the app. */
@Composable
private fun TripleBackToExit(vm: AppViewModel) {
    val ctx = LocalContext.current
    var presses by remember { mutableStateOf(0) }
    var last by remember { mutableStateOf(0L) }
    androidx.activity.compose.BackHandler {
        if (vm.tab != Tab.Home) { vm.tab = Tab.Home; return@BackHandler }
        val now = System.currentTimeMillis()
        presses = if (now - last < 2000) presses + 1 else 1
        last = now
        when (presses) {
            1 -> Toast.makeText(ctx, "Press back 2 more times to exit", Toast.LENGTH_SHORT).show()
            2 -> Toast.makeText(ctx, "Press back once more to exit", Toast.LENGTH_SHORT).show()
            else -> (ctx as? android.app.Activity)?.finish()
        }
    }
}

@Composable
private fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

/** Dial pad button: the app's own teal, a clean white keypad (3×3 dots). */
@Composable
private fun SmallDialFab(onClick: () -> Unit) {
    FloatingActionButton(onClick = onClick, containerColor = com.closeros.app.ui.Brand.primary, contentColor = androidx.compose.ui.graphics.Color.White,
        shape = androidx.compose.foundation.shape.CircleShape, modifier = Modifier.size(52.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            repeat(3) { Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) { repeat(3) {
                Box(Modifier.size(4.5.dp).background(androidx.compose.ui.graphics.Color.White, androidx.compose.foundation.shape.CircleShape)) } } }
        }
    }
}


/** Shown while the phone has no internet: the app keeps working and sends everything later. */
@Composable
fun OfflineBar(vm: AppViewModel) {
    if (vm.online) return
    val ctx = LocalContext.current
    val waiting = remember(vm.message, vm.pending) { vm.store.outbox.size + com.closeros.app.data.Ops.count(ctx) }
    Text("📴 No internet — keep working. " + (if (waiting > 0) "$waiting saved on this phone, sent automatically when you're back online." else "Everything you save is sent when you're back online."),
        Modifier.fillMaxWidth().background(androidx.compose.ui.graphics.Color(0xFFFEF3C7)).padding(horizontal = 12.dp, vertical = 8.dp),
        color = androidx.compose.ui.graphics.Color(0xFF92400E), fontSize = 13.sp)
}

/** A screen with the individual app's small ad fixed at the bottom (company builds: just the screen). */
@Composable
private fun WithBanner(content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) { content() }
        Monetize.Banner()
    }
}
