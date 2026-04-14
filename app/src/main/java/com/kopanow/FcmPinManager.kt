package com.kopanow

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * FcmPinManager — handles system-PIN FCM commands from the Kopanow backend.
 *
 * ## FCM commands handled
 *
 * | type              | payload keys  | action                                                      |
 * |-------------------|---------------|-------------------------------------------------------------|
 * | SET_SYSTEM_PIN    | —             | Device generates a random PIN, sets it on the REAL Android  |
 * |                   |               | system lockscreen via DPM.resetPasswordWithToken, locks now.|
 * |                   |               | PIN is reported back to the backend for admin to relay.     |
 * | CLEAR_SYSTEM_PIN  | —             | Removes the PIN from the system lockscreen via DPM.         |
 *
 * No custom UI is involved — the standard Android lockscreen enforces the PIN.
 *
 * @see SystemPinManager for the DPM implementation.
 */
object FcmPinManager {

    private const val TAG = "FcmPinManager"

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // FCM type strings (must mirror backend pin.js constants)
    const val TYPE_SET_SYSTEM_PIN   = "SET_SYSTEM_PIN"
    const val TYPE_CLEAR_SYSTEM_PIN = "CLEAR_SYSTEM_PIN"

    // ─────────────────────────────────────────────────────────────────────────
    // SET_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generate a random PIN and set it as the device's real system lockscreen password.
     *
     * 1. [SystemPinManager.activateSystemPin] — generates PIN, calls
     *    [DevicePolicyManager.resetPasswordWithToken], calls [DevicePolicyManager.lockNow].
     * 2. Reports the generated PIN to the backend (`POST /api/pin/report`) so the
     *    admin can read it to the borrower over the phone.
     *
     * The borrower enters the PIN on the STANDARD Android lockscreen.
     * No Kopanow custom UI appears.
     */
    fun handleSetSystemPin(context: Context) {
        Log.w(TAG, "handleSetSystemPin: activating system lockscreen PIN")

        val success = SystemPinManager.activateSystemPin(context) { pin ->
            // Report to backend in background
            reportPinToBackend(context, pin)
        }

        if (!success) {
            Log.e(TAG, "handleSetSystemPin: SystemPinManager.activateSystemPin failed")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLEAR_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Remove the Kopanow-set system PIN.
     *
     * Calls [SystemPinManager.clearSystemPin] which sets an empty password via
     * [DevicePolicyManager.resetPasswordWithToken].  The device returns to
     * having no lockscreen requirement.
     */
    fun handleClearSystemPin(context: Context) {
        Log.i(TAG, "handleClearSystemPin: clearing system lockscreen PIN")
        val success = SystemPinManager.clearSystemPin(context)
        if (success) {
            Log.i(TAG, "handleClearSystemPin: done ✓")
        } else {
            Log.e(TAG, "handleClearSystemPin: clearSystemPin failed")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Report generated PIN to backend
    // ─────────────────────────────────────────────────────────────────────────

    private fun reportPinToBackend(context: Context, pin: String) {
        val borrowerId = KopanowPrefs.borrowerId ?: run {
            Log.e(TAG, "reportPinToBackend: no borrower_id in prefs"); return
        }
        val loanId = KopanowPrefs.loanId ?: run {
            Log.e(TAG, "reportPinToBackend: no loan_id in prefs"); return
        }

        scope.launch {
            try {
                val result = KopanowApi.reportSystemPin(
                    borrowerId = borrowerId,
                    loanId     = loanId,
                    pin        = pin
                )
                if (result.success) {
                    SystemPinManager.clearPendingPin(context)
                    Log.i(TAG, "reportPinToBackend: PIN reported to backend ✓")
                } else {
                    Log.e(TAG, "reportPinToBackend: backend returned error — ${result.error}")
                    // PIN stays in local storage; HeartbeatWorker will retry
                }
            } catch (e: Exception) {
                Log.e(TAG, "reportPinToBackend: exception — ${e.message}")
            }
        }
    }
}
