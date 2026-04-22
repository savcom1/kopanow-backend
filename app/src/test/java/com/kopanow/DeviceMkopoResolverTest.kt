package com.kopanow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceMkopoResolverTest {

    @Test
    fun roundToNearest1000_positiveHalfUp() {
        assertEquals(72000L, DeviceMkopoResolver.roundToNearest1000(72000L))
        assertEquals(22000L, DeviceMkopoResolver.roundToNearest1000(21500L))
        assertEquals(216000L, DeviceMkopoResolver.roundToNearest1000(215500L))
        assertEquals(0L, DeviceMkopoResolver.roundToNearest1000(0L))
    }

    @Test
    fun entryMatchesBuild_googlePixelSubstring() {
        val e = DeviceMkopoEntry("Google", "Pixel 8", 32000L, "Pixel", null)
        assertTrue(DeviceMkopoResolver.entryMatchesBuild(e, "google pixel 8".lowercase()))
    }

    @Test
    fun entryMatchesBuild_samsungGalaxyTokens() {
        val e = DeviceMkopoEntry("Samsung", "Galaxy A14", 8000L, "Galaxy A", null)
        assertTrue(DeviceMkopoResolver.entryMatchesBuild(e, "samsung sm-a145f a14".lowercase()))
    }

    @Test
    fun resolveCanonicalBrands_samsung() {
        val list = DeviceMkopoResolver.resolveCanonicalBrands("samsung", "samsung", "SM-A145F")
        assertEquals(listOf("Samsung"), list)
    }

    @Test
    fun resolveCanonicalBrands_samsungFromSmModelEvenIfBrandUnknown() {
        val list = DeviceMkopoResolver.resolveCanonicalBrands("", "", "SM-A145F")
        assertEquals(listOf("Samsung"), list)
    }

    @Test
    fun canonicalizeDeviceModel_groupsSamsungA05Variants() {
        assertEquals(
            "Samsung A05",
            DeviceMkopoResolver.canonicalizeDeviceModel("", "", "SM-A0556")
        )
        assertEquals(
            "Samsung A05",
            DeviceMkopoResolver.canonicalizeDeviceModel("", "", "SM-A0567")
        )
    }

    @Test
    fun resolveCanonicalBrands_xiaomiRedmi() {
        val list = DeviceMkopoResolver.resolveCanonicalBrands("Xiaomi", "Redmi", "Redmi Note 10")
        assertTrue(list.contains("Xiaomi"))
    }

    @Test
    fun suggestFromBuild_ambiguousPicksLowerMkopo() {
        val entries = listOf(
            DeviceMkopoEntry("Samsung", "Galaxy A14", 25000L, "Galaxy A", patterns = listOf("SM-A145")),
            DeviceMkopoEntry("Samsung", "Galaxy A14 5G", 26000L, "Galaxy A", patterns = listOf("SM-A145"))
        )

        val s = DeviceMkopoResolver.suggestFromBuildEntries(entries, "", "", "SM-A145F", "")!!
        assertEquals(25000L, s.amountTzsRounded)
    }

    @Test
    fun suggestFromBuild_unknownSamsungModelFallsBackToMinSamsung() {
        val entries = listOf(
            DeviceMkopoEntry("Samsung", "Galaxy A03", 8000L, "Galaxy A", patterns = listOf("SM-A035")),
            DeviceMkopoEntry("Samsung", "Galaxy S25 Ultra", 72000L, "Galaxy S", patterns = listOf("SM-S938"))
        )

        val s = DeviceMkopoResolver.suggestFromBuildEntries(entries, "", "", "SM-XYZ999", "")!!
        assertEquals(8000L, s.amountTzsRounded)
        assertTrue(s.label.contains("default", ignoreCase = true))
    }

    @Test
    fun formatLine_containsModelAndAmount() {
        val e = DeviceMkopoEntry("Samsung", "Galaxy S25 Ultra", 72000L, "Galaxy S", null)
        val line = DeviceMkopoResolver.formatLine(e, "72,000 TZS")
        assertTrue(line.contains("Galaxy S25 Ultra"))
        assertTrue(line.contains("72,000 TZS"))
    }
}
