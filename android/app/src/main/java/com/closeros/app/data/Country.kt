package com.closeros.app.data

import android.content.Context
import android.telephony.TelephonyManager
import java.util.Currency
import java.util.Locale
import java.util.TimeZone

/** The user's country, phone code, currency and time zone — from the SIM, else the phone's language settings. */
object Country {
    data class Info(val code: String, val prefix: String, val currency: String, val timezone: String) {
        val name: String get() = Locale("", code).displayCountry
    }

    fun detect(ctx: Context): Info {
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        val cc = listOfNotNull(tm?.simCountryIso, tm?.networkCountryIso, Locale.getDefault().country)
            .map { it.uppercase() }.firstOrNull { it.length == 2 && CODES.containsKey(it) } ?: "IN"
        return of(cc)
    }

    fun of(cc: String): Info {
        val currency = runCatching { Currency.getInstance(Locale("", cc)).currencyCode }.getOrNull() ?: "USD"
        return Info(cc, "+" + (CODES[cc] ?: "91"), currency, TimeZone.getDefault().id)
    }

    /** Country → international calling code. */
    val CODES: Map<String, String> = ("AE971 AF93 AL355 AM374 AO244 AR54 AT43 AU61 AZ994 BA387 BD880 BE32 BF226 BG359 BH973 BI257 BJ229 BN673 " +
        "BO591 BR55 BT975 BW267 BY375 BZ501 CA1 CD243 CF236 CG242 CH41 CI225 CL56 CM237 CN86 CO57 CR506 CU53 CY357 CZ420 DE49 DJ253 DK45 " +
        "DO1 DZ213 EC593 EE372 EG20 ER291 ES34 ET251 FI358 FJ679 FR33 GA241 GB44 GE995 GH233 GM220 GN224 GR30 GT502 GY592 HK852 HN504 HR385 " +
        "HT509 HU36 ID62 IE353 IL972 IN91 IQ964 IR98 IS354 IT39 JM1 JO962 JP81 KE254 KG996 KH855 KR82 KW965 KZ7 LA856 LB961 LK94 LR231 LS266 " +
        "LT370 LU352 LV371 LY218 MA212 MD373 ME382 MG261 MK389 ML223 MM95 MN976 MO853 MR222 MT356 MU230 MV960 MW265 MX52 MY60 MZ258 NA264 " +
        "NE227 NG234 NI505 NL31 NO47 NP977 NZ64 OM968 PA507 PE51 PG675 PH63 PK92 PL48 PR1 PS970 PT351 PY595 QA974 RO40 RS381 RU7 RW250 SA966 " +
        "SD249 SE46 SG65 SI386 SK421 SL232 SN221 SO252 SR597 SS211 SV503 SY963 SZ268 TD235 TG228 TH66 TJ992 TM993 TN216 TR90 TT1 TW886 TZ255 " +
        "UA380 UG256 US1 UY598 UZ998 VE58 VN84 YE967 ZA27 ZM260 ZW263")
        .split(' ').associate { it.take(2) to it.drop(2) }
}
