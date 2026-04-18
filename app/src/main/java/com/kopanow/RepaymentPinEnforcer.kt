package com.kopanow

import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * Local passcode lock when an installment is unpaid the day after its due date (08:00 rule).
 * PIN is generated on-device and reported to the backend when online (same channel as FCM PIN).
 */
object RepaymentPinEnforcer {

    private const val TAG = "RepaymentPinEnforcer"

    fun engageLocalPinLock(context: Context, invoiceNumber: String) {
        val json = KopanowPrefs.repaymentInvoicesJson ?: return
        val inv = try {
            Gson().fromJson(json, Array<LoanInvoiceItem>::class.java)
                .firstOrNull { it.invoiceNumber == invoiceNumber }
        } catch (_: Exception) {
            null
        } ?: return

        if (inv.status.equals("paid", ignoreCase = true)) return
        if (KopanowPrefs.localPinLockInvoiceNumber == invoiceNumber) return

        val pin = (100_000 + SecureRandom().nextInt(900_000)).toString()
        PasscodeManager.setPasscode(context, pin)

        KopanowPrefs.isLocked = true
        KopanowPrefs.lockType = KopanowPrefs.LOCK_TYPE_PAYMENT
        KopanowPrefs.lockReason =
            context.getString(R.string.repayment_lock_reason_with_phone)
        KopanowPrefs.localPinLockInvoiceNumber = invoiceNumber

        DeviceSecurityManager.lockDevice(context)
        KopanowLockService.start(context)
        OverlayLockService.start(context)

        CoroutineScope(Dispatchers.IO).launch {
            val b = KopanowPrefs.borrowerId
            val l = KopanowPrefs.loanId
            if (b != null && l != null) {
                val r = KopanowApi.reportSystemPin(b, l, pin)
                if (r.success) Log.i(TAG, "PIN reported to backend for support unlock")
                else Log.e(TAG, "PIN report failed: ${r.error}")
            }
        }

        try {
            context.startActivity(
                Intent(context, LockScreenActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
            )
        } catch (e: Exception) {
            Log.e(TAG, "start LockScreenActivity: ${e.message}")
        }
    }
}
