package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.Product
import com.closeros.app.data.SaleRow

/** Money in the company's currency, no decimals ("₹18,000"). */
fun fmtMoney(v: Double, currency: String = "INR"): String = runCatching {
    java.text.NumberFormat.getCurrencyInstance(java.util.Locale("en", "IN")).apply {
        this.currency = java.util.Currency.getInstance(currency); maximumFractionDigits = 0 }.format(v)
}.getOrDefault("%,.0f".format(v))

/** Home: "My Sales Revenue" this month — motivating, never negative. Tap → my sales. */
@Composable
fun MySalesCard(vm: AppViewModel) {
    val s = vm.mySalesSummary ?: return
    val cur = vm.membership?.organization?.currency ?: "INR"
    if (s.verified == 0 && s.pending == 0 && s.balance_due <= 0.0) return
    Column(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(12.dp)).border(1.dp, Color(0xFFA7F3D0), RoundedCornerShape(12.dp))
        .clickable { vm.showMySales = true }.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("💰 My Sales Revenue · this month", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("›", color = Brand.primary, fontWeight = FontWeight.Bold)
        }
        Text(fmtMoney(s.net, cur) + " · ${s.verified} sale${if (s.verified == 1) "" else "s"} verified" + if (s.collected > 0) " · ${fmtMoney(s.collected, cur)} collected" else "",
            fontSize = 15.sp, color = Color(0xFF065F46), fontWeight = FontWeight.Medium)
        val more = listOfNotNull(
            s.pending.takeIf { it > 0 }?.let { "⏳ $it waiting for your manager to verify" },
            s.balance_due.takeIf { it > 0 }?.let { "${fmtMoney(it, cur)} still to be paid on ${s.balance_orders} order${if (s.balance_orders == 1) "" else "s"}" })
        if (more.isNotEmpty()) Text(more.joinToString(" · "), fontSize = 12.sp, color = Brand.muted)
    }
}

/** My sales: verified, waiting, rejected (with the manager's note), and what's still to be paid. */
@Composable
fun MySalesScreen(vm: AppViewModel) {
    BackHandler { vm.showMySales = false }
    LaunchedEffect(Unit) { vm.loadMySales() }
    val cur = vm.membership?.organization?.currency ?: "INR"
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showMySales = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("My Sales Revenue", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        val list = vm.mySales
        if (list == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        LazyColumn(contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { MySalesCard(vm) }
            if (list.isEmpty()) item { Text("No sales this month yet. When you save a \"sale\" outcome or claim a sale, it shows here.", color = Brand.muted) }
            items(list, key = { it.id }) { s ->
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(s.lead_name?.ifBlank { null } ?: s.lead_phone?.let(::fmtPhone) ?: "Sale", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(fmtMoney(s.amount, cur), fontWeight = FontWeight.SemiBold)
                        }
                        Text(listOfNotNull(fmtWhen(s.sold_at), s.product).joinToString(" · "), fontSize = 13.sp, color = Brand.muted)
                        val (txt, col) = when (s.status) {
                            "claimed" -> "⏳ Waiting for your manager to verify" to Color(0xFFB45309)
                            "rejected" -> "Not verified" + (s.review_note?.let { " — $it" } ?: "") to Brand.red
                            else -> when (s.pay_status) {
                                "full" -> "✓ Verified · fully paid" to Color(0xFF15803D)
                                "part" -> "✓ Verified · ${fmtMoney(s.paid, cur)} paid, ${fmtMoney(s.balance, cur)} to go" to Color(0xFF15803D)
                                "refunded" -> "Verified · refunded" to Brand.muted
                                else -> "✓ Verified · payment not recorded yet" to Color(0xFF15803D)
                            }
                        }
                        Text(txt, fontSize = 13.sp, color = col)
                    }
                }
            }
        }
    }
}

/** Lead page: "💰 Claim a sale" — pick the product (amount fills in), adjust, add a note. Managers' and individuals' sales count at once. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ClaimSaleDialog(vm: AppViewModel, lead: Lead, onClose: () -> Unit) {
    LaunchedEffect(Unit) { if (vm.products.isEmpty()) vm.loadProducts() }
    var product by remember { mutableStateOf<Product?>(null) }
    var name by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val instant = vm.isManager || vm.isSolo
    AlertDialog(onDismissRequest = onClose, title = { Text("💰 Claim a sale") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(lead.name.ifBlank { fmtPhone(lead.phone) }, fontWeight = FontWeight.SemiBold)
                if (vm.products.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    vm.products.forEach { p -> PickChips(listOf(p.name), listOfNotNull(product?.name?.takeIf { it == p.name }), single = true) {
                        product = if (it.isEmpty()) null else p; if (p.price != null && it.isNotEmpty()) amount = p.price.toLong().toString() } }
                }
                if (product == null) OutlinedTextField(name, { name = it }, label = { Text("Product / course") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(amount, { amount = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Order value") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(note, { note = it }, label = { Text("Note (e.g. paid ₹5,000 by UPI)") }, modifier = Modifier.fillMaxWidth())
                Text(if (instant) "Saved as a verified sale." else "Your manager verifies it, then it counts in your numbers.", fontSize = 12.sp, color = Brand.muted)
            }
        },
        confirmButton = {
            Button(enabled = !busy && (amount.toDoubleOrNull() ?: 0.0) > 0, onClick = {
                busy = true
                vm.claimSale(lead, product, name.trim(), amount, note.trim()) { ok -> busy = false; if (ok) onClose() }
            }) { Text(if (busy) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}
