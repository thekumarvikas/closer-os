package com.closeros.app.ui

// Morning (8 AM) / evening (9:30 PM) summary: same model as the dashboard (web/src/lib/summary.ts) → screen,
// WhatsApp text (*bold* headings), picture (PNG) and PDF, shared through the phone's share sheet.

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Repo
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

data class SumLine(val label: String, val value: String, val leadId: String? = null, val sub: String? = null, val phone: String? = null,
    val short: String? = null, val owner: String? = null, val cat: Int = 0, val name: String? = null, val web: String = "", val work: String = "", val tag: String = "")
data class SumSection(val title: String, val lines: List<SumLine>, val note: String? = null)
data class SumCard(val header: String, val sub: String, val planTitle: String, val plan: List<String>, val hotTotal: Int, val cols: List<String>,
    val grid: List<Triple<String, List<Int>, Int>>, val top: List<SumLine>, val resultsTitle: String, val yesterday: List<String>,
    val team: List<List<String>>, val noCalls: List<String>, val stats: List<Pair<String, String>> = emptyList(), val extra: List<String> = emptyList(), val at: String = "")
data class SumModel(val title: String, val sub: String, val sections: List<SumSection>, val hotTotal: Int = 0, val hotShown: Int = 0,
    val card: SumCard? = null, val hot: List<SumLine> = emptyList(), val teamView: Boolean = false,
    val activity: List<List<String>> = emptyList(), val leadsRow: List<String> = emptyList(), val teamWide: List<List<String>> = emptyList())
fun fmtPh(p: String?) = p?.let { Regex("^\\+91(\\d{5})(\\d{5})$").find(it)?.let { m -> "+91 ${m.groupValues[1]} ${m.groupValues[2]}" } ?: it } ?: ""

private fun JsonObject.n(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
private fun JsonObject.i(k: String) = n(k).toInt()
private fun JsonObject.t(k: String) = this[k]?.jsonPrimitive?.contentOrNull
private fun hl(h: Int) = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
private fun slot(h: Int) = "${hl(h)} – ${hl((h + 1) % 24)}"
/** Short duration for tight tables: 1h 5m · 18m · 2m 40s · 45s. */
private fun sd(x: Int): String { val h = x / 3600; val m = x % 3600 / 60; return if (h > 0) "${h}h ${m}m" else if (m >= 10) "${m}m" else if (m > 0) "${m}m ${x % 60}s" else "${x}s" }
private fun pct(a: Int, b: Int) = if (b > 0) a * 100 / b else 0
private fun d(sec: Int): String { val h = sec / 3600; val m = sec % 3600 / 60; return if (h > 0) "${h}h ${m}m" else if (m > 0) "${m}m ${sec % 60}s" else "${sec}s" }

/** Best hour: conversations, talk time and positive outcomes count equally (same rule as the reports). */
private fun bestHour(hours: List<JsonObject>): JsonObject? {
    val live = hours.filter { it.i("conn") > 0 || it.i("pos") > 0 }; if (live.isEmpty()) return null
    val mc = live.maxOf { it.i("conn") }.coerceAtLeast(1).toFloat(); val mt = live.maxOf { it.i("talk") }.coerceAtLeast(1).toFloat(); val mp = live.maxOf { it.i("pos") }
    fun sc(r: JsonObject) = (r.i("conn") / mc + r.i("talk") / mt + (if (mp > 0) r.i("pos") / mp.toFloat() else 0f)) / (if (mp > 0) 3 else 2)
    return live.sortedWith(compareByDescending<JsonObject> { sc(it) }.thenByDescending { it.i("conn") }).first()
}

val HOT_CATS = mapOf(1 to "Ready to pay", 9 to "Saw the payment link — not bought yet", 2 to "Hot", 3 to "Interested", 4 to "Positive — follow up",
    5 to "Came back + active in Zoom", 6 to "Came back (attended 2+ webinars)", 7 to "Active in Zoom once", 8 to "Talked, not tagged yet — ask the team member")
/** Category 9 (saw the payment link, not bought) ranks right after Ready to pay. */
fun hotTop(c: Int) = c <= 4 || c == 9
fun hotGroup(c: Int) = if (hotTop(c)) "🔥 Hot — tagged or positive outcome" else if (c <= 7) "⭐ Potentially hot — attended, not talked to yet" else "📝 Talked, not tagged yet"
const val HOT_NOTE = "Hot = tagged Ready to pay / Hot / Interested, a positive outcome, or was in the webinar when the payment link was dropped (not bought yet). Potentially hot = attended webinars (2+ times, or chatted / answered polls) but nobody has talked to them yet. Inside each category: most webinar minutes first, then most talk time with the team."

/** Hot leads grouped by category (same rules as the dashboard). */
fun hotSections(list: List<JsonObject>, total: Int, tz: ZoneId, team: Boolean, nameOf: (String?) -> String): List<SumSection> {
    fun whenTxt(v: String?, pat: String) = v?.let { runCatching { com.closeros.app.data.parseInstant(it).atZone(tz).format(DateTimeFormatter.ofPattern(pat, java.util.Locale.ENGLISH)) }.getOrNull() }
    val out = mutableListOf<SumSection>(); var title = ""; var lines = mutableListOf<SumLine>()
    list.forEachIndexed { i, h ->
        val cat = h.i("cat"); val owner = nameOf(h.t("owner"))
        val why = when { cat == 8 -> "Not tagged yet — ask ${owner.ifBlank { "the team member" }}"; cat >= 5 -> HOT_CATS[cat] ?: ""
            else -> listOfNotNull(h.t("tag"), h.t("outcome")).joinToString(" · ").ifBlank { HOT_CATS[cat] ?: "" } }
        val att = h.i("att"); val watch = h.i("watch"); val best = h.i("best")
        val activity = listOfNotNull("Registered ${h.i("reg")}× · attended $att×",
            if (watch > 0) "watched $watch min" + (if (att > 1 && best > 0) " (best $best min, ${whenTxt(h.t("best_at"), "d MMM")})" else "") else null,
            if (h["pitch"]?.jsonPrimitive?.booleanOrNull == true) "saw the payment link" else null,
            h.i("chats").takeIf { it > 0 }?.let { "$it chat${if (it > 1) "s" else ""}" }, if (h.i("polls") > 0) "answered polls" else null).joinToString(" · ")
        val by = (h["talk_by"] as? JsonArray)?.map { it.jsonObject }?.filter { it.i("sec") > 0 } ?: emptyList()
        val talkSec = h.i("talk")
        val talk = if (talkSec > 0) "Talked ${talkSec / 60} min" + (if (by.size > 1) " (" + by.joinToString(", ") { "${nameOf(it.t("user")).substringBefore(' ')} ${it.i("sec") / 60} min" } + ")" else "") else "Not talked yet"
        val calls = h.i("calls"); val wa = h.i("wa")
        val done = listOfNotNull(talk, "$calls call${if (calls == 1) "" else "s"}", if (wa > 0) "$wa WhatsApp" else null).joinToString(" · ")
        val whenLine = listOfNotNull(whenTxt(h.t("last_talk"), "d MMM, h:mm a")?.let { "Last talked $it" }, whenTxt(h.t("next"), "d MMM, h:mm a")?.let { "Next call $it" }).joinToString(" · ")
        val t = "${hotGroup(cat)} · ${HOT_CATS[cat]}"
        if (t != title) { if (lines.isNotEmpty()) out += SumSection(title, lines); title = t; lines = mutableListOf() }
        val last = whenTxt(h.t("last_at"), "d MMM")?.let { "Last $it · ${h.i("last_min")} min" + (if (h["last_pitch"]?.jsonPrimitive?.booleanOrNull == true) " ✓ payment link" else "") }
        val pitchAny = h["pitch"]?.jsonPrimitive?.booleanOrNull == true
        val short = listOfNotNull(last ?: (if (watch > 0) "$watch min" else null), if (att > 1) "total $watch min" else null, if (last == null && pitchAny) "✓ payment link" else null,
            h.i("chats").takeIf { it > 0 }?.let { "$it chat${if (it > 1) "s" else ""}" }, if (h.i("polls") > 0) "polls" else null,
            if (att > 1) "attended $att×" else null, if (h.i("reg") > 1) "registered ${h.i("reg")}×" else null,
            if (talkSec > 0) "talked " + (if (talkSec < 60) "${talkSec}s" else "${talkSec / 60}m") else "not talked",
            "$calls call${if (calls == 1) "" else "s"}", if (wa > 0) "$wa WA" else null).joinToString(" · ")
        val web = listOfNotNull(last ?: (if (watch > 0) "$watch min" else "joined"), if (att > 1) "total $watch min" else if (last == null && pitchAny) "✓ payment link" else null,
            h.i("chats").takeIf { it > 0 }?.let { "$it chat${if (it > 1) "s" else ""}" }, if (h.i("polls") > 0) "polls" else null,
            if (att > 1) "$att webinars" else null, if (h.i("reg") > 1) "registered ${h.i("reg")}×" else null).joinToString(" · ")
        val work = listOfNotNull(if (talkSec > 0) (if (talkSec < 60) "${talkSec}s talk" else "${talkSec / 60}m talk") else "no talk",
            "$calls call${if (calls == 1) "" else "s"}", if (wa > 0) "$wa WA" else null).joinToString(" · ")
        val tag = if (cat <= 4) listOfNotNull(h.t("tag"), h.t("outcome")).joinToString(" · ") else ""
        lines += SumLine("${i + 1}. ${h.t("name") ?: ""}" + (if (team && owner.isNotBlank()) " ($owner)" else ""), "$why — $activity — $done",
            leadId = h.t("lead_id"), sub = whenLine.ifBlank { null }, phone = fmtPh(h.t("phone")), short = short, owner = owner, cat = cat, name = h.t("name"),
            web = web, work = work, tag = tag)
    }
    if (lines.isNotEmpty()) out += SumSection(title, lines)
    if (out.isNotEmpty()) out[0] = out[0].copy(note = HOT_NOTE)
    if (total > list.size) out += SumSection("+${total - list.size} more hot leads", listOf(SumLine("Open Closer OS", "to see all and download")))
    return out
}

fun buildSummary(s: JsonObject, currency: String, hotOverride: JsonObject? = null): SumModel {
    val st = s["stats"]!!.jsonObject
    val tz = runCatching { ZoneId.of(s.t("tz")) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    val money = { v: Double -> java.text.NumberFormat.getCurrencyInstance(java.util.Locale("en", "IN")).apply {
        runCatching { this.currency = java.util.Currency.getInstance(currency) }; maximumFractionDigits = 0 }.format(v) }
    val morning = s.t("kind") == "morning"
    val done = mutableListOf<SumSection>()
    val res = if (morning) "Yesterday" else "Today"
    val dialled = st.i("dialled"); val missed = st.i("missed"); val open = st.i("missed_open"); val leads = st.i("leads")
    val totalCalls = dialled + st.i("received") + missed
    done += SumSection("$res · calls", listOf(
        SumLine("Total calls", "$totalCalls"),
        SumLine("Dialled", "$dialled"),
        SumLine("Connected calls", "${st.i("connected")} of $dialled dialled (${pct(st.i("connected"), dialled)}%)"),
        SumLine("Received", "${st.i("received")}"),
        SumLine("Missed", "$missed" + if (missed > 0) (if (open > 0) " ($open not called back)" else " (all called back)") else ""),
        SumLine("Talk time · dialled", d(st.i("talk_out"))),
        SumLine("Talk time · received", d(st.i("talk_in"))),
        SumLine("Total talk time", d(st.i("talk")))))
    done += SumSection("$res · leads", listOf(
        SumLine("Total leads", "$leads"),
        SumLine("Leads connected", "${st.i("leads_connected")} of $leads (${pct(st.i("leads_connected"), leads)}%)"),
        SumLine("Talked 1 min or more", "${st.i("leads_1min")} of $leads (${pct(st.i("leads_1min"), leads)}%)")))
    done += SumSection("Results", listOfNotNull(
        SumLine("Sales", if (st.i("sales") > 0) "${st.i("sales")} · ${money(st.n("revenue"))}" else "0"),
        SumLine("Interested", "${st.i("interested")}"),
        if (st.i("call_later") > 0) SumLine("Asked to call later", "${st.i("call_later")}") else null,
        SumLine("Outcomes saved", "${st.i("conn_outcome")} of ${st.i("conversations")}")))
    run { // plan vs done
        val plH = s["plan"]?.jsonObject?.get("hot") as? JsonObject
        val pv = listOfNotNull(
            if (st.i("fu_due") > 0) SumLine("Follow-ups planned", "${st.i("fu_on_time") + st.i("fu_late")} of ${st.i("fu_due")} called (${st.i("fu_on_time")} on time)") else null,
            if (missed > 0) SumLine("Missed callers", "${st.i("called_back")} of ${st.i("called_back") + open} called back") else null,
            if ((plH?.i("total") ?: 0) > 0) SumLine("Hot leads", "${plH!!.i("talked_24h")} of ${plH.i("total")} talked to in the last 24 h") else null)
        if (pv.isNotEmpty()) done += SumSection("Plan vs done", pv) }
    bestHour((st["hours"] as? JsonArray)?.map { it.jsonObject } ?: emptyList())?.let {
        done += SumSection("Best hour", listOf(SumLine(slot(it.i("hr")), "${it.i("conn")} connected · ${d(it.i("talk"))}"))) }
    if (st.i("fu_due") > 0) done += SumSection("Follow-ups", listOfNotNull(
        SumLine("On time", "${st.i("fu_on_time")} of ${st.i("fu_due")}"),
        if (st.i("fu_late") > 0) SumLine("Late", "${st.i("fu_late")}") else null,
        if (st.i("fu_missed") > 0) SumLine("Not called", "${st.i("fu_missed")}") else null))
    (s["people"] as? JsonArray)?.map { it.jsonObject }?.takeIf { it.isNotEmpty() }?.let { people ->
        done += SumSection("Team", people.sortedWith(compareByDescending<JsonObject> { it["stats"]!!.jsonObject.i("talk") }.thenByDescending { it["stats"]!!.jsonObject.i("dialled") }).map { p ->
            val ps = p["stats"]!!.jsonObject; val sl = ps.i("sales")
            SumLine(p.t("name") ?: "Someone", if (ps.i("dialled") + ps.i("received") == 0) "no calls" else
                "${ps.i("dialled")} dialled · ${ps.i("leads_connected")} leads connected · ${d(ps.i("talk"))} · $sl sale${if (sl == 1) "" else "s"}")
        })
    }
    val pl = s["plan"]!!.jsonObject; val plan = mutableListOf<SumLine>()
    if (s["working_day"]?.jsonPrimitive?.booleanOrNull == false) plan += SumLine("Holiday", if (pl.i("follow_ups") > 0) "follow-ups are lined up if you want to call" else "no calls planned")
    plan += SumLine("Follow-ups due", "${pl.i("follow_ups")}")
    if (pl.i("overdue") > 0) plan += SumLine("Overdue from earlier", "${pl.i("overdue")}")
    if (open > 0) plan += SumLine("Missed callers to call back", "$open")
    if (pl.i("no_next") > 0) plan += SumLine("Interested, no next call planned", "${pl.i("no_next")}")
    (pl["webinars"] as? JsonArray)?.map { it.jsonObject }?.forEach { w ->
        val at = runCatching { com.closeros.app.data.parseInstant(w.t("at")!!).atZone(tz).format(DateTimeFormatter.ofPattern("h:mm a", java.util.Locale.ENGLISH)) }.getOrDefault("")
        plan += SumLine(w.t("name") ?: "Webinar", "$at · ${w.i("leads")} leads to remind")
    }
    val hotObj = hotOverride ?: (pl["hot"] as? JsonObject)
    val ownerName = (s["people"] as? JsonArray)?.associate { it.jsonObject.t("user_id") to (it.jsonObject.t("name") ?: "") } ?: emptyMap()
    val team = s["team"]?.jsonPrimitive?.booleanOrNull == true
    plan += SumLine("Hot leads", "${hotObj?.i("total") ?: 0}")
    val out = mutableListOf(SumSection("${if (morning) "Today" else "Tomorrow"} · plan", plan))
    val hotList = (hotObj?.get("list") as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    out += hotSections(hotList, hotObj?.i("total") ?: 0, tz, team) { ownerName[it] ?: "" }
    // Morning: today's tasks first, yesterday below. Evening: today's results first, then tomorrow.
    if (morning) out.addAll(done) else out.addAll(0, done)
    fun dn(k: String) = runCatching { LocalDate.parse(s.t(k)).format(DateTimeFormatter.ofPattern("EEE, d MMM")) }.getOrDefault(s.t(k) ?: "")
    val day = "Plan for ${dn("plan_day")} · Results of ${dn("day")}"
    val who = if (s["team"]?.jsonPrimitive?.booleanOrNull == true) "${s.t("org_name")} · Team" else s.t("who") ?: ""
    val hotLines = out.filter { it.title.startsWith("🔥") || it.title.startsWith("⭐") || it.title.startsWith("📝") }.flatMap { it.lines }
    val byCat = hotObj?.get("by_cat") as? JsonObject
    val byOwner = (hotObj?.get("by_owner") as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    val owners = if (team) byOwner.map { it.t("owner") }.distinct().sortedBy { ownerName[it] ?: "" } else emptyList()
    val grid = listOf(1, 9, 2, 3, 4, 5, 6, 7, 8).filter { (byCat?.i(it.toString()) ?: 0) > 0 }.map { c ->
        Triple((if (hotTop(c)) "🔥 " else if (c <= 7) "⭐ " else "📝 ") + (if (c == 8) "Not tagged yet" else HOT_CATS[c] ?: ""),
            owners.map { o -> byOwner.firstOrNull { it.t("owner") == o && it.i("cat") == c }?.i("n") ?: 0 }, byCat?.i(c.toString()) ?: 0) }
    val people = (s["people"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    val withCalls = people.filter { val ps = it["stats"]!!.jsonObject; ps.i("dialled") + ps.i("received") > 0 }
        .sortedByDescending { it["stats"]!!.jsonObject.i("talk") }
    val card = SumCard("${if (morning) "Morning" else "Evening"} summary", "${if (team) s.t("org_name") else s.t("who") ?: ""} · ${dn("plan_day")}",
        "${if (morning) "Today" else "Tomorrow"} · plan",
        listOf(listOfNotNull("Follow-ups due ${pl.i("follow_ups")}", if (pl.i("overdue") > 0) "Overdue ${pl.i("overdue")}" else null,
            if (open > 0) "Missed callers $open" else null, if (pl.i("no_next") > 0) "Interested, no next call ${pl.i("no_next")}" else null).joinToString(" · ")) +
            ((pl["webinars"] as? JsonArray)?.map { it.jsonObject }?.map { w -> "${w.t("name")} ${runCatching { com.closeros.app.data.parseInstant(w.t("at")!!).atZone(tz).format(DateTimeFormatter.ofPattern("h:mm a", java.util.Locale.ENGLISH)) }.getOrDefault("")} · ${w.i("leads")} to remind" } ?: emptyList()),
        hotObj?.i("total") ?: 0, owners.map { (ownerName[it] ?: "").substringBefore(' ').ifBlank { "Unassigned" } }, grid,
        hotLines.take(5), res,
        listOf("Calls $totalCalls · Dialled $dialled · Connected ${pct(st.i("connected"), dialled)}% · Leads connected ${st.i("leads_connected")}",
            "Talk ${d(st.i("talk"))} · Outcomes saved ${st.i("conn_outcome")} of ${st.i("conversations")} · Sales ${st.i("sales")}"),
        withCalls.map { val ps = it["stats"]!!.jsonObject; listOf(it.t("name") ?: "", "${ps.i("dialled") + ps.i("received") + ps.i("missed")}", "${ps.i("dialled")}", "${ps.i("leads_connected")}", d(ps.i("talk")), "${ps.i("sales")}") },
        people.filter { it !in withCalls }.map { it.t("name") ?: "" },
        listOf("Total calls" to "$totalCalls", "Dialled" to "$dialled", "Connected" to "${pct(st.i("connected"), dialled)}%", "Received" to "${st.i("received")}", "Missed" to "$missed",
            "Leads connected" to "${st.i("leads_connected")}", "Talked 1 min+" to "${st.i("leads_1min")}", "Talk · dialled" to d(st.i("talk_out")), "Talk · received" to d(st.i("talk_in")), "Total talk" to d(st.i("talk")), "Sales" to "${st.i("sales")}", "Outcomes saved" to "${st.i("conn_outcome")} of ${st.i("conversations")}"),
        listOfNotNull(bestHour((st["hours"] as? JsonArray)?.map { it.jsonObject } ?: emptyList())?.let { "Best hour ${slot(it.i("hr"))} · ${it.i("conn")} connected" },
            if (st.i("fu_due") > 0) "Follow-ups on time ${st.i("fu_on_time")} of ${st.i("fu_due")}" else null,
            if (open > 0) "$open missed callers not called back" else null, if (st.i("interested") > 0) "Interested ${st.i("interested")}" else null),
        "Made " + ZonedDateTime.now(tz).format(DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a")))
    fun avg(t: Int, n: Int) = if (n > 0) d(t / n) else "—"
    val conn = st.i("connected"); val rec = st.i("received")
    val activity = listOf(
        listOf("Dialled", "$dialled", "$conn (${pct(conn, dialled)}%)", d(st.i("talk_out")), avg(st.i("talk_out"), conn), "—"),
        listOf("Received", "$rec", "$rec", d(st.i("talk_in")), avg(st.i("talk_in"), rec), "—"),
        listOf("Missed", "$missed", "—", "—", "—", "$open"),
        listOf("Total", "$totalCalls", "${conn + rec}", d(st.i("talk")), avg(st.i("talk"), conn + rec), "$open"))
    val leadsRow = listOf("$leads", "${st.i("leads_connected")} (${pct(st.i("leads_connected"), leads)}%)", "${st.i("leads_1min")} (${pct(st.i("leads_1min"), leads)}%)",
        "${st.i("interested")}", "${st.i("conn_outcome")} of ${st.i("conversations")}", if (st.i("sales") > 0) "${st.i("sales")} · ${money(st.n("revenue"))}" else "0")
    val teamWide = (s["people"] as? JsonArray)?.map { it.jsonObject }?.sortedByDescending { it["stats"]!!.jsonObject.i("talk") }?.map { p ->
        val ps = p["stats"]!!.jsonObject; val c = ps.i("connected"); val r = ps.i("received")
        if (ps.i("dialled") + r + ps.i("missed") == 0) listOf(p.t("name") ?: "") + List(11) { "—" }
        else listOf(p.t("name") ?: "", "${ps.i("dialled")}", "$c", sd(ps.i("talk_out")), if (c > 0) sd(ps.i("talk_out") / c) else "—",
            "$r", sd(ps.i("talk_in")), if (r > 0) sd(ps.i("talk_in") / r) else "—", "${ps.i("missed")}", sd(ps.i("talk")), "${ps.i("leads_connected")}", "${ps.i("sales")}")
    } ?: emptyList()
    return SumModel("${if (morning) "Morning" else "Evening"} summary", "$who · $day · Made ${ZonedDateTime.now(tz).format(DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a"))}", out,
        hotTotal = hotObj?.i("total") ?: 0, hotShown = hotList.size, card = card, hot = hotLines, teamView = team,
        activity = activity, leadsRow = leadsRow, teamWide = teamWide)
}

fun summaryText(m: SumModel): String {
    val out = mutableListOf("*Closer OS · ${m.title}*", m.sub)
    for (sec in m.sections) {
        if (sec.title.startsWith("🔥") || sec.title.startsWith("⭐") || sec.title.startsWith("📝") || sec.title.startsWith("+")) continue
        out += ""; out += "*${sec.title}*"; sec.lines.forEach { out += "${it.label}: ${it.value}" }
        if (sec.title.endsWith("· plan") && m.hot.isNotEmpty()) {
            m.hot.groupBy { it.owner ?: "" }.forEach { (o, rows) ->
                out += ""; out += "*🔥 Hot leads${if (m.teamView && o.isNotBlank()) " — $o" else ""} (${rows.size})*"
                var cat = 0
                rows.forEachIndexed { i, r ->
                    if (r.cat != cat) { cat = r.cat; out += "_${HOT_CATS[cat]}_" }
                    out += "${i + 1}. ${r.name ?: ""} · ${r.phone ?: ""}"; out += "    ${r.short ?: ""}"
                }
            }
            if (m.hotTotal > m.hotShown) out += "+${m.hotTotal - m.hotShown} more — open Closer OS"
        }
    }
    return out.joinToString("\n")
}

private object Col { const val brand = 0xFF0E5E57; const val soft = 0xFFE8F3F1; const val ink = 0xFF1D2433; const val muted = 0xFF5B6576
    const val faint = 0xFF98A2B3; const val line = 0xFFE3E7EE; const val zebra = 0xFFF7F8FA; const val link = 0xFF0B63C5 }

/** Drawing kit shared by the image and the PDF (canvas null = measure only). */
private class Kit(val c: Canvas?, val w: Float, val pad: Float) {
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private fun font(size: Float, bold: Boolean) { p.textSize = size; p.typeface = Typeface.create(Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL) }
    fun t(s: String, x: Float, y: Float, size: Float, color: Long, bold: Boolean = false, right: Boolean = false): Float {
        font(size, bold); p.color = color.toInt(); p.textAlign = if (right) Paint.Align.RIGHT else Paint.Align.LEFT
        c?.drawText(s, x, y, p); p.textAlign = Paint.Align.LEFT; return p.measureText(s) }
    fun tc(s: String, x: Float, y: Float, size: Float, color: Long) { font(size, true); p.color = color.toInt(); p.textAlign = Paint.Align.CENTER; c?.drawText(s, x, y, p); p.textAlign = Paint.Align.LEFT }
    fun mw(s: String, size: Float, bold: Boolean): Float { font(size, bold); return p.measureText(s) }
    fun fit(s: String, size: Float, bold: Boolean, max: Float): String { font(size, bold); if (p.measureText(s) <= max) return s
        var v = s; while (v.length > 2 && p.measureText("$v…") > max) v = v.dropLast(1); return "$v…" }
    fun rect(x: Float, y: Float, rw: Float, rh: Float, color: Long, r: Float = 0f) { c ?: return; p.color = color.toInt()
        if (r > 0) c.drawRoundRect(x, y, x + rw, y + rh, r, r, p) else c.drawRect(x, y, x + rw, y + rh, p) }
    fun head(s: String, y0: Float): Float { val y = y0 + 22; t(s.uppercase(), pad, y, 24f, Col.brand, true); rect(pad, y + 12, w - pad * 2, 2f, Col.line); return y + 40 }
    /** cols = (title, share, right-aligned). Header row only when a title is set. */
    fun table(y0: Float, cols: List<Triple<String, Float, Boolean>>, rows: List<List<String>>, size: Float = 26f, rowH: Float = 50f): Float {
        var y = y0; val inner = w - pad * 2; val tot = cols.sumOf { it.second.toDouble() }.toFloat()
        val xs = mutableListOf<Float>(); var x = pad; cols.forEach { xs += x; x += inner * it.second / tot }
        val g2 = if (size < 20) 6f else 12f
        fun cell(i: Int, s: String, yy: Float, sz: Float, col: Long, bold: Boolean) { val cw = inner * cols[i].second / tot
            t(fit(s, sz, bold, cw - g2 * 2), if (cols[i].third) xs[i] + cw - g2 else xs[i] + g2, yy, sz, col, bold, cols[i].third) }
        if (cols.any { it.first.isNotEmpty() }) { rect(pad, y, inner, rowH - 6, Col.soft, 8f); cols.forEachIndexed { i, cc -> cell(i, cc.first, y + rowH / 2 + 2, minOf(20f, size), Col.brand, true) }; y += rowH }
        rows.forEachIndexed { ri, r -> if (ri % 2 == 1) rect(pad, y - 4, inner, rowH, Col.zebra)
            cols.indices.forEach { i -> cell(i, r.getOrElse(i) { "" }, y + rowH / 2 + 4, size, Col.ink, i > 0) }; y += rowH }
        return y + 16 }
}

/** ONE phone-shaped picture (4:5, drawn at 2× so WhatsApp keeps it sharp). */
fun summaryBitmap(m: SumModel): Bitmap {
    val k = m.card ?: return listBitmap(m).first
    val w = 1080f; val pad = 56f; val sc = 2f
    fun draw(c: Canvas?, h: Float): Float {
        val g = Kit(c, w, pad)
        g.rect(0f, 0f, w, h, 0xFFFFFFFF); g.rect(0f, 0f, w, 176f, Col.brand)
        g.t("Closer OS", pad, 54f, 24f, 0xFFCFE7E3, true); g.t(k.at, w - pad, 54f, 22f, 0xFFCFE7E3, false, true); g.t(k.header, pad, 112f, 48f, 0xFFFFFFFF, true); g.t(g.fit(k.sub, 26f, false, w - pad * 2), pad, 152f, 26f, 0xFFCFE7E3)
        var y = g.head(k.resultsTitle, 204f)
        val per = 4; val tw = (w - pad * 2 - (per - 1) * 12) / per; val rowsN = (k.stats.size + per - 1) / per
        k.stats.forEachIndexed { i, (l, v) -> val x = pad + (i % per) * (tw + 12); val yy = y + (i / per) * 104
            g.rect(x, yy, tw, 92f, Col.zebra, 12f); g.t(g.fit(l, 18f, true, tw - 24), x + 14, yy + 32, 18f, Col.muted, true); g.t(g.fit(v, 32f, true, tw - 24), x + 14, yy + 74, 32f, Col.ink, true) }
        y += rowsN * 104 + 26
        k.extra.forEach { g.t("• $it", pad, y, 24f, Col.muted); y += 36 }
        y = g.head(k.planTitle, y + 18)
        k.plan.forEach { g.t(g.fit(it, 26f, false, w - pad * 2), pad, y, 26f, Col.ink); y += 38 }
        if (k.hotTotal > 0) {
            y = g.head("Hot leads · ${k.hotTotal}", y + 18)
            y = g.table(y, listOf(Triple("Category", 4f, false)) + k.cols.map { Triple(it, 1.3f, true) } + Triple("Total", 1.3f, true),
                k.grid.map { (l, v, tot) -> listOf(l) + v.map { "$it" } + "$tot" })
            if (k.top.isNotEmpty()) { g.t("Call first", pad, y + 10, 22f, Col.muted, true); y += 44
                y = g.table(y, listOf(Triple("Lead", 3.2f, false), Triple("Phone", 2.2f, false), Triple("Why", 3f, false)),
                    k.top.map { listOf((it.name ?: "") + (if (m.teamView && !it.owner.isNullOrBlank()) " · ${it.owner!!.substringBefore(' ')}" else ""), it.phone ?: "", it.tag.ifBlank { it.web.split(" · ").take(2).joinToString(" · ") }) }, 22f, 44f) }
        }
        if (k.team.isNotEmpty()) {
            y = g.head("Team", y)
            y = g.table(y, listOf(Triple("Team member", 4f, false), Triple("Calls", 1.2f, true), Triple("Dialled", 1.4f, true), Triple("Leads conn.", 1.8f, true), Triple("Talk", 1.6f, true), Triple("Sales", 1.2f, true)), k.team, 24f, 46f)
            if (k.noCalls.isNotEmpty()) { g.t(g.fit("No calls: ${k.noCalls.joinToString(", ")}", 22f, false, w - pad * 2), pad, y, 22f, Col.faint); y += 34 }
        }
        g.t("Made with Closer OS", pad, h - 28, 20f, Col.faint)
        return y + 50
    }
    val h = maxOf(w * 1.25f, draw(null, 0f))
    val b = Bitmap.createBitmap((w * sc).toInt(), (h * sc).toInt(), Bitmap.Config.ARGB_8888); val c = Canvas(b); c.scale(sc, sc); draw(c, h)
    return b
}

data class TelLink(val x: Float, val y: Float, val w: Float, val h: Float, val phone: String)

/** The PDF page: clean header, tables, hot leads grouped by category → team member, tap-to-call phones. */
fun listBitmap(m: SumModel): Pair<Bitmap, List<TelLink>> {
    val w = 1080f; val pad = 56f; val sc = 1.5f
    val links = mutableListOf<TelLink>()
    fun draw(c: Canvas?, h: Float): Float {
        val g = Kit(c, w, pad); links.clear()
        g.rect(0f, 0f, w, h, 0xFFFFFFFF); g.rect(0f, 0f, w, 190f, Col.brand)
        val parts = m.sub.split(" · ")
        val at = parts.firstOrNull { it.startsWith("Made ") } ?: ""
        g.t("Closer OS", pad, 54f, 24f, 0xFFCFE7E3, true); g.t(at, w - pad, 54f, 22f, 0xFFCFE7E3, false, true); g.t(m.title, pad, 110f, 48f, 0xFFFFFFFF, true)
        g.t(g.fit(parts.first(), 26f, true, w - pad * 2), pad, 146f, 26f, 0xFFFFFFFF, true); g.t(g.fit(parts.drop(1).filter { it != at }.joinToString(" · "), 22f, false, w - pad * 2), pad, 176f, 22f, 0xFFCFE7E3)
        var y = 236f
        // Key/value sections as cards, two per row: label left, value right inside the card.
        val cards = mutableListOf<SumSection>()
        fun cardGrid(): Unit { val gap = 20f; val half = (w - pad * 2 - gap) / 2; val full = w - pad * 2; val lh = 42f
            // A card is full width when any line would not fit in half the page — text is never cut.
            fun wide(sec: SumSection) = sec.lines.any { g.mw(it.label, 20f, false) + g.mw(it.value, 21f, true) + 80 > half }
            val rows = mutableListOf<MutableList<SumSection>>()
            cards.forEach { sec -> val last = rows.lastOrNull()
                if (!wide(sec) && last != null && last.size == 1 && !wide(last[0])) last += sec else rows += mutableListOf(sec) }
            rows.forEach { row -> val cw = if (row.size == 1 && wide(row[0])) full else half
                val hh = 64 + row.maxOf { it.lines.size } * lh + 10
                row.forEachIndexed { j, sec -> val x = pad + j * (cw + gap)
                    g.rect(x, y, cw, hh, Col.line, 14f); g.rect(x + 1.5f, y + 1.5f, cw - 3, hh - 3, 0xFFFFFFFF, 13f)
                    g.t(g.fit(sec.title.uppercase(), 20f, true, cw - 40), x + 20, y + 40, 20f, Col.brand, true)
                    sec.lines.forEachIndexed { n, l -> val yy = y + 64 + n * lh
                        if (n % 2 == 0) g.rect(x + 10, yy, cw - 20, lh, Col.zebra, 6f)
                        val v = g.fit(l.value, 21f, true, cw * 0.6f); val vw = g.t(v, x + cw - 22, yy + 28, 21f, Col.ink, true, true)
                        g.t(g.fit(l.label, 20f, false, cw - 56 - vw), x + 22, yy + 28, 20f, Col.muted) } }
                y += hh + gap }
            cards.clear(); y += 6 }
        for (sec in m.sections) {
            if (listOf("🔥", "⭐", "📝", "+").any { sec.title.startsWith(it) }) continue
            if (m.activity.isNotEmpty() && sec.title.endsWith(" · calls")) {
                cardGrid(); y = g.head(sec.title.replace(" · calls", " · call activity"), y)
                y = g.table(y, listOf(Triple("", 2.2f, false), Triple("Calls", 1.4f, true), Triple("Connected", 2f, true), Triple("Talk time", 1.8f, true),
                    Triple("Avg per call", 1.8f, true), Triple("Not called back", 2.1f, true)), m.activity, 24f, 48f)
                g.t("Avg per call = talk time ÷ connected calls.", pad, y - 2, 18f, Col.faint); y += 22
                continue
            }
            if (m.leadsRow.isNotEmpty() && sec.title.endsWith(" · leads")) {
                y = g.head(sec.title, y)
                y = g.table(y, listOf(Triple("Leads", 1.2f, true), Triple("Connected", 1.9f, true), Triple("Talked 1 min+", 1.9f, true), Triple("Interested", 1.5f, true),
                    Triple("Outcomes saved", 2f, true), Triple("Sales", 1.6f, true)), listOf(m.leadsRow), 24f, 48f)
                continue
            }
            if (m.leadsRow.isNotEmpty() && sec.title == "Results") continue
            if (sec.title != "Team") { cards += sec; continue }
            cardGrid(); y = g.head(sec.title, y)
            if (sec.title == "Team") {
                val inner = w - pad * 2
                g.rect(pad + inner * 2f / 14.5f, y - 14, inner * 4.5f / 14.5f - 6, 22f, 0xFFE8F3F1, 6f); g.tc("DIALLED", pad + inner * 4.25f / 14.5f, y + 2, 15f, Col.brand)
                g.rect(pad + inner * 6.5f / 14.5f, y - 14, inner * 3.5f / 14.5f - 6, 22f, 0xFFEEF2FF, 6f); g.tc("RECEIVED", pad + inner * 8.25f / 14.5f, y + 2, 15f, 0xFF3346A8)
                y += 16
                y = g.table(y, listOf(Triple("Member", 2f, false), Triple("Calls", 1f, true), Triple("Conn.", 1f, true), Triple("Talk", 1.2f, true), Triple("Avg", 1.3f, true),
                    Triple("Calls", 1f, true), Triple("Talk", 1.2f, true), Triple("Avg", 1.3f, true), Triple("Missed", 1.2f, true), Triple("All talk", 1.2f, true),
                    Triple("Leads", 1.1f, true), Triple("Sales", 1f, true)), m.teamWide, 18f, 44f)
                g.t("Conn. = dialled calls that connected · Avg = talk ÷ connected calls · Leads = leads connected", pad, y - 2, 17f, Col.faint); y += 22
            }
        }
        cardGrid()
        if (m.hot.isNotEmpty()) {
            y = g.head("Hot leads · ${m.hotTotal}", y)
            HOT_NOTE.split(' ').fold(mutableListOf("")) { acc, wd -> if ((acc.last() + " " + wd).length > 80) acc += wd else acc[acc.size - 1] = (acc.last() + " " + wd).trim(); acc }
                .forEach { g.t(it, pad, y, 20f, Col.faint); y += 28 }
            y += 12
            for (cat in m.hot.map { it.cat }.distinct()) {
                val inCat = m.hot.filter { it.cat == cat }
                g.rect(pad, y - 4, w - pad * 2, 50f, if (hotTop(cat)) 0xFFFFF4E5 else if (cat <= 7) 0xFFFFF9DB else 0xFFEEF2FF, 10f)
                g.t("${if (hotTop(cat)) "🔥" else if (cat <= 7) "⭐" else "📝"}  ${HOT_CATS[cat]} · ${inCat.size}", pad + 16, y + 30, 24f, Col.ink, true); y += 64
                for (o in inCat.map { it.owner ?: "" }.distinct()) {
                    val mine = inCat.filter { (it.owner ?: "") == o }
                    if (m.teamView && o.isNotBlank()) { g.t("$o · ${mine.size}", pad, y + 6, 22f, Col.brand, true); y += 30 }
                    val xs = listOf(pad, pad + 270, pad + 490, pad + 750); val rowH = 72f
                    g.rect(pad, y, w - pad * 2, 40f, Col.zebra, 6f)
                    listOf("Lead", "Phone (tap to call)", "Webinar", "Calls").forEachIndexed { i, hh -> g.t(hh, xs[i] + 12, y + 27, 18f, Col.muted, true) }
                    y += 46
                    mine.forEachIndexed { i, r ->
                        if (i % 2 == 1) g.rect(pad, y - 2, w - pad * 2, rowH, Col.zebra)
                        g.t(g.fit(r.name ?: "", 22f, true, 240f), xs[0] + 12, if (r.tag.isNotBlank() && r.tag != HOT_CATS[r.cat]) y + 26 else y + 32, 22f, Col.ink, true)
                        if (r.tag.isNotBlank() && r.tag != HOT_CATS[r.cat]) g.t(g.fit(r.tag, 16f, false, 270f), xs[0] + 12, y + 48, 16f, Col.muted)
                        val ph = r.phone ?: ""; val pw = g.t(ph, xs[1] + 12, y + 32, 22f, Col.link, true)
                        links += TelLink((xs[1] + 6) * sc, (y + 6) * sc, (pw + 14) * sc, 40f * sc, ph.filter { it.isDigit() || it == '+' })
                        // Webinar + calls wrap onto two lines instead of being cut off.
                        fun two(txt: String, x: Float, cw: Float) { val lines = mutableListOf<String>(); var cur = ""
                            txt.split(" · ").forEach { p -> val nx = if (cur.isEmpty()) p else "$cur · $p"
                                if (cur.isNotEmpty() && g.fit(nx, 18f, false, cw) != nx) { lines += cur; cur = p } else cur = nx }
                            if (cur.isNotEmpty()) lines += cur
                            val top = y + 32 - (minOf(lines.size, 3) - 1) * 10
                            lines.take(3).forEachIndexed { i, l -> g.t(g.fit(l, 18f, false, cw), x, top + i * 21, 18f, if (i == 0) Col.ink else Col.muted) } }
                        two(r.web, xs[2] + 12, xs[3] - xs[2] - 24); two(r.work, xs[3] + 12, w - pad - xs[3] - 20)
                        y += rowH }
                    y += 14
                }
            }
            if (m.hotTotal > m.hotShown) { g.t("+${m.hotTotal - m.hotShown} more — download the full list in Closer OS", pad, y + 10, 20f, Col.muted); y += 40 }
        }
        g.t("Made with Closer OS", pad, h - 28, 20f, Col.faint)
        return y + 60
    }
    val h = draw(null, 0f)
    val b = Bitmap.createBitmap((w * sc).toInt(), (h * sc).toInt(), Bitmap.Config.ARGB_8888); val c = Canvas(b); c.scale(sc, sc); draw(c, h)
    return b to links.toList()
}

/** One-page PDF of the full list with tap-to-call links (written by hand: Android's PdfDocument can't add links). */
fun summaryPdf(m: SumModel): ByteArray {
    val (bmp, links) = listBitmap(m)
    val jpg = java.io.ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    val pw = 595f; val ph = 595f * bmp.height / bmp.width; val k = pw / bmp.width
    val out = java.io.ByteArrayOutputStream(); val offs = IntArray(6)
    fun add(s: String) = out.write(s.toByteArray(Charsets.ISO_8859_1))
    fun obj(n: Int, body: () -> Unit) { offs[n] = out.size(); add("$n 0 obj\n"); body(); add("\nendobj\n") }
    fun f(v: Float) = String.format(java.util.Locale.US, "%.1f", v)
    add("%PDF-1.4\n")
    obj(1) { add("<< /Type /Catalog /Pages 2 0 R >>") }
    obj(2) { add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>") }
    val annots = links.joinToString(" ") { l -> "<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${f(l.x * k)} ${f(ph - (l.y + l.h) * k)} ${f((l.x + l.w) * k)} ${f(ph - l.y * k)}] /A << /S /URI /URI (tel:${l.phone}) >> >>" }
    obj(3) { add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R /Annots [$annots] >>") }
    obj(4) { add("<< /Type /XObject /Subtype /Image /Width ${bmp.width} /Height ${bmp.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.size} >>\nstream\n"); out.write(jpg); add("\nendstream") }
    val content = "q ${f(pw)} 0 0 ${f(ph)} 0 0 cm /Im0 Do Q"
    obj(5) { add("<< /Length ${content.length} >>\nstream\n$content\nendstream") }
    val xref = out.size()
    add("xref\n0 6\n0000000000 65535 f \n" + (1..5).joinToString("") { String.format(java.util.Locale.US, "%010d 00000 n \n", offs[it]) } +
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$xref\n%%EOF")
    return out.toByteArray()
}

private fun shareFile(ctx: Context, f: File, mime: String) {
    val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
    val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { ctx.startActivity(Intent.createChooser(i, "Share summary").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Full hot-leads list as a CSV in Downloads (every detail). */
fun saveHotCsv(ctx: Context, full: JsonObject, people: Map<String?, String>, tz: ZoneId) {
    fun q(v: Any?) = "\"" + (v?.toString() ?: "").replace("\"", "\"\"") + "\""
    fun t(v: String?) = v?.let { runCatching { com.closeros.app.data.parseInstant(it).atZone(tz).format(DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a")) }.getOrNull() } ?: ""
    val sb = StringBuilder("#,Category,Lead,Phone,Owner,Tag,Outcome,Registered,Attended,Watched (min),Best (min),Best webinar,Saw the payment link,Chats,Polls,Talk (min),Talk by team member,Calls,WhatsApp,Last talked,Next call\n")
    ((full["list"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()).forEachIndexed { i, h ->
        val by = (h["talk_by"] as? JsonArray)?.map { it.jsonObject }?.joinToString("; ") { "${people[it.t("user")] ?: ""} ${it.i("sec") / 60}m" } ?: ""
        sb.append(listOf(i + 1, HOT_CATS[h.i("cat")], h.t("name"), h.t("phone"), people[h.t("owner")] ?: "", h.t("tag"), h.t("outcome"), h.i("reg"), h.i("att"),
            h.i("watch"), h.i("best"), t(h.t("best_at")), if (h["pitch"]?.jsonPrimitive?.booleanOrNull == true) "yes" else "", h.i("chats"), h.i("polls"),
            h.i("talk") / 60, by, h.i("calls"), h.i("wa"), t(h.t("last_talk")), t(h.t("next"))).joinToString(",") { q(it) }).append('\n')
    }
    saveToDownloads(ctx, "hot-leads-${System.currentTimeMillis() / 1000}.csv", "text/csv") { it.write(sb.toString().toByteArray()) }
}

fun saveToDownloads(ctx: Context, name: String, mime: String, write: (java.io.OutputStream) -> Unit) {
    runCatching {
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val v = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime) }
            val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
            ctx.contentResolver.openOutputStream(uri)!!.use(write)
        } else {
            val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
            File(dir, name).outputStream().use(write)
        }
        Toast.makeText(ctx, "Saved in Downloads: $name", Toast.LENGTH_LONG).show()
    }.onFailure {
        val f = File(File(ctx.cacheDir, "shared").apply { mkdirs() }, name); f.outputStream().use(write); shareFile(ctx, f, mime)
    }
}

/** Save to the phone's Downloads folder. */
fun downloadSummary(ctx: Context, m: SumModel, pdf: Boolean) {
    val name = "${m.title.replace(' ', '-').lowercase()}-${System.currentTimeMillis() / 1000}.${if (pdf) "pdf" else "png"}"
    val mime = if (pdf) "application/pdf" else "image/png"
    runCatching {
        val write: (java.io.OutputStream) -> Unit = { os ->
            if (pdf) os.write(summaryPdf(m)) else summaryBitmap(m).compress(Bitmap.CompressFormat.PNG, 100, os)
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val v = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
            }
            val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
            ctx.contentResolver.openOutputStream(uri)!!.use(write)
        } else {
            val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
            File(dir, name).outputStream().use(write)
        }
        Toast.makeText(ctx, "Saved in Downloads: $name", Toast.LENGTH_LONG).show()
    }.onFailure { if (pdf) shareSummaryPdf(ctx, m) else shareSummaryImage(ctx, m) }
}

fun shareSummaryImage(ctx: Context, m: SumModel) {
    val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    val f = File(dir, "${m.title.replace(' ', '-').lowercase()}.png")
    f.outputStream().use { summaryBitmap(m).compress(Bitmap.CompressFormat.PNG, 100, it) }
    shareFile(ctx, f, "image/png")
}

fun shareSummaryPdf(ctx: Context, m: SumModel) {
    val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    val f = File(dir, "${m.title.replace(' ', '-').lowercase()}.pdf"); f.writeBytes(summaryPdf(m))
    shareFile(ctx, f, "application/pdf")
}

@Composable
fun SummaryScreen(vm: AppViewModel, initialKind: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val m = vm.membership ?: return
    var kind by remember { mutableStateOf(initialKind) }
    val team = vm.isManager && !vm.isSolo
    var who by remember { mutableStateOf(if (team) "team" else "me") }
    var raw by remember { mutableStateOf<JsonObject?>(null) }
    var allHot by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(kind, who) {
        raw = null; allHot = null; error = null
        runCatching { Repo.dailySummary(m.org_id, kind, if (who == "me") null else who) }
            .onSuccess { raw = it }.onFailure { error = com.closeros.app.data.SafeError.forUser(it, "Couldn't load the summary") }
    }
    val data = remember(raw, allHot) { raw?.let { r -> runCatching { buildSummary(r, m.organization.currency, allHot) }.getOrNull() } }
    suspend fun fetchAll(): JsonObject? = runCatching { Repo.hotLeadsAll(m.org_id, if (who == "me" || who == "team") null else who) }
        .onFailure { Toast.makeText(ctx, com.closeros.app.data.SafeError.forUser(it, "Couldn't load the hot leads"), Toast.LENGTH_LONG).show() }.getOrNull()
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") }
            Text(if (kind == "morning") "Morning summary" else "Evening summary", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(kind == "morning", { kind = "morning" }, { Text("☀️ Morning · 8 AM") })
            FilterChip(kind == "evening", { kind = "evening" }, { Text("🌙 Evening · 9:30 PM") })
            if (team) { FilterChip(who == "team", { who = "team" }, { Text("Team") }); FilterChip(who == "me", { who = "me" }, { Text("Me") }) }
        }
        val dm = data
        if (dm == null) { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Brand.muted) else CircularProgressIndicator() }; return@Column }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Summary", summaryText(dm)))
                Toast.makeText(ctx, "Copied — paste it in WhatsApp", Toast.LENGTH_SHORT).show()
            }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Copy text", maxLines = 1) }
            if (vm.isManager || vm.isSolo) {
                OutlinedButton({ shareSummaryImage(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send image", maxLines = 1) }
                OutlinedButton({ shareSummaryPdf(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send PDF", maxLines = 1) }
            }
        }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ downloadSummary(ctx, dm, false) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download image", maxLines = 1) }
            OutlinedButton({ downloadSummary(ctx, dm, true) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download PDF", maxLines = 1) }
        }
        if (dm.hotTotal > 0) Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (dm.hotShown < dm.hotTotal) OutlinedButton({ scope.launch { fetchAll()?.let { allHot = it } } }, Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Show all ${dm.hotTotal} hot leads", maxLines = 1) }
            OutlinedButton({ scope.launch {
                val full = allHot ?: fetchAll() ?: return@launch
                allHot = full
                val people = (raw?.get("people") as? JsonArray)?.associate { it.jsonObject.t("user_id") to (it.jsonObject.t("name") ?: "") } ?: emptyMap()
                saveHotCsv(ctx, full, people, ZoneId.of(raw?.t("tz") ?: "Asia/Kolkata"))
            } }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Full hot list (CSV)", maxLines = 1) }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
            Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = androidx.compose.ui.graphics.Color.White)) {
                Column(Modifier.padding(16.dp)) {
                    Text(dm.sub, fontSize = 12.sp, color = Brand.muted)
                    dm.sections.forEach { s ->
                        Text(s.title.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Brand.primary, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
                        s.note?.let { Text(it, fontSize = 12.sp, color = Brand.muted, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic, modifier = Modifier.padding(bottom = 4.dp)) }
                        s.lines.forEach { l ->
                            if (l.leadId != null) Column(Modifier.fillMaxWidth().clickable { vm.openLeadId = l.leadId }.padding(vertical = 6.dp)) {
                                Text(l.label, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Brand.primary)
                                l.phone?.takeIf { it.isNotBlank() }?.let { CopyText(it.filter { c -> c.isDigit() || c == '+' }, it, fontSize = 14.sp, what = "Number copied") }
                                Text(l.value, fontSize = 13.sp)
                                l.sub?.let { Text(it, fontSize = 12.sp, color = Brand.muted) }
                            } else Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                Text(l.label, Modifier.weight(1f), fontSize = 14.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(l.value, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End)
                            }
                        }
                    }
                }
            }
        }
    }
}
