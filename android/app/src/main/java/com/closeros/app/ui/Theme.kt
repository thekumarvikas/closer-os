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

@Composable
fun CloserTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Brand.primary, onPrimary = Color.White, primaryContainer = Brand.light, onPrimaryContainer = Brand.primaryDark,
            secondary = Brand.gold, background = Brand.bg, surface = Color.White, error = Brand.red,
        ),
        content = content,
    )
}
