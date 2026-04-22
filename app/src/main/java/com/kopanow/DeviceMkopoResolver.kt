package com.kopanow

import android.content.Context
import androidx.annotation.VisibleForTesting
import kotlin.math.roundToLong

/**
 * MKOPO lookup from bundled device table: browse by brand/model and optional auto-match from [android.os.Build] fields.
 */
object DeviceMkopoResolver {

    data class Suggestion(
        val amountTzsRounded: Long,
        val label: String,
        val entry: DeviceMkopoEntry?
    )

    fun roundToNearest1000(tzs: Long): Long {
        if (tzs <= 0L) return tzs
        return (tzs / 1000.0).roundToLong() * 1000L
    }

    fun distinctBrands(entries: List<DeviceMkopoEntry>): List<String> =
        entries.map { it.brand }.distinct().sorted()

    fun modelsForBrand(entries: List<DeviceMkopoEntry>, brand: String): List<DeviceMkopoEntry> =
        entries.filter { it.brand.equals(brand, ignoreCase = true) }
            .sortedWith(compareBy({ it.series }, { it.model }))

    fun formatLine(entry: DeviceMkopoEntry, amountFormatted: String): String =
        "${entry.model} — $amountFormatted"

    /**
     * Best-effort match from device build strings (marketing names often differ from [android.os.Build.MODEL]).
     */
    fun suggestFromBuild(
        context: Context,
        manufacturer: String,
        brand: String,
        model: String,
        device: String
    ): Suggestion? {
        val entries = DeviceMkopoCatalog.getEntries(context)
        return suggestFromBuildEntries(entries, manufacturer, brand, model, device)
    }

    @JvmStatic
    @VisibleForTesting
    internal fun suggestFromBuildEntries(
        entries: List<DeviceMkopoEntry>,
        manufacturer: String,
        brand: String,
        model: String,
        device: String
    ): Suggestion? {
        val canonical = resolveCanonicalBrands(manufacturer, brand, model)
        if (canonical.isEmpty()) return null
        val hay = "$manufacturer $brand $model $device".lowercase()

        // Collect all matches across canonical brands, then pick the safest (lowest MKOPO).
        val matches = mutableListOf<DeviceMkopoEntry>()
        for (b in canonical) {
            val candidates = entries.filter { it.brand.equals(b, ignoreCase = true) }
            for (e in candidates) {
                if (entryMatchesBuild(e, hay)) matches += e
            }
        }
        val bestMatch = matches.minByOrNull { it.mkopoTzs }
        if (bestMatch != null) {
            val rounded = roundToNearest1000(bestMatch.mkopoTzs)
            return Suggestion(
                amountTzsRounded = rounded,
                label = "${bestMatch.brand} ${bestMatch.model}",
                entry = bestMatch
            )
        }

        // Fallback: brand is known but model didn't match — choose the minimum MKOPO for that brand.
        val fallback = canonical
            .mapNotNull { b ->
                val list = entries.filter { it.brand.equals(b, ignoreCase = true) }
                val min = list.minByOrNull { it.mkopoTzs }
                if (min == null) null else (b to min)
            }
            .minByOrNull { (_, e) -> e.mkopoTzs }
            ?.second

        if (fallback != null) {
            val rounded = roundToNearest1000(fallback.mkopoTzs)
            return Suggestion(
                amountTzsRounded = rounded,
                label = "${fallback.brand} (default)",
                entry = fallback
            )
        }

        return null
    }

    internal fun resolveCanonicalBrands(manufacturer: String, brand: String, model: String): List<String> {
        val m = manufacturer.lowercase()
        val b = brand.lowercase()
        val mo = model.lowercase()
        val out = LinkedHashSet<String>()

        when {
            // Samsung model codes: SM-*.
            mo.startsWith("sm-") -> out += "Samsung"
            "samsung" in m || "samsung" in b -> out += "Samsung"
            "google" in m || "google" in b || "pixel" in mo -> out += "Google"
            "xiaomi" in m || "xiaomi" in b || "redmi" in m || "redmi" in b || "redmi" in mo ||
                "poco" in m || "poco" in b || "poco" in mo -> out += "Xiaomi"
            "huawei" in m || "huawei" in b -> out += "Huawei"
            "honor" in m || "honor" in b -> out += "Honor"
            "oneplus" in m || "oneplus" in b -> out += "OnePlus"
            "oppo" in m || "oppo" in b -> out += "Oppo"
            "realme" in m || "realme" in b -> out += "Realme"
            "vivo" in m || "vivo" in b || "iqoo" in m || "iqoo" in mo -> out += "Vivo"
            "sony" in m || "sony" in b -> out += "Sony"
            "motorola" in m || "motorola" in b -> out += "Motorola"
            "nokia" in m || "hmd" in m || "hmd" in b -> out += "Nokia (HMD)"
            "nothing" in m || "nothing" in b -> out += "Nothing"
            "asus" in m || "asus" in b -> out += "Asus"
            "tecno" in m || "tecno" in b -> out += "Tecno"
            "infinix" in m || "infinix" in b -> out += "Infinix"
            "itel" in m || "itel" in b -> out += "Itel"
            "lenovo" in m || "lenovo" in b -> out += "Lenovo"
            "lg" in m || "lge" in m -> out += "LG"
            "meizu" in m || "meizu" in b -> out += "Meizu"
            "micromax" in m || "micromax" in b -> out += "Micromax"
            "nubia" in m || "nubia" in b -> out += "nubia"
            "sharp" in m || "sharp" in b -> out += "Sharp"
            "tcl" in m || "tcl" in b -> out += "TCL"
            "zte" in m || "zte" in b -> out += "ZTE"
            "alcatel" in m || "alcatel" in b || "tcl" in m -> out += "Alcatel"
            "blackberry" in m || "blackberry" in b -> out += "BlackBerry"
            "blackview" in m || "blackview" in b -> out += "Blackview"
            "blu" in m -> out += "BLU"
            "doogee" in m || "doogee" in b -> out += "Doogee"
            "fairphone" in m || "fairphone" in b -> out += "Fairphone"
            "ulefone" in m || "ulefone" in b -> out += "Ulefone"
        }

        if (out.isEmpty()) {
            // Fallback: try exact brand string from Build as table brand name
            if (manufacturer.isNotBlank()) {
                val guess = manufacturer.trim().replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
                out += guess
            }
        }

        return out.toList()
    }

    internal fun entryMatchesBuild(entry: DeviceMkopoEntry, hayLower: String): Boolean {
        entry.patterns?.forEach { p ->
            if (p.isNotBlank() && hayLower.contains(p.lowercase())) return true
        }
        val modelLower = entry.model.lowercase()
        if (modelLower.length >= 4 && hayLower.contains(modelLower)) return true

        val noGalaxy = entry.model.replace(Regex("(?i)(Samsung\\s+|Galaxy\\s+)"), "").trim()
        if (noGalaxy.length >= 3 && hayLower.contains(noGalaxy.lowercase())) return true

        val parts = entry.model.split(Regex("[\\s+/]+")).map { it.trim() }.filter { it.isNotEmpty() }
        val significant = parts.filter { part ->
            part.length >= 2 &&
                !part.equals("Samsung", ignoreCase = true) &&
                !part.equals("Galaxy", ignoreCase = true)
        }
        if (significant.size >= 2) {
            if (significant.all { hayLower.contains(it.lowercase()) }) return true
        }
        return false
    }
}
