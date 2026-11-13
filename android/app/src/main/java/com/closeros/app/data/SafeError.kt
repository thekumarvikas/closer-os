package com.closeros.app.data

/**
 * Error texts that are safe to show or store. Server errors from the Supabase library carry the request
 * (URL, headers with the login token) in their message — never show or log that part.
 */
object SafeError {
    private val jwt = Regex("eyJ[A-Za-z0-9_-]{8,}(\\.[A-Za-z0-9_-]+){0,2}")
    private val bearer = Regex("(?i)(bearer|apikey|authorization)\\s*[=:]?\\s*\\[?[^\\],\\n]*")
    private val headers = Regex("(?s)Headers:\\s*\\[.*?](?=\\n|$)")
    private val keys = Regex("sb_(publishable|secret)_[A-Za-z0-9_-]+")

    /** Removes tokens, keys and request headers from any text. */
    fun clean(s: String?): String = (s ?: "").replace(headers, "Headers: [hidden]").replace(jwt, "[hidden]")
        .replace(bearer, "$1 [hidden]").replace(keys, "[hidden]")

    /** The short human reason (first line, without request details), e.g. "Lead not found". */
    fun reason(t: Throwable?): String {
        val m = clean(t?.message).substringBefore("\nURL").substringBefore("\n").trim()
        return m.substringAfter("ERROR:").trim().removePrefix("P0001:").trim().take(160)
    }

    /** What to show the person: a plain message, never technical text. */
    fun forUser(t: Throwable?, fallback: String): String {
        if (t != null && (Net.isNetworkError(t) || !Net.isOnline)) return "No internet — try again when you're online"
        val r = reason(t)
        val technical = r.isBlank() || r.length > 140 || r.contains("http", true) || r.contains("exception", true) ||
            r.contains("{") || r.contains("[hidden]") || r.contains("violates") || r.contains("column") || r.contains("relation")
        return if (technical) fallback else r
    }
}
