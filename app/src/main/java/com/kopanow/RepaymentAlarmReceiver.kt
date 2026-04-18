package com.kopanow

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.gson.Gson

/**
 * Fires local repayment reminders (3d / 1d / due) and day-after PIN lock — no network required.
 */
class RepaymentAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != RepaymentAlarmScheduler.ACTION) return

        val phase = intent.getIntExtra(RepaymentAlarmScheduler.EXTRA_PHASE, -1)
        val invoiceNumber = intent.getStringExtra(RepaymentAlarmScheduler.EXTRA_INVOICE) ?: return
        val amount = intent.getDoubleExtra(RepaymentAlarmScheduler.EXTRA_AMOUNT, 0.0)

        KopanowPrefs.init(context.applicationContext)

        // Invoice may have been paid since scheduling — re-check cache
        val inv = findInvoice(invoiceNumber) ?: return
        if (inv.status.equals("paid", ignoreCase = true)) {
            Log.i(TAG, "invoice $invoiceNumber already paid — skip")
            return
        }

        when (phase) {
            0 -> showNotif(context, 9201 + invoiceNumber.hashCode() % 50,
                titleSwEn(
                    "Ukumbusho wa malipo",
                    "Repayment reminder"
                ),
                bodySwEn(
                    "Siku 3 zimebaki hadi siku yako ya rejesho (TSh ${fmt(amount)}).",
                    "3 days remaining until your repayment day (TSh ${fmt(amount)})."
                )
            )
            1 -> showNotif(context, 9202 + invoiceNumber.hashCode() % 50,
                titleSwEn("Malipo", "Repayment"),
                bodySwEn(
                    "Kesho ni siku yako ya rejesho (TSh ${fmt(amount)}).",
                    "Tomorrow is your repayment day (TSh ${fmt(amount)})."
                )
            )
            2 -> showNotif(context, 9203 + invoiceNumber.hashCode() % 50,
                titleSwEn("Malipo leo", "Due today"),
                bodySwEn(
                    "Leo ni siku yako ya rejesho (TSh ${fmt(amount)}).",
                    "Today is your repayment day (TSh ${fmt(amount)})."
                )
            )
            3 -> {
                Log.w(TAG, "PIN lock phase for $invoiceNumber")
                RepaymentPinEnforcer.engageLocalPinLock(context.applicationContext, invoiceNumber)
            }
            else -> Log.w(TAG, "unknown phase=$phase")
        }
    }

    private fun findInvoice(invoiceNumber: String): LoanInvoiceItem? {
        val json = KopanowPrefs.repaymentInvoicesJson ?: return null
        return try {
            Gson().fromJson(json, Array<LoanInvoiceItem>::class.java)
                .firstOrNull { it.invoiceNumber == invoiceNumber }
        } catch (_: Exception) {
            null
        }
    }

    private fun fmt(a: Double) = java.text.NumberFormat.getIntegerInstance().format(a.toLong())

    private fun titleSwEn(sw: String, en: String) =
        if (java.util.Locale.getDefault().language.startsWith("sw")) sw else en

    private fun bodySwEn(sw: String, en: String) = titleSwEn(sw, en)

    private fun showNotif(context: Context, id: Int, title: String, text: String) {
        val pi = android.app.PendingIntent.getActivity(
            context, id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
        )
        val textWithSupport = text + context.getString(R.string.support_notif_suffix)
        KopanowNotifications.showRepaymentReminder(context, id, title, textWithSupport, pi)
    }

    companion object {
        private const val TAG = "RepaymentAlarmRcvr"
    }
}
