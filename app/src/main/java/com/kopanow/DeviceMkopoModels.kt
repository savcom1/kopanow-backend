package com.kopanow

import androidx.annotation.Keep

@Keep
data class DeviceMkopoAsset(
    val version: Int,
    val entries: List<DeviceMkopoEntry>
)

@Keep
data class DeviceMkopoEntry(
    val brand: String,
    val model: String,
    val mkopoTzs: Long,
    val series: String,
    val patterns: List<String>? = null
)
