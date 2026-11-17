package com.closeros.app.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/** One "Where is this lead?" level. [color] is ARGB. */
data class IntentLevel(val key: String, val label: String, val short: String, val color: Long)

/**
 * Practical buying-intent levels, set with one tap (more useful than Hot / Warm / Cold).
 * Companies edit them on the dashboard (Settings → organizations.settings.intent_levels); same defaults there.
 */
object Intents {
    val defaults = listOf(
        IntentLevel("ready", "Ready to pay — said yes, sorting the payment", "Ready to pay", 0xFF059669),
        IntentLevel("hot", "Hot — deciding this week", "Hot", 0xFFEA580C),
        IntentLevel("interested", "Interested — needs follow-up", "Interested", 0xFFD97706),
        IntentLevel("approval", "Needs approval — spouse, boss or parent", "Needs approval", 0xFF7C3AED),
        IntentLevel("price", "Price concern — wants it, budget is the issue", "Price concern", 0xFFDB2777),
        IntentLevel("later", "Later — interested, but not now", "Later", 0xFF2563EB),
        IntentLevel("cold", "Cold — low interest", "Cold", 0xFF64748B),
        IntentLevel("nofit", "Not a fit", "Not a fit", 0xFF94A3B8),
    )

    fun levels(org: Org?): List<IntentLevel> = runCatching {
        org?.settings?.get("intent_levels")?.jsonArray?.mapNotNull { e ->
            val o = e.jsonObject
            fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val key = s("key") ?: return@mapNotNull null
            val label = s("label") ?: key
            val c = s("color")?.removePrefix("#")?.toLongOrNull(16)?.let { 0xFF000000 or it } ?: 0xFF64748B
            IntentLevel(key, label, s("short") ?: label.substringBefore(" —"), c)
        }?.takeIf { it.isNotEmpty() }
    }.getOrNull() ?: defaults

    fun of(org: Org?, key: String?): IntentLevel? = key?.let { k -> levels(org).firstOrNull { it.key == k } ?: defaults.firstOrNull { it.key == k } }

    /** Saves (or clears) the level; queued when offline. */
    suspend fun set(leadId: String, key: String?): Boolean = Ops.rpc("set_lead_intent", kotlinx.serialization.json.buildJsonObject {
        put("p_lead", JsonPrimitive(leadId)); put("p_intent", JsonPrimitive(key))
    })
}
