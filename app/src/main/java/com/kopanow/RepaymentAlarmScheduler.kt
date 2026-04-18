package com.kopanow

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.gson.Gson
import java.time.Instant
import java.time.ZoneId

/**
 * Schedules **local** (offline) alarms for weekly repayment reminders and
 * day-after-due PIN enforcement. Rescheduled on boot from cached invoice JSON.
 */
object RepaymentAlarmScheduler {

    private const val TAG = "RepaymentAlarms"

    const val ACTION = "com.kopanow.action.REPAYMENT_LOCAL_ALARM"
    const val EXTRA_PHASE = "phase"
    const val EXTRA_INVOICE = "invoice_number"
    const val EXTRA_AMOUNT = "amount_due"

    private fun requestCode(invoiceNumber: String, phaseIdx: Int): Int =
        910_000 + ((invoiceNumber.hashCode() and 0x7fff) * 4 + phaseIdx)

    fun cancelAll(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val codes = KopanowPrefs.repaymentAlarmRequestCodes
            ?.split(',')
            ?.mapNotNull { it.trim().toIntOrNull() }
            .orEmpty()
        val app = context.applicationContext
        for (code in codes) {
            val pi = PendingIntent.getBroadcast(
                app,
                code,
                Intent(ACTION).setClass(app, RepaymentAlarmReceiver::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            am.cancel(pi)
            pi.cancel()
        }
        KopanowPrefs.repaymentAlarmRequestCodes = null
        Log.i(TAG, "cancelAll: cleared ${codes.size} alarms")
    }

    fun schedule(context: Context, invoices: List<LoanInvoiceItem>?) {
        val app = context.applicationContext
        if (invoices == null) {
            // Heartbeat omitted invoices (older API) — keep existing cache and alarms
            return
        }
        if (invoices.isEmpty()) {
            cancelAll(app)
            KopanowPrefs.repaymentInvoicesJson = null
            return
        }

        cancelAll(app)
        KopanowPrefs.repaymentInvoicesJson = Gson().toJson(invoices)

        val zone = ZoneId.systemDefault()
        val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val newCodes = ArrayList<Int>()

        for (inv in invoices) {
            if (inv.status.equals("paid", ignoreCase = true)) continue

            val dueInstant = try {
                Instant.parse(inv.dueDate)
            } catch (e: Exception) {
                Log.e(TAG, "skip invoice ${inv.invoiceNumber}: bad due_date=${inv.dueDate}", e)
                continue
            }
            val dueLocalDate = dueInstant.atZone(zone).toLocalDate()

            val phases = listOf(
                0 to dueLocalDate.minusDays(3),
                1 to dueLocalDate.minusDays(1),
                2 to dueLocalDate,
                3 to dueLocalDate.plusDays(1)
            )

            for ((phaseIdx, day) in phases) {
                val atMillis = day.atTime(8, 0).atZone(zone).toInstant().toEpochMilli()
                if (atMillis <= System.currentTimeMillis()) continue

                val req = requestCode(inv.invoiceNumber, phaseIdx)
                val intent = Intent(ACTION).setClass(app, RepaymentAlarmReceiver::class.java).apply {
                    putExtra(EXTRA_PHASE, phaseIdx)
                    putExtra(EXTRA_INVOICE, inv.invoiceNumber)
                    putExtra(EXTRA_AMOUNT, inv.amountDue)
                }
                val pi = PendingIntent.getBroadcast(
                    app,
                    req,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
                newCodes.add(req)
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
                    } else {
                        @Suppress("DEPRECATION")
                        am.setExact(AlarmManager.RTC_WAKEUP, atMillis, pi)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "setExact failed req=$req", e)
                }
            }
        }

        KopanowPrefs.repaymentAlarmRequestCodes = newCodes.distinct().joinToString(",")
        Log.i(TAG, "scheduled ${newCodes.size} local repayment alarms")
    }

    fun rescheduleFromPrefs(context: Context) {
        val json = KopanowPrefs.repaymentInvoicesJson ?: return
        val arr = try {
            Gson().fromJson(json, Array<LoanInvoiceItem>::class.java)
        } catch (_: Exception) {
            null
        } ?: return
        schedule(context.applicationContext, arr.toList())
    }
}
