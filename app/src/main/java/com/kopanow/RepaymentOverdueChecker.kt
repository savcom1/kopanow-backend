package com.kopanow

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import java.time.Instant
import java.time.ZoneId

/**
 * If the device missed the exact alarm (power off), catch up when heartbeat/boot runs:
 * day after due @ 08:00 local has passed and invoice still unpaid → local PIN lock.
 */
object RepaymentOverdueChecker {

    private const val TAG = "RepaymentOverdue"

    fun checkAndEnforce(context: Context) {
        if (!KopanowPrefs.hasSession) return
        val json = KopanowPrefs.repaymentInvoicesJson ?: return
        val invoices = try {
            Gson().fromJson(json, Array<LoanInvoiceItem>::class.java)?.toList().orEmpty()
        } catch (_: Exception) {
            emptyList()
        }
        if (invoices.isEmpty()) return

        val zone = ZoneId.systemDefault()
        val now = Instant.now()

        for (inv in invoices) {
            if (inv.status.equals("paid", ignoreCase = true)) continue
            val dueInstant = try {
                Instant.parse(inv.dueDate)
            } catch (_: Exception) {
                continue
            }
            val dueLocalDate = dueInstant.atZone(zone).toLocalDate()
            val pinNotBefore = dueLocalDate.plusDays(1).atTime(8, 0).atZone(zone).toInstant()
            if (now.isBefore(pinNotBefore)) continue

            if (KopanowPrefs.localPinLockInvoiceNumber == inv.invoiceNumber) return

            Log.w(TAG, "Missed alarm path — enforcing PIN for invoice ${inv.invoiceNumber}")
            RepaymentPinEnforcer.engageLocalPinLock(context.applicationContext, inv.invoiceNumber)
            return
        }
    }
}
