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
            val list = root.entries
            cached = list
            list
        }
    }

    @VisibleForTesting
    fun clearCacheForTests() {
        cached = null
    }
}
