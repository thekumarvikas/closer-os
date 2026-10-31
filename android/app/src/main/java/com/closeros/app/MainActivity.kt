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
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.calls.Sim
import com.closeros.app.data.Lead
import com.closeros.app.ui.*
import io.github.jan.supabase.auth.status.SessionStatus

class CloserApp : Application()

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
    }

    override fun onResume() {
        super.onResume()
        vm.onResume()
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
        if (sims.size > 1) simChoice = lead to sims else vm.startCall(lead, preferred ?: sims.firstOrNull())
    }

    LaunchedEffect(vm.callRequest) {
        vm.callRequest?.let { lead -> vm.callRequest = null; if (vm.pending == null) call(lead) else vm.message = "Save the outcome of your last call first" }
    }
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
            vm.needsSetup -> SetupScreen(vm)
            vm.pending != null -> OutcomeScreen(vm)
            vm.openLeadId != null -> LeadDetailScreen(vm, vm.openLeadId!!) { call(it) }
            else -> Scaffold(bottomBar = {
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
            }
        }
        simChoice?.let { (lead, sims) ->
            SimPicker(sims, onPick = { simChoice = null; vm.startCall(lead, it) }, onDismiss = { simChoice = null })
        }
    }
}

@Composable
private fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
