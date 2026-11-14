package com.closeros.app.data

import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** An objection (what the lead says) with its answers and how they did. */
@Serializable data class ObjAnswer(val id: String, val body: String? = null, val status: String = "published", val mine: Boolean = false,
    val by: String? = null, val used: Int = 0, val bought: Int = 0)
@Serializable data class Objection(
    val id: String, val title: String, val body: String? = null, val section: String? = null, val status: String = "published",
    val mine: Boolean = false, val by: String? = null, val raised: Int = 0, val bought: Int = 0,
    /** Use of the objection's own first answer (its body). */
    val answer_used: Int = 0, val answer_bought: Int = 0,
    val answers: List<ObjAnswer> = emptyList(),
) {
    /** Every answer, best first (most sales, then most used); the objection's own text counts as one answer. */
    val allAnswers: List<ObjAnswer> get() = (listOfNotNull(body?.takeIf { it.isNotBlank() }?.let { ObjAnswer(id, it, status, mine, by, answer_used, answer_bought) }) + answers)
        .sortedWith(compareByDescending<ObjAnswer> { it.bought }.thenByDescending { it.used })
    val best: ObjAnswer? get() = allAnswers.firstOrNull { it.status == "published" } ?: allAnswers.firstOrNull()
}

/** The lead profile as the app reads it. */
data class LeadProfileData(val challenges: List<String> = emptyList(), val challengesText: String? = null, val goals: List<String> = emptyList(),
                           val goalsText: String? = null, val budget: String? = null, val budgetAmount: String? = null) {
    val challengeLine get() = (challenges + listOfNotNull(challengesText?.takeIf { it.isNotBlank() })).joinToString(", ").ifBlank { null }
    val goalLine get() = (goals + listOfNotNull(goalsText?.takeIf { it.isNotBlank() })).joinToString(", ").ifBlank { null }
    val budgetLine get() = listOfNotNull(budget, budgetAmount?.let { "≈ $it" }).joinToString(" ").ifBlank { null }
    val isEmpty get() = challengeLine == null && goalLine == null && budgetLine == null
}

object NoteKit {
    val DEFAULT_CHALLENGES = listOf("Not enough income", "No growth", "No time", "Lack of skills", "No clear plan", "Money is tight")
    val DEFAULT_GOALS = listOf("Earn more", "Job switch", "Start a business", "Grow my business", "Learn a skill", "Promotion")
    val DEFAULT_BUDGET = listOf("Under 10k", "10k–25k", "25k–50k", "50k+", "No budget yet")

    /** Tag groups when the company hasn't set any: each group shows only for the outcomes it fits. */
    val DEFAULT_TAG_GROUPS = listOf(
        TagGroup("Interest", "#15803D", listOf("Very interested", "Wants EMI", "Asked for details on WhatsApp", "Comparing with others"), listOf("won", "positive", "connected")),
        TagGroup("Hesitation", "#B45309", listOf("Price objection", "Needs to ask family", "Not the right time", "Busy — call in evening"), listOf("positive", "connected", "lost")),
        TagGroup("Lost", "#B91C1C", listOf("Already bought elsewhere", "Not the right person", "No money now"), listOf("lost", "invalid")),
        TagGroup("Couldn't talk", "#475569", listOf("Switched off", "Network issue", "Call cut", "Will call back"), listOf("not_connected")),
    )

    /** Sentences with gaps. [a/b/c] = choices (or type), [budget] [goal] [challenge] = from the lead profile and saved there, [something] = type it. */
    val DEFAULT_LINES = listOf(
        NoteLine("Interested in [product]", listOf("positive", "won")),
        NoteLine("Will decide after talking to [spouse/parent/boss/partner]", listOf("positive", "connected")),
        NoteLine("Wants [EMI/a discount/more details/a demo]", listOf("positive", "connected")),
        NoteLine("Budget: [budget]", listOf("positive", "connected")),
        NoteLine("Goal: [goal]", listOf("positive", "connected")),
        NoteLine("Challenge: [challenge]", listOf("positive", "connected", "lost")),
        NoteLine("Call back after [salary date/exams/a trip/the weekend]", listOf("connected", "positive")),
        NoteLine("Best time to call: [morning/afternoon/evening/weekend]", listOf("connected", "positive", "not_connected")),
        NoteLine("Not interested because of [price/time/trust/already bought]", listOf("lost")),
        NoteLine("Paid by [UPI/card/bank transfer/cash]", listOf("won")),
        NoteLine("Phone was [switched off/busy/not reachable]", listOf("not_connected")),
    )

    private fun strings(o: JsonObject?, k: String): List<String>? = runCatching { o?.get(k)?.jsonArray?.map { it.jsonPrimitive.content } }.getOrNull()?.filter { it.isNotBlank() }

    fun profileOptions(settings: JsonObject?): ProfileOptions {
        val o = settings?.get("profile_options") as? JsonObject
        return ProfileOptions(strings(o, "challenges") ?: DEFAULT_CHALLENGES, strings(o, "goals") ?: DEFAULT_GOALS, strings(o, "budget") ?: DEFAULT_BUDGET)
    }

    fun noteLines(settings: JsonObject?): List<NoteLine> = runCatching {
        settings?.get("note_lines")?.jsonArray?.map { e -> val o = e.jsonObject
            NoteLine(o["text"]?.jsonPrimitive?.content.orEmpty(), strings(o, "show_for").orEmpty()) }?.filter { it.text.isNotBlank() }
    }.getOrNull() ?: DEFAULT_LINES

    fun linesFor(lines: List<NoteLine>, category: String?): List<NoteLine> = lines.filter { category == null || it.showFor.isEmpty() || category in it.showFor }

    /** A sentence split into plain text and gaps. */
    sealed class Part { data class Text(val s: String) : Part(); data class Gap(val name: String, val choices: List<String>, val field: String?) : Part() }
    fun parse(line: String, opts: ProfileOptions): List<Part> {
        val out = mutableListOf<Part>(); var i = 0
        Regex("\\[([^\\]]*)]").findAll(line).forEach { m ->
            if (m.range.first > i) out += Part.Text(line.substring(i, m.range.first))
            val inner = m.groupValues[1].trim()
            out += when (inner.lowercase()) {
                "budget" -> Part.Gap("budget", opts.budget, "budget")
                "goal", "goals" -> Part.Gap("goal", opts.goals, "goals")
                "challenge", "challenges" -> Part.Gap("challenge", opts.challenges, "challenges")
                else -> if (inner.contains('/')) Part.Gap(inner, inner.split('/').map { it.trim() }.filter { it.isNotBlank() }, null) else Part.Gap(inner, emptyList(), null)
            }
            i = m.range.last + 1
        }
        if (i < line.length) out += Part.Text(line.substring(i))
        return out
    }
    /** The sentence as a short label for a chip: gaps shown as "…". */
    fun preview(line: String) = line.replace(Regex("\\[[^\\]]*]"), "…")

    fun profileOf(lead: Lead?): LeadProfileData {
        val p = lead?.profile ?: return LeadProfileData()
        fun s(k: String) = (p[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        fun l(k: String) = runCatching { p[k]?.jsonArray?.map { it.jsonPrimitive.content } }.getOrNull().orEmpty()
        return LeadProfileData(l("challenges"), s("challenges_text"), l("goals"), s("goals_text"), s("budget"), s("budget_amount"))
    }

    /** The profile change as the server takes it (only the keys given). */
    fun patch(challenges: List<String>? = null, challengesText: String? = null, goals: List<String>? = null, goalsText: String? = null,
              budget: String? = null, budgetAmount: String? = null, profession: String? = null, city: String? = null) = buildJsonObject {
        challenges?.let { put("challenges", JsonArray(it.map(::JsonPrimitive))) }
        challengesText?.let { put("challenges_text", it) }
        goals?.let { put("goals", JsonArray(it.map(::JsonPrimitive))) }
        goalsText?.let { put("goals_text", it) }
        budget?.let { put("budget", it) }; budgetAmount?.let { put("budget_amount", it) }
        profession?.let { put("profession", it) }; city?.let { put("city", it) }
    }

    /** Merges a patch into the lead's copy on this phone (so the profile shows at once, also offline). */
    fun applyPatch(lead: Lead, patch: JsonObject): Lead {
        val prof = (lead.profile ?: JsonObject(emptyMap())).toMutableMap()
        patch.forEach { (k, v) ->
            if (k in setOf("challenges", "goals", "challenges_text", "goals_text", "budget", "budget_amount")) {
                val empty = (v as? JsonArray)?.isEmpty() == true || (v as? JsonPrimitive)?.contentOrNull.isNullOrBlank() && v !is JsonArray
                if (empty) prof.remove(k) else prof[k] = v
            }
        }
        return lead.copy(profile = JsonObject(prof),
            profession = if ("profession" in patch) patch["profession"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } else lead.profession,
            city = if ("city" in patch) patch["city"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } else lead.city)
    }
}

/** Server calls for the notes features. */
object Notes {
    private val db get() = Backend.client.postgrest

    suspend fun setProfileNow(leadId: String, patch: JsonObject) {
        db.rpc("set_lead_profile", buildJsonObject { put("p_lead", leadId); put("p", patch) })
    }
    /** Saves the profile; with no internet it waits on the phone and goes later. */
    suspend fun setProfile(ctx: android.content.Context, leadId: String, patch: JsonObject) {
        if (!Net.isOnline) { Ops.add(ctx, "profile", buildJsonObject { put("lead", leadId); put("p", patch) }); return }
        runCatching { setProfileNow(leadId, patch) }.onFailure {
            if (Net.isNetworkError(it)) Ops.add(ctx, "profile", buildJsonObject { put("lead", leadId); put("p", patch) }) else throw it
        }
    }

    suspend fun pin(leadId: String, ref: String, text: String, on: Boolean): List<Pin> =
        json.decodeFromString(db.rpc("pin_lead_note", buildJsonObject { put("p_lead", leadId); put("p_ref", ref); put("p_text", text); put("p_on", on) }).data)

    suspend fun objections(orgId: String): List<Objection> = json.decodeFromString(Repo.savedText("objections:$orgId") {
        db.rpc("objection_list", buildJsonObject { put("p_org", orgId) }).data
    })

    /** New objection (title + optional first answer) or, with [parentId], another answer. Returns its id. */
    suspend fun saveObjection(orgId: String, id: String? = null, title: String? = null, body: String? = null, parentId: String? = null): String =
        db.rpc("save_objection", buildJsonObject {
            put("p_org", orgId)
            put("p", buildJsonObject { id?.let { put("id", it) }; title?.let { put("title", it) }; body?.let { put("body", it) }; parentId?.let { put("parent_id", it) } })
        }).data.trim('"')

    /** Objections raised in a call, as stored in calls.outcome_data. */
    fun objectionsJson(picked: Map<String, String?>) = buildJsonArray {
        picked.forEach { (id, ans) -> add(buildJsonObject { put("id", id); ans?.let { put("answer", it) } }) }
    }
}
