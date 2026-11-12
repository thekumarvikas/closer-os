package com.closeros.app.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.BuildConfig
import com.closeros.app.Monetize
import com.closeros.app.calls.safeStart

private fun open(ctx: android.content.Context, path: String) = safeStart(ctx, Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_URL + path)))

/** "Watch a short ad to unlock" — always with the Remove ads option next to it. */
@Composable
fun UnlockDialog(vm: AppViewModel) {
    val (f, _) = vm.gate ?: return
    val ctx = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!busy) vm.gate = null },
        title = { Text("Unlock ${f.title}") },
        text = { Text("Watch a short ad to unlock ${f.gives}. Or remove all ads for good.") },
        confirmButton = {
            Button(enabled = !busy, onClick = {
                val a = ctx as? Activity ?: return@Button vm.gateGranted()
                busy = true
                Monetize.showRewarded(a) { ok -> busy = false; if (ok) vm.gateGranted() else { vm.gate = null; vm.message = "Watch the whole ad to unlock" } }
            }) { Text(if (busy) "Loading…" else "▶ Watch a short ad") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { vm.gate = null; vm.showRemoveAds = true }) { Text("Remove ads") }
                TextButton(onClick = { vm.gate = null }) { Text("Not now") }
            }
        })
}

/** Remove ads: monthly or yearly subscription through Google Play (prices in the user's own currency). */
@Composable
fun RemoveAdsScreen(vm: AppViewModel) {
    BackHandler { vm.showRemoveAds = false }
    val ctx = LocalContext.current
    val paid = Monetize.adFree(ctx)
    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showRemoveAds = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Remove ads", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        if (paid) {
            Card { Column(Modifier.padding(16.dp)) {
                Text("✓ Ads are removed", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = Brand.primary)
                Text("Thank you for supporting Closer OS. Manage or cancel the subscription in Google Play → Payments & subscriptions.", color = Brand.muted)
            } }
            return@Column
        }
        Text("Closer OS is free. Ads keep it free. Remove them to get:", color = Brand.muted)
        listOf("No ads anywhere", "Calling queue without breaks", "WhatsApp queue without breaks", "All reports, Compare, Lead work and Sales insights — always open")
            .forEach { Text("✓ $it", fontSize = 16.sp) }
        @Composable fun Plan(title: String, price: String, note: String, yearly: Boolean, best: Boolean) {
            Card(colors = CardDefaults.cardColors(containerColor = if (best) Brand.light else Color.White), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(title, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                        if (best) Text("Best value", fontSize = 12.sp, color = Color.White, modifier = Modifier.background(Brand.primary, RoundedCornerShape(6.dp)).padding(6.dp, 2.dp))
                    }
                    Text(price, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    Text(note, color = Brand.muted, fontSize = 13.sp)
                    Button(onClick = { (ctx as? Activity)?.let { a -> Monetize.buy(a, yearly) { vm.message = it } } }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Continue with Google Play") }
                }
            }
        }
        Plan("Yearly", Monetize.price(true)?.let { "$it / year" } ?: "₹999 / year", "Pay once a year — about 2 months free", yearly = true, best = true)
        Plan("Monthly", Monetize.price(false)?.let { "$it / month" } ?: "₹99 / month", "Cancel any time in Google Play", yearly = false, best = false)
        Text("Prices are shown by Google Play in your currency. The subscription renews automatically until you cancel it in Google Play.", fontSize = 12.sp, color = Brand.muted)
        TextButton(onClick = { Monetize.restore(ctx) { vm.message = it } }) { Text("Already paid? Restore purchase") }
    }
}

/** Settings → for the individual app: remove ads, privacy, terms, delete account. */
@Composable
fun SoloAccountCard(vm: AppViewModel) {
    val ctx = LocalContext.current
    var askDelete by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Your account", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            if (Monetize.ENABLED) {
                if (Monetize.adFree(ctx)) Text("✓ Ads removed", color = Brand.primary)
                else Button(onClick = { vm.showRemoveAds = true }, modifier = Modifier.fillMaxWidth()) { Text("Remove ads") }
            }
            Row {
                TextButton(onClick = { open(ctx, "/privacy") }) { Text("Privacy policy") }
                TextButton(onClick = { open(ctx, "/terms") }) { Text("Terms") }
            }
            TextButton(onClick = { askDelete = true }) { Text("Delete my account", color = Brand.red) }
        }
    }
    if (askDelete) {
        var typed by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(onDismissRequest = { if (!busy) askDelete = false },
            title = { Text("Delete your account?") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This deletes your Closer OS account with all its leads, call history, notes and follow-ups. It can't be undone. Your phone's own call history and recordings are not touched.")
                if (Monetize.ENABLED && Monetize.adFree(ctx)) Text("Also cancel your \"Remove ads\" subscription in Google Play, or it keeps renewing.", color = Brand.red, fontSize = 13.sp)
                OutlinedTextField(typed, { typed = it }, singleLine = true, label = { Text("Type DELETE") })
                error?.let { Text(it, color = Brand.red, fontSize = 13.sp) }
            } },
            confirmButton = { Button(enabled = typed.trim() == "DELETE" && !busy, colors = ButtonDefaults.buttonColors(containerColor = Brand.red), onClick = {
                busy = true; vm.deleteAccount { error = it; busy = false }
            }) { Text(if (busy) "Deleting…" else "Delete forever") } },
            dismissButton = { TextButton(onClick = { askDelete = false }) { Text("Cancel") } })
    }
}

/** Individual app: create a login on the phone (name, email, password). */
@Composable
fun SignUpForm(vm: AppViewModel, onSignIn: () -> Unit) {
    val ctx = LocalContext.current
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Create your free account", fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
        GoogleButton(vm)
        OutlinedTextField(name, { name = it }, label = { Text("Your name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(password, { password = it }, label = { Text("Choose a password (6+ characters)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        note?.let { Text(it, fontSize = 14.sp, color = if (it.startsWith("✉")) Brand.primary else Brand.red) }
        Button(enabled = !busy && name.isNotBlank() && email.contains('@') && password.length >= 6, modifier = Modifier.fillMaxWidth().height(50.dp), onClick = {
            busy = true; note = null; vm.signUp(name, email, password) { busy = false; note = it }
        }) { if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp) else Text("Create account", fontSize = 16.sp) }
        Text("By creating an account you agree to the Terms and the Privacy policy.", fontSize = 12.sp, color = Brand.muted)
        Row {
            TextButton(onClick = { open(ctx, "/terms") }) { Text("Terms", fontSize = 12.sp) }
            TextButton(onClick = { open(ctx, "/privacy") }) { Text("Privacy policy", fontSize = 12.sp) }
        }
        TextButton(onClick = onSignIn, modifier = Modifier.fillMaxWidth()) { Text("Already have an account? Sign in") }
    }
}

/** "Continue with Google" — one tap, no password, no confirmation email. Hidden until Google sign-in is set up. */
@Composable
fun GoogleButton(vm: AppViewModel) {
    if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) return
    val ctx = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth().height(50.dp), onClick = {
            val a = ctx as? Activity ?: return@OutlinedButton
            busy = true; error = null
            vm.signInWithGoogle(a) { busy = false; error = it.ifBlank { null } }
        }) {
            Text("G", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = Color(0xFF4285F4))
            Spacer(Modifier.width(10.dp))
            Text(if (busy) "Opening Google…" else "Continue with Google", fontSize = 16.sp)
        }
        error?.let { Text(it, color = Brand.red, fontSize = 13.sp) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f)); Text("  or with email  ", fontSize = 12.sp, color = Brand.muted); HorizontalDivider(Modifier.weight(1f))
        }
    }
}
