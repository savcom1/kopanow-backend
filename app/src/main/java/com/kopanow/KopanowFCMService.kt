package com.kopanow

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * KopanowFCMService — Firebase Cloud Messaging integration.
 *
 * Receives push commands from the Kopanow backend and executes them immediately
 * on-device, providing near-real-time enforcement alongside the 24-hour heartbeat.
 *
 * ## Supported message types  (keyed on `data["type"]`)
 *
 * | Type                | Action                                                            |
 * |---------------------|-------------------------------------------------------------------|
 * | `LOCK_DEVICE`       | Lock screen + persist state + start [LockScreenActivity]          |
 * | `UNLOCK_DEVICE`     | Clear lock state + broadcast [ACTION_UNLOCK_SCREEN]               |
 * | `REMOVE_ADMIN`      | Notify backend → clear prefs → cancel heartbeat → remove admin   |
 * | `HEARTBEAT_REQUEST` | Run an immediate on-demand heartbeat via [HeartbeatWorker]        |
 *
 * ## Optional data payload keys (used by LOCK_DEVICE)
 * | Key           | Used for                             |
 * |---------------|--------------------------------------|
 * | `lock_reason` | Shown on LockScreenActivity          |
 * | `amount_due`  | Shown on LockScreenActivity          |
 *
 * `onNewToken` saves the refreshed FCM token to [KopanowPrefs] and pushes it
 * to the backend so push delivery is never lost.
 *
 * All coroutine work uses a [SupervisorJob] scoped to the service lifetime so
 * a failure in one handler can't crash the others.
 */
class KopanowFCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "KopanowFCMService"

        // ── FCM data payload keys ─────────────────────────────────────────

        /** Discriminator key present in every push message from the backend. */
        const val KEY_TYPE        = "type"

        /** Optional reason text for LOCK_DEVICE messages. */
        const val KEY_LOCK_REASON = "lock_reason"

        /** Optional amount due for LOCK_DEVICE messages. */
        const val KEY_AMOUNT_DUE  = "amount_due"

        /** Lock type: "TAMPER" hides pay button; "PAYMENT" shows it. Defaults to PAYMENT. */
        const val KEY_LOCK_TYPE   = "lock_type"

        // ── Message type values ───────────────────────────────────────────

        const val TYPE_LOCK_DEVICE       = "LOCK_DEVICE"
        const val TYPE_UNLOCK_DEVICE     = "UNLOCK_DEVICE"
        const val TYPE_REMOVE_ADMIN      = "REMOVE_ADMIN"
        const val TYPE_HEARTBEAT_REQUEST = "HEARTBEAT_REQUEST"
        const val TYPE_SET_SYSTEM_PIN    = "SET_SYSTEM_PIN"   // device generates PIN → sets on system lockscreen
        const val TYPE_CLEAR_SYSTEM_PIN  = "CLEAR_SYSTEM_PIN" // device clears the system lockscreen PIN

        // ── Local broadcasts ──────────────────────────────────────────────

        /**
         * Broadcast action sent when the device is remotely unlocked.
         * [LockScreenActivity] registers for this to dismiss itself instantly
         * without waiting for the next heartbeat cycle.
         */
        const val ACTION_UNLOCK_SCREEN = "com.kopanow.action.UNLOCK_SCREEN"
    }

    // CoroutineScope tied to the service; cancelled in onDestroy
    private val serviceJob   = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.IO + serviceJob)

    // ── Firebase lifecycle ────────────────────────────────────────────────

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    // ── Message received ──────────────────────────────────────────────────

    /**
     * Entry point for all FCM data messages.
     * Notification messages that arrive while the app is in the foreground
     * also pass through here if they carry a `data` map.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        val type = message.data[KEY_TYPE]
        Log.i(TAG, "onMessageReceived: type=$type from=${message.from}")

        if (!KopanowPrefs.hasSession) {
            Log.w(TAG, "No active session — ignoring FCM message type=$type")
            return
        }

        when (type) {
            TYPE_LOCK_DEVICE       -> handleLockDevice(message.data)
            TYPE_UNLOCK_DEVICE     -> handleUnlockDevice()
            TYPE_REMOVE_ADMIN      -> handleRemoveAdmin()
            TYPE_HEARTBEAT_REQUEST -> handleHeartbeatRequest()
            TYPE_SET_SYSTEM_PIN    -> FcmPinManager.handleSetSystemPin(this)
            TYPE_CLEAR_SYSTEM_PIN  -> FcmPinManager.handleClearSystemPin(this)
            null                   -> Log.w(TAG, "FCM message has no 'type' field — ignoring")
            else                   -> Log.w(TAG, "Unknown FCM type='$type' — ignoring")
        }
    }

    // ── Token refresh ─────────────────────────────────────────────────────

    /**
     * Called when the FCM registration token is refreshed (e.g., after app reinstall,
     * token rotation, or a new device restore).  We persist the new token locally and
     * push it to the backend so future pushes are delivered correctly.
     */
    override fun onNewToken(token: String) {
        Log.i(TAG, "onNewToken: FCM token refreshed")
        KopanowPrefs.fcmToken = token

        val borrowerId = KopanowPrefs.borrowerId ?: run {
            Log.w(TAG, "onNewToken: no borrowerId — token saved locally only")
            return
        }

        serviceScope.launch {
            val result = KopanowApi.updateFcmToken(borrowerId, token)
            if (result.success) {
                Log.i(TAG, "onNewToken: token updated on backend")
            } else {
                Log.e(TAG, "onNewToken: backend update failed — ${result.error}")
                // Non-critical: the next heartbeat will re-register the device
            }
        }
    }

    // ── Handlers ──────────────────────────────────────────────────────────

    /**
     * LOCK_DEVICE — immediately lock the screen and show [LockScreenActivity].
     *
     * Steps:
     *  1. Persist lock state + optional reason / amount to prefs.
     *  2. Call [DeviceSecurityManager.lockDevice] to engage the screen lock.
     *  3. Start [LockScreenActivity] as a new task so it shows above the lock screen.
     */
    private fun handleLockDevice(data: Map<String, String>) {
        val lockReason = data[KEY_LOCK_REASON]
        val amountDue  = data[KEY_AMOUNT_DUE]
        val lockType   = data[KEY_LOCK_TYPE] ?: KopanowPrefs.LOCK_TYPE_PAYMENT

        Log.w(TAG, "LOCK_DEVICE: reason=$lockReason amountDue=$amountDue lockType=$lockType")

        // 1. Persist state before locking so LockScreenActivity can read it on start
        KopanowPrefs.isLocked   = true
        KopanowPrefs.lockReason = lockReason
        KopanowPrefs.amountDue  = amountDue
        KopanowPrefs.lockType   = lockType   // TAMPER hides pay button

        // 2. Engage device admin screen lock
        val locked = DeviceSecurityManager.lockDevice(this)
        if (!locked) {
            Log.e(TAG, "LOCK_DEVICE: lockDevice() returned false (admin may not be active)")
        }

        // 3. Launch LockScreenActivity over the lock screen
        val lockIntent = Intent(this, LockScreenActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK          or  // required from non-activity context
                Intent.FLAG_ACTIVITY_SINGLE_TOP        or  // avoid stacking multiple instances
                Intent.FLAG_ACTIVITY_CLEAR_TOP
            )
        }
        startActivity(lockIntent)
        Log.i(TAG, "LOCK_DEVICE: LockScreenActivity launched")

        // 4. Start MDM Lite foreground watchdog — persistent lock loop
        KopanowLockService.start(this)
        Log.i(TAG, "LOCK_DEVICE: foreground watchdog started")

        acknowledgeStatus("locked")
    }

    /**
     * UNLOCK_DEVICE — release the screen lock and dismiss [LockScreenActivity].
     *
     * Steps:
     *  1. Clear lock state in prefs.
     *  2. Call [DeviceSecurityManager.unlockDevice] (clears prefs markers).
     *  3. Send a local broadcast so [LockScreenActivity] can finish() itself.
     */
    private fun handleUnlockDevice() {
        Log.i(TAG, "UNLOCK_DEVICE: releasing device lock")

        DeviceSecurityManager.unlockDevice(this)

        // Clear system PIN if one was set via SET_SYSTEM_PIN
        FcmPinManager.handleClearSystemPin(this)

        // Stop the MDM Lite foreground watchdog — device is now unlocked
        KopanowLockService.stop(this)
        Log.i(TAG, "UNLOCK_DEVICE: foreground watchdog stopped")

        // Broadcast so any running LockScreenActivity instance dismisses immediately
        val broadcast = Intent(ACTION_UNLOCK_SCREEN).apply {
            setPackage(packageName)
        }
        sendBroadcast(broadcast)
        Log.i(TAG, "UNLOCK_DEVICE: broadcast sent — action=$ACTION_UNLOCK_SCREEN")

        acknowledgeStatus("unlocked")
    }

    /**
     * REMOVE_ADMIN — graceful loan-closure flow:
     *  1. Notify backend the command was received.
     *  2. Clear all local prefs.
     *  3. Cancel the periodic heartbeat.
     *  4. Remove Kopanow as device administrator.
     */
    private fun handleRemoveAdmin() {
        Log.i(TAG, "REMOVE_ADMIN: initiating graceful admin removal")

        serviceScope.launch {
            val borrowerId = KopanowPrefs.borrowerId
            val loanId     = KopanowPrefs.loanId

            if (borrowerId != null && loanId != null) {
                KopanowApi.updateStatus(borrowerId, loanId, "admin_removed_by_fcm")
            }

            KopanowPrefs.clear()
            HeartbeatScheduler.cancel(this@KopanowFCMService)
            DeviceSecurityManager.removeDeviceAdmin(this@KopanowFCMService)

            Log.i(TAG, "REMOVE_ADMIN: prefs cleared, heartbeat cancelled, admin removed")
        }
    }

    /**
     * HEARTBEAT_REQUEST — backend requests an immediate telemetry snapshot.
     *
     * Schedules a one-shot expedited heartbeat via WorkManager so it survives
     * even if this service is killed before the coroutine finishes.
     */
    private fun handleHeartbeatRequest() {
        Log.i(TAG, "HEARTBEAT_REQUEST: scheduling immediate heartbeat")
        HeartbeatScheduler.scheduleImmediate(this)
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /** Fire-and-forget status update; failures are logged but don't block the handler. */
    private fun acknowledgeStatus(status: String) {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId     = KopanowPrefs.loanId     ?: return

        serviceScope.launch {
            val result = KopanowApi.updateStatus(borrowerId, loanId, status)
            if (!result.success) {
                Log.e(TAG, "acknowledgeStatus($status) failed: ${result.error}")
            }
        }
    }
}
