package com.closeros.app.data

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/** Why a lead didn't buy — tapped when a "lost" outcome is saved. Same defaults as web/src/lib/lostReasons.ts. */
object LostReasons {
    val defaults = listOf(
        "price" to "Price / budget", "timing" to "Not now — timing", "noneed" to "Doesn't need it", "decider" to "Not the decision maker",
        "noshow" to "No-show / stopped answering", "competitor" to "Chose someone else", "trust" to "Not convinced / trust", "other" to "Other",
    )
    fun list(org: Org?): List<Pair<String, String>> = runCatching {
        org?.settings?.get("lost_reasons")?.jsonArray?.mapNotNull { e ->
            val o = e.jsonObject
            val k = (o["key"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            k to ((o["label"] as? JsonPrimitive)?.content ?: k)
        }?.takeIf { it.isNotEmpty() }
    }.getOrNull() ?: defaults
    fun label(org: Org?, key: String?): String? = key?.let { k -> if (k == "none") "No reason given" else (list(org) + defaults).firstOrNull { it.first == k }?.second ?: k }
}
