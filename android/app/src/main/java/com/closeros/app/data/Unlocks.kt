package com.closeros.app.data

import android.content.Context
import com.closeros.app.Monetize
import java.time.LocalDate

/**
 * Individual app: extra-power features open after a short ad (company builds: always open).
 * Calling queue = 25 calls per ad · WhatsApp queue = 15 messages · reports beyond today, Compare,
 * Lead work and Sales insights = 24 hours. Rules: the first unlock each day is free, an ad is asked
 * at most once every 10 minutes, and with no internet / no ad the feature simply opens.
 */
enum class Feature(val title: String, val gives: String, val credits: Int = 0, val hours: Int = 0) {
    QUEUE("Calling queue", "the next 25 calls", credits = 25),
    WA_QUEUE("WhatsApp queue", "the next 15 messages", credits = 15),
    REPORTS("Reports & insights", "reports, Compare, Lead work and Sales insights for 24 hours", hours = 24),
    /** Free plan: every import needs a short ad, up to 50 leads per file. */
    IMPORT("Import leads", "this import (up to 50 leads)", credits = 1),
}

object Unlocks {
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences("unlocks", Context.MODE_PRIVATE)
    fun adsOn(ctx: Context) = Monetize.ENABLED && !Monetize.adFree(ctx)

    /** True when the feature can be used right now without asking for an ad. */
    fun open(ctx: Context, f: Feature): Boolean {
        if (!adsOn(ctx)) return true
        return if (f.credits > 0) p(ctx).getInt("c_${f.name}", 0) > 0 else p(ctx).getLong("t_${f.name}", 0) > System.currentTimeMillis()
    }
    fun creditsLeft(ctx: Context, f: Feature) = p(ctx).getInt("c_${f.name}", 0)
    /** One call / message used. */
    fun use(ctx: Context, f: Feature) {
        if (!adsOn(ctx) || f.credits == 0) return
        p(ctx).edit().putInt("c_${f.name}", (creditsLeft(ctx, f) - 1).coerceAtLeast(0)).apply()
    }
    fun grant(ctx: Context, f: Feature) {
        val e = p(ctx).edit()
        if (f.credits > 0) e.putInt("c_${f.name}", f.credits) else e.putLong("t_${f.name}", System.currentTimeMillis() + f.hours * 3_600_000L)
        e.apply()
    }
    /** First unlock of the day is on the house. */
    fun takeFreeToday(ctx: Context): Boolean {
        val today = LocalDate.now().toString()
        if (p(ctx).getString("free_day", null) == today) return false
        p(ctx).edit().putString("free_day", today).apply(); return true
    }
    /** At most one ad request every 10 minutes: inside that window, features open without an ad. */
    fun askedRecently(ctx: Context) = System.currentTimeMillis() - p(ctx).getLong("asked_at", 0) < 10 * 60_000
    fun markAsked(ctx: Context) = p(ctx).edit().putLong("asked_at", System.currentTimeMillis()).apply()
}
