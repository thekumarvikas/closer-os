package com.closeros.app

import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
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

class CloserApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.closeros.app.data.AppLog.install(this)
    }
}

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CloserTheme { Root(vm) } }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Taps on follow-up notifications: open the lead, or start the call. */
    private fun handle(i: Intent?) {
        i?.getStringExtra("call_lead")?.let { vm.callLeadById(it); i.removeExtra("call_lead") }
        i?.getStringExtra("open_lead")?.let { vm.openLeadId = it; i.removeExtra("open_lead") }
        i?.getStringExtra("open_tab")?.let { if (it == "leads") { vm.tab = Tab.Leads; vm.reloadLeads() }; i.removeExtra("open_tab") }
    }

    override fun onResume() {
        super.onResume()
        vm.foreground = true
        vm.onResume()
    }

    override fun onPause() {
        super.onPause()
        vm.foreground = false
    }
}

@Composable
fun Root(vm: AppViewModel) {
    val ctx = LocalContext.current
    var permsAsked by remember { mutableStateOf(requiredPermissions.all { PhoneCalls.has(ctx, it) }) }
    var simChoice by remember { mutableStateOf<Pair<Lead, List<Sim>>?>(null) }

    fun call(lead: Lead) {
        val sims = vm.sims()
        val preferred = sims.firstOrNull { it.slot == vm.store.preferredSim }
        // In a queue, keep using the SIM chosen for the first call instead of asking every time.
        if (sims.size > 1 && !((vm.queueActive || vm.remoteCall) && preferred != null)) simChoice = lead to sims else vm.startCall(lead, preferred ?: sims.firstOrNull())
    }

    LaunchedEffect(vm.callRequest) {
        vm.callRequest?.let { lead -> vm.callRequest = null; if (vm.pending == null) call(lead) else vm.message = "Save the outcome of your last call first" }
    }
    // Desk mode: while the app is on screen, check every 4 seconds if the laptop asked to call someone.
    LaunchedEffect(vm.membership) { while (vm.membership != null) { kotlinx.coroutines.delay(4_000); if (vm.foreground && vm.pending == null) vm.checkCallRequests() } }
    // While the app is on screen, check for announcements every 2 minutes (background sync covers the rest).
    LaunchedEffect(vm.membership) { while (vm.membership != null) { kotlinx.coroutines.delay(120_000); if (vm.foreground) vm.checkAlerts() } }
    LaunchedEffect(vm.message) {
        vm.message?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show(); vm.message = null }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when {
            vm.status is SessionStatus.Initializing -> Loading()
            vm.status !is SessionStatus.Authenticated -> LoginScreen(vm)
            vm.loadingOrg && vm.membership == null -> Loading()
            vm.membership == null -> NoCompanyScreen(vm)
            !permsAsked -> PermissionScreen { permsAsked = true; com.closeros.app.calls.CallSync.syncNow(ctx) }
            vm.access?.state == "expired" -> PlanEndedScreen(vm)
            vm.needsSetup -> SetupScreen(vm)
            vm.showSetup -> SetupChecklistScreen(vm) { vm.showSetup = false }
            vm.pending != null -> OutcomeScreen(vm)
            vm.announcements.isNotEmpty() -> AnnouncementScreen(vm, vm.announcements.first())
            vm.showPlaybook -> PlaybookScreen(vm)
            vm.showFeedback -> FeedbackScreen(vm)
            vm.showDialer -> DialerScreen(vm)
            vm.showReports -> ReportsScreen(vm)
            vm.showLeaderboard -> LeaderboardScreen(vm)
            vm.openLeadId != null -> LeadDetailScreen(vm, vm.openLeadId!!) { call(it) }
            vm.queueActive -> QueueScreen(vm)
            vm.openList != null -> BatchListScreen(vm)
            vm.showBatches -> BatchesScreen(vm)
            vm.todayFilter != null -> TodayListScreen(vm, vm.todayFilter!!)
            else -> { TripleBackToExit(vm); Scaffold(floatingActionButton = {
                // Dial pad is always one tap away, on every tab.
                if (vm.tab != Tab.Profile && !vm.selectMode) FloatingActionButton(onClick = { vm.showDialer = true }, containerColor = androidx.compose.ui.graphics.Color(0xFF16A34A),
                    contentColor = androidx.compose.ui.graphics.Color.White) { Text("☎", fontSize = 26.sp) }
            }, bottomBar = {
                NavigationBar {
                    listOf(Triple(Tab.Home, "Home", Icons.Default.Home), Triple(Tab.Leads, "Leads", Icons.Default.Phone), Triple(Tab.Calls, "Calls", Icons.Default.List),
                        Triple(Tab.FollowUps, "Follow-ups", Icons.Default.DateRange), Triple(Tab.Profile, "Profile", Icons.Default.Person)).forEach { (t, label, icon) ->
                        NavigationBarItem(selected = vm.tab == t, onClick = { vm.tab = t }, icon = { Icon(icon, null) }, label = { Text(label) })
                    }
                }
            }) { pad ->
                Box(Modifier.padding(pad)) {
                    when (vm.tab) {
                        Tab.Home -> HomeScreen(vm)
                        Tab.Leads -> LeadsScreen(vm) { call(it) }
                        Tab.Calls -> CallHistoryScreen(vm)
                        Tab.FollowUps -> FollowUpsScreen(vm)
                        Tab.Profile -> ProfileScreen(vm)
                    }
                }
            } }
        }
        simChoice?.let { (lead, sims) ->
            SimPicker(sims, onPick = { simChoice = null; vm.startCall(lead, it) }, onDismiss = { simChoice = null })
        }
    }
}

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
