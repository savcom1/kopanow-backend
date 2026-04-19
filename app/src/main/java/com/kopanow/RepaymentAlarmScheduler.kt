package com.kopanow

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
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
    /** Avoid cancel/recreate storms when user rapidly switches activities. */
    private const val RESCHEDULE_MIN_INTERVAL_MS = 30_000L

    @Volatile
    private var lastRescheduleElapsed: Long = 0L

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
                scheduleOneAlarm(am, atMillis, pi, req)
            }
        }

        KopanowPrefs.repaymentAlarmRequestCodes = newCodes.distinct().joinToString(",")
        Log.i(TAG, "scheduled ${newCodes.size} local repayment alarms")
    }

    /**
     * Rebuild alarms from cached invoice JSON (e.g. after reboot, app resume). Throttled so rapid
     * activity switches do not thrash AlarmManager.
     */
    fun rescheduleFromPrefsThrottled(context: Context) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastRescheduleElapsed < RESCHEDULE_MIN_INTERVAL_MS) return
        lastRescheduleElapsed = now
        rescheduleFromPrefs(context)
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

    /**
     * Prefer exact while-idle alarms; fall back when [AlarmManager.canScheduleExactAlarms] is false
     * (API 31+) or [SecurityException] (revoked SCHEDULE_EXACT_ALARM). PIN/overdue catch-up still runs
     * via [RepaymentOverdueChecker] if alarms drift.
     */
    private fun scheduleOneAlarm(am: AlarmManager, atMillis: Long, pi: PendingIntent, req: Int) {
        try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> {
                    val useExact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        am.canScheduleExactAlarms()
                    } else {
                        true
                    }
                    if (useExact) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
                    } else {
                        Log.w(TAG, "Exact alarms not allowed (req=$req) — using setAndAllowWhileIdle")
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
                    }
                }
                else -> {
                    @Suppress("DEPRECATION")
                    am.setExact(AlarmManager.RTC_WAKEUP, atMillis, pi)
                }
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Exact alarm denied (req=$req) — fallback inexact while-idle", e)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
                } else {
                    @Suppress("DEPRECATION")
                    am.set(AlarmManager.RTC_WAKEUP, atMillis, pi)
                }
            } catch (e2: Exception) {
                Log.e(TAG, "Fallback alarm schedule failed req=$req", e2)
            }
        } catch (e: Exception) {
            Log.e(TAG, "schedule alarm failed req=$req", e)
        }
    }
}
