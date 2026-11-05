package com.closeros.app.data

import java.time.Instant
import java.time.OffsetDateTime

/**
 * Reads a time sent by the server ("2026-11-05T09:30:00+00:00" or "…Z").
 * Android 11 and older can't read the "+00:00" form with Instant.parse, so this tries both.
 */
fun parseInstant(s: String?): Instant = requireNotNull(s).let { s ->
    runCatching { OffsetDateTime.parse(s).toInstant() }.getOrNull()
        ?: runCatching { Instant.parse(s) }.getOrNull()
        ?: OffsetDateTime.parse(s.replace(' ', 'T')).toInstant()
}
