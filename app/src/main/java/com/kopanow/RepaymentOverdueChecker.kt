package com.kopanow

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import java.time.Instant
import java.time.ZoneId

/**
 * If the device missed the exact alarm (power off), catch up when heartbeat/boot/main runs:
 * day after due @ 08:00 local has passed and invoice still unpaid → local PIN lock.
 *
 * **Offline paths:** [RepaymentAlarmReceiver] (exact alarm), [BootReceiver], [HeartbeatWorker]
 * (periodic work no longer requires network), [MainActivity] on launch and on resume.
 */
object RepaymentOverdueChecker {

    private const val TAG = "RepaymentOverdue"

    /**
     * Pure rule: unpaid invoice → enforce only after start of calendar day after due, 08:00 local.
     */
    internal fun shouldEnforceLocalPinNow(inv: LoanInvoiceItem, now: Instant, zone: ZoneId): Boolean {
        if (inv.status.equals("paid", ignoreCase = true)) return false
        val dueInstant = try {
            Instant.parse(inv.dueDate)
        } catch (_: Exception) {
            return false
        }
        val dueLocalDate = dueInstant.atZone(zone).toLocalDate()
        val pinNotBefore = dueLocalDate.plusDays(1).atTime(8, 0).atZone(zone).toInstant()
        return !now.isBefore(pinNotBefore)
    }

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
            if (!shouldEnforceLocalPinNow(inv, now, zone)) continue

            if (KopanowPrefs.localPinLockInvoiceNumber == inv.invoiceNumber) return

            Log.w(TAG, "Missed alarm path — enforcing PIN for invoice ${inv.invoiceNumber}")
            RepaymentPinEnforcer.engageLocalPinLock(context.applicationContext, inv.invoiceNumber)
            return
        }
    }
}
