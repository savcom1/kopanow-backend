package com.kopanow

import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * FcmPinManager — handles SET_SYSTEM_PIN / CLEAR_SYSTEM_PIN FCM commands.
 *
 * ## Why the old code failed
 * The previous implementation only reported the PIN to the backend INSIDE the
 * [SystemPinManager.activateSystemPin] callback, which is only invoked when
 * [DevicePolicyManager.resetPasswordWithToken] succeeds — and that API requires
 * Device Owner.  On Device Admin-only devices the callback was never called, so
 * the admin panel always timed out ("device did not report PIN within 45 s").
 *
 * ## New flow (works on Device Admin AND Device Owner)
 *
 *  1. Generate PIN immediately
 *  2. Set app-level passcode (PasscodeManager) — works with Device Admin alone
 *  3. Lock screen via DPM.lockNow() — works with Device Admin alone
 *  4. Show LockScreenActivity with PIN keypad — always enforced by the app
 *  5. BONUS: attempt to also set the real system lockscreen PIN (Device Owner only)
 *  6. Report PIN to backend — ALWAYS, regardless of step 5 result
 *
 * This means:
 *  - Device Admin only  → in-app PIN keypad enforces access, admin gets PIN ✓
 *  - Device Owner       → real system lockscreen ALSO requires PIN (deeper) ✓
 */
object FcmPinManager {

    private const val TAG = "FcmPinManager"

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // ── Broadcast constants — LockScreenActivity subscribes to these ──────────
    const val ACTION_PASSCODE_CHANGED = "com.kopanow.action.PASSCODE_CHANGED"
    const val EXTRA_PASSCODE_ACTIVE   = "passcode_active"   // Boolean extra

    // ─────────────────────────────────────────────────────────────────────────
    // SET_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    fun handleSetSystemPin(context: Context) {
        Log.w(TAG, "handleSetSystemPin: starting PIN lock flow")

        // ── 1. Generate a random 6-digit PIN immediately ──────────────────────
        val pin = SystemPinManager.generatePin()
        Log.i(TAG, "handleSetSystemPin: PIN generated (not logged for security)")

        // Store as pending so HeartbeatWorker can retry the backend report
        // if the network call below fails on first attempt
        SystemPinManager.storePendingPin(context, pin)

        // ── 2. Set app-level passcode — works with Device Admin alone ─────────
        PasscodeManager.setPasscode(context, pin)

        // ── 3. Lock screen immediately via DPM.lockNow() ─────────────────────
        //    Works with Device Admin. Does NOT set a real PIN — that's step 5.
        DeviceSecurityManager.lockDevice(context)

        // ── 4. Broadcast → LockScreenActivity shows PIN keypad ────────────────
        sendPasscodeBroadcast(context, active = true)

        // ── 5. Launch LockScreenActivity with PIN keypad ──────────────────────
        context.startActivity(
            Intent(context, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
                         Intent.FLAG_ACTIVITY_SINGLE_TOP or
                         Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
        )

        // ── 6. BONUS: real system lockscreen PIN (Device Owner only) ──────────
        //    If the device is Device Owner with an active reset token, this also
        //    sets the real Android lockscreen PIN to the same value.  If it fails
        //    (no DO, token not active) the app-level keypad is still the lock.
        val systemPinSet = SystemPinManager.activateWithPin(context, pin)
        Log.i(TAG, "handleSetSystemPin: system lockscreen PIN set=$systemPinSet " +
                "(DO=${SystemPinManager.isDeviceOwner(context)})")

        // ── 7. Report PIN to backend — ALWAYS, regardless of step 6 ──────────
        //    This is why the admin panel was timing out before: the report only
        //    fired when step 6 succeeded.  Now it always fires.
        reportPinToBackend(context, pin)

        // ── 8. Start MDM Lite foreground watchdog — persistent lock loop ──────
        KopanowLockService.start(context)

        Log.i(TAG, "handleSetSystemPin: lock flow complete ✓ " +
                "(app-keypad=true, systemPin=$systemPinSet)")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLEAR_SYSTEM_PIN
    // ─────────────────────────────────────────────────────────────────────────

    fun handleClearSystemPin(context: Context) {
        Log.i(TAG, "handleClearSystemPin: clearing all PIN locks")

        val appCtx = context.applicationContext

        val sysOk = SystemPinManager.clearSystemPin(appCtx)
        Log.i(TAG, "handleClearSystemPin: system PIN cleared=$sysOk")

        PasscodeManager.clearPasscode(appCtx)
        SystemPinManager.clearPendingPin(appCtx)
        sendPasscodeBroadcast(appCtx, active = false)

        // Release payment/tamper lock prefs + overlay (matches UNLOCK_DEVICE teardown)
        DeviceSecurityManager.unlockDevice(appCtx)

        KopanowLockService.stop(appCtx)
        OverlayLockService.stop(appCtx)

        val unlock = Intent(KopanowFCMService.ACTION_UNLOCK_SCREEN).apply { setPackage(appCtx.packageName) }
        appCtx.sendBroadcast(unlock)

        Log.i(TAG, "handleClearSystemPin: done ✓")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Report PIN to backend
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
                val result = KopanowApi.reportSystemPin(borrowerId, loanId, pin)
                if (result.success) {
                    SystemPinManager.clearPendingPin(context)
                    Log.i(TAG, "reportPinToBackend: PIN reported to backend ✓")
                } else {
                    Log.e(TAG, "reportPinToBackend: backend error — ${result.error}. " +
                            "PIN kept in pending storage; HeartbeatWorker will retry.")
                }
            } catch (e: Exception) {
                Log.e(TAG, "reportPinToBackend: exception — ${e.message}. Will retry on next heartbeat.")
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
