package com.kopanow.contract

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToLong

private val TZ: ZoneId = ZoneId.of("Africa/Dar_es_Salaam")
private val SW = Locale("sw", "TZ")
private val DAY_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("d MMM yyyy", SW).withZone(TZ)

data class ScheduleRow(val weekIndex: Int, val dueDateLabel: String, val amountTzs: Long)

object ContractScheduleHelper {

    /** Equal weekly amounts; last installment absorbs rounding (matches backend loan_invoices). */
    fun buildWeeklyRows(
        loanStartIso: String,
        totalRepaymentTzs: Long,
        numWeeks: Int,
    ): List<ScheduleRow> {
        if (numWeeks <= 0 || totalRepaymentTzs <= 0) return emptyList()
        val startInstant = runCatching { Instant.parse(loanStartIso.trim()) }.getOrElse { Instant.now() }
        val zStart = startInstant.atZone(TZ)
        val weekly = (totalRepaymentTzs.toDouble() / numWeeks).roundToLong()
        val rows = ArrayList<ScheduleRow>(numWeeks)
        var accrued = 0L
        for (i in 1..numWeeks) {
            val due = zStart.plusWeeks(i.toLong())
            val amt = if (i == numWeeks) totalRepaymentTzs - accrued else weekly
            accrued += amt
            rows += ScheduleRow(weekIndex = i, dueDateLabel = DAY_FMT.format(due), amountTzs = amt)
        }
        return rows
    }
}
