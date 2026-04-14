package com.kopanow

import android.content.Context
import android.content.Intent
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
 * | type              | action                                                              |
 * |-------------------|---------------------------------------------------------------------|
 * | SET_SYSTEM_PIN    | Device generates a random PIN via [SystemPinManager]:               |
 * |                   |  1. Sets PIN on real Android system lockscreen (DPM.resetPasswordWithToken) |
 * |                   |  2. Also stores PIN hash in [PasscodeManager] so the in-app keypad  |
 * |                   |     can accept it as a secondary verification.                       |
 * |                   |  3. Broadcasts [ACTION_PASSCODE_CHANGED] so [LockScreenActivity]    |
 * |                   |     switches to PIN keypad mode.                                     |
 * |                   |  4. PIN reported to backend for admin to relay to borrower.          |
 * | CLEAR_SYSTEM_PIN  | Clears both the real system lockscreen PIN and the app-level passcode|
 *
 * Both layers work in sync: the borrower can unlock via either the real Android
 * lockscreen OR the in-app PIN keypad — whichever they see first.
 */
object FcmPinManager {

    private const val TAG = "FcmPinManager"

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // ── Broadcast action — LockScreenActivity subscribes to this ─────────────
    /** Broadcast sent when the PIN mode changes so LockScreenActivity can refresh its UI. */
    const val ACTION_PASSCODE_CHANGED = "com.kopanow.action.PASSCODE_CHANGED"
    const val EXTRA_PASSCODE_ACTIVE   = "passcode_active"   // Boolean

    // ── FCM type strings (must mirror KopanowFCMService + backend) ────────────
    const val TYPE_SET_SYSTEM_PIN   = "SET_SYSTEM_PIN"
    const val TYPE_CLEAR_SYSTEM_PIN = "CLEAR_SYSTEM_PIN"

    // ─────────────────────────────────────────────────────────────────────────
    // SET_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Activate system PIN lock on this device.
     *
     * Steps:
     *  1. [SystemPinManager.activateSystemPin]:
     *       - Generates a cryptographically random 6-digit PIN via SecureRandom
     *       - Sets it on the real Android lockscreen via DPM.resetPasswordWithToken()
     *       - Calls DPM.lockNow() — real lockscreen activates immediately
     *  2. Sets the same PIN in [PasscodeManager] so the in-app keypad also works
     *  3. Broadcasts [ACTION_PASSCODE_CHANGED] → LockScreenActivity shows PIN keypad
     *  4. Launches LockScreenActivity so it appears on top
     *  5. Reports the generated PIN to the backend (POST /api/pin/report) so the
     *     admin can read it to the borrower over the phone.
     */
    fun handleSetSystemPin(context: Context) {
        Log.w(TAG, "handleSetSystemPin: activating system lockscreen PIN")

        val success = SystemPinManager.activateSystemPin(context) { pin ->
            // ── Sync app-level passcode to the same PIN ──────────────────────
            // This means the borrower can enter the PIN at either:
            //  a) the REAL Android lock screen (set above via DPM), OR
            //  b) the in-app PIN keypad inside LockScreenActivity
            PasscodeManager.setPasscode(context, pin)
            Log.i(TAG, "handleSetSystemPin: app-level passcode synced to system PIN")

            // ── Report PIN to backend ─────────────────────────────────────────
            reportPinToBackend(context, pin)

            // ── Notify LockScreenActivity to switch to PIN keypad mode ────────
            sendPasscodeBroadcast(context, active = true)

            // ── Launch LockScreenActivity with PIN keypad ─────────────────────
            val intent = Intent(context, LockScreenActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK   or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
            }
            context.startActivity(intent)
            Log.i(TAG, "handleSetSystemPin: system PIN active, LockScreenActivity launched")
        }

        if (!success) {
            Log.e(TAG, "handleSetSystemPin: SystemPinManager.activateSystemPin failed — " +
                    "check if DPM token is active (device must unlock once after enrollment)")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLEAR_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Remove the PIN from both the real system lockscreen and the in-app passcode.
     *
     * Steps:
     *  1. [SystemPinManager.clearSystemPin] — sets empty password via DPM.resetPasswordWithToken()
     *  2. [PasscodeManager.clearPasscode] — clears the in-app PIN hash
     *  3. Broadcasts [ACTION_PASSCODE_CHANGED] → LockScreenActivity hides PIN keypad
     */
    fun handleClearSystemPin(context: Context) {
        Log.i(TAG, "handleClearSystemPin: clearing system + app-level PIN")

        // 1. Clear real system lockscreen PIN
        val sysOk = SystemPinManager.clearSystemPin(context)
        Log.i(TAG, "handleClearSystemPin: system PIN cleared=${sysOk}")

        // 2. Clear app-level passcode so keypad no longer shows
        PasscodeManager.clearPasscode(context)

        // 3. Notify LockScreenActivity to hide PIN keypad
        sendPasscodeBroadcast(context, active = false)

        Log.i(TAG, "handleClearSystemPin: done ✓")
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
                    Log.e(TAG, "reportPinToBackend: backend error — ${result.error}")
                    // PIN stays in SystemPinManager local storage; HeartbeatWorker will retry
                }
            } catch (e: Exception) {
                Log.e(TAG, "reportPinToBackend: exception — ${e.message}")
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private fun sendPasscodeBroadcast(context: Context, active: Boolean) {
        val broadcast = Intent(ACTION_PASSCODE_CHANGED).apply {
            setPackage(context.packageName)
            putExtra(EXTRA_PASSCODE_ACTIVE, active)
        }
        context.sendBroadcast(broadcast)
    }
}
