package com.kopanow

import android.content.Context
import androidx.annotation.VisibleForTesting
import com.google.gson.Gson

/**
 * Loads [device_mkopo.json] from assets once per process.
 */
object DeviceMkopoCatalog {

    @Volatile
    private var cached: List<DeviceMkopoEntry>? = null

    fun getEntries(context: Context): List<DeviceMkopoEntry> {
        cached?.let { return it }
        return synchronized(this) {
            cached?.let { return it }
            val json = context.assets.open("device_mkopo.json").bufferedReader(Charsets.UTF_8).use { it.readText() }
            val root = Gson().fromJson(json, DeviceMkopoAsset::class.java)
            val list = root.entries.toMutableList()

            // Hotfix overrides: ensure newer MKOPO mappings exist even if an old asset ships.
            fun upsert(entry: DeviceMkopoEntry) {
                val exists = list.any { it.brand.equals(entry.brand, ignoreCase = true) && it.model.equals(entry.model, ignoreCase = true) }
                if (!exists) list.add(entry)
            }

            upsert(
                DeviceMkopoEntry(
                    brand = "Samsung",
                    model = "Galaxy A06",
                    mkopoTzs = 20000,
                    series = "Galaxy A"
                )
            )
            upsert(
                DeviceMkopoEntry(
                    brand = "Samsung",
                    model = "Galaxy A05 (SM-A055F)",
                    mkopoTzs = 20000,
                    series = "Galaxy A",
                    patterns = listOf("SM-A055F")
                )
            )

            // Ensure overrides participate in matching and series sorting.
            list.sortWith(compareBy<DeviceMkopoEntry>({ it.brand }, { it.series }, { it.model }))
            cached = list
            list
        }
    }

    @VisibleForTesting
    fun clearCacheForTests() {
        cached = null
    }
}
