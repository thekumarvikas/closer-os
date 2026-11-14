package com.closeros.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object Brand {
    val primary = Color(0xFF0E5E57)
    val primaryDark = Color(0xFF0B3B37)
    val light = Color(0xFFEEF8F6)
    val gold = Color(0xFFF5B942)
    val red = Color(0xFFDC2626)
    val green = Color(0xFF059669)
    val muted = Color(0xFF64748B)
    val bg = Color(0xFFF8FAFC)
}

/**
 * Phones set to very large text or a large "Display size" squeezed our screens (words cut to "Foll…", "Playbo/ok").
 * Keep the layout readable: text grows at most 15% over normal, and the screen is laid out at least 360 dp wide
 * (the size every screen is designed for). Small-text and normal phones are unchanged.
 */
@Composable
fun ReadableScale(content: @Composable () -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    val widthDp = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp
    val shrink = if (widthDp in 1 until 360) widthDp / 360f else 1f
    val fixed = androidx.compose.ui.unit.Density(d.density * shrink, minOf(d.fontScale, 1.15f))
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides fixed, content = content)
}

@Composable
fun CloserTheme(content: @Composable () -> Unit) = ReadableScale {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Brand.primary, onPrimary = Color.White, primaryContainer = Brand.light, onPrimaryContainer = Brand.primaryDark,
            secondary = Brand.gold, background = Brand.bg, surface = Color.White, error = Brand.red,
        ),
        content = content,
    )
}
