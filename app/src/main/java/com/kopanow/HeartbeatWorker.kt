package com.kopanow

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.util.Log
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HeartbeatWorker — 24-hour periodic WorkManager worker.
 *
 * Every 24 hours this worker POSTs a device telemetry snapshot to the backend
 * so the server can:
 *  • Confirm the device is still under MDM control (`dpc_active`)
 *  • Detect Scenario 3 abuse: safe-mode boot, device-ID mismatch
 *  • Decide whether to issue a LOCK, UNLOCK, or REMOVE_ADMIN command
 *
 * ## Telemetry payload sent
 * | Field        | Description                                               |
 * |--------------|-----------------------------------------------------------|
 * | device_id    | Stable ANDROID_ID / fingerprint hash (Scenario 3 check)  |
 * | dpc_active   | Whether Kopanow is still an active device administrator   |
 * | is_safe_mode | Whether the device is in safe mode (tamper signal)        |
 * | battery_pct  | Battery level 0-100                                       |
 * | timestamp    | Epoch millis of this heartbeat                            |
 *
 * ## Backend action responses
 * | Action         | Worker behaviour                                          |
 * |----------------|-----------------------------------------------------------|
 * | `LOCK`         | Lock screen + persist lock state                          |
 * | `UNLOCK`       | Clear lock state + stop LockScreenActivity                |
 * | `REMOVE_ADMIN` | Self-remove device admin (loan closed / repaid in full)   |
 * | null / missing | No change; sync `isLocked` locally                       |
 *
 * Scheduling lives in [HeartbeatScheduler] (24 h periodic, CANCEL_AND_REENQUEUE
 * on update so the interval resets cleanly after a reboot).
 */
class HeartbeatWorker(
    private val context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "HeartbeatWorker"

        /** Unique periodic-work chain name used with enqueueUniquePeriodicWork. */
        const val UNIQUE_WORK_NAME = "kopanow_heartbeat"

        // Backend action constants (matched against HeartbeatResponse.action)
        const val ACTION_LOCK         = "LOCK"
        const val ACTION_UNLOCK       = "UNLOCK"
        const val ACTION_REMOVE_ADMIN = "REMOVE_ADMIN"

        // Notification channel used when promoted to foreground service (EXPEDITED on API < 12)
        private const val CHANNEL_ID      = "kopanow_heartbeat_channel"
        private const val NOTIFICATION_ID = 9003
    }

    // ── Foreground promotion (required for EXPEDITED on Android < 12) ─────

    override suspend fun getForegroundInfo(): ForegroundInfo {
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Kopanow Security")
            .setContentText("Running scheduled device check…")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    // ── Main work ─────────────────────────────────────────────────────────

    override suspend fun doWork(): Result {
        Log.i(TAG, "doWork: heartbeat attempt ${runAttemptCount + 1}")

        val borrowerId = KopanowPrefs.borrowerId
        val loanId     = KopanowPrefs.loanId
        if (borrowerId == null || loanId == null) {
            Log.w(TAG, "No active session — skipping heartbeat")
            return Result.success()     // not a failure; device may not be enrolled
        }

        // Local overdue PIN lock — must not depend on network (see HeartbeatScheduler constraints).
        RepaymentOverdueChecker.checkAndEnforce(context.applicationContext)

        // ── System PIN token maintenance ───────────────────────────────────
        // resetPasswordWithToken() requires Device Owner — skip if DA-only.
        if (SystemPinManager.isDeviceOwner(context)) {
            if (!SystemPinManager.hasToken(context)) {
                val ok = SystemPinManager.initResetToken(context)
                Log.d(TAG, "Token init (no prior token): ${if (ok) "✓" else "FAILED"}")
            } else if (!SystemPinManager.isTokenActive(context)) {
                Log.d(TAG, "Reset token exists but not yet active — awaiting first user unlock")
            } else {
                Log.d(TAG, "Reset token active ✓ — system PIN commands ready")
            }
            // Retry any pending PIN report if previous POST failed
            val pendingPin = SystemPinManager.getPendingPin(context)
            if (pendingPin != null) {
                Log.w(TAG, "Retrying unreported system PIN...")
                val pinResult = KopanowApi.reportSystemPin(borrowerId, loanId, pendingPin)
                if (pinResult.success) { SystemPinManager.clearPendingPin(context); Log.i(TAG, "Pending PIN reported ✓") }
                else Log.e(TAG, "Pending PIN retry failed: ${pinResult.error}")
            }
        } else {
            Log.w(TAG, "NOT Device Owner — system PIN unavailable. " +
                    "Run: adb shell dpm set-device-owner com.kopanow/.KopanowAdminReceiver")
        }

        // ── Collect telemetry ─────────────────────────────────────────────
        val deviceId      = DeviceSecurityManager.getDeviceId(context)
        val dpcActive     = DeviceSecurityManager.isAdminActive(context)
        val isDeviceOwner = SystemPinManager.isDeviceOwner(context)
        val safeMode      = isSafeMode()
        val battery       = getBatteryPercent()

        Log.d(TAG, "Telemetry — device=$deviceId dpc=$dpcActive DO=$isDeviceOwner safeMode=$safeMode battery=${battery}%")

        // If admin has been silently removed (user bypassed removal flow),
        // fire an additional expedited tamper report alongside the heartbeat
        if (!dpcActive && KopanowPrefs.isAdmin) {
            Log.w(TAG, "DPC no longer active but prefs say it should be — flagging tamper")
            KopanowPrefs.isAdmin = false
            // Fire-and-forget: failure here doesn't block the heartbeat result
            KopanowApi.reportTamper(borrowerId, loanId, "admin_silently_removed")
        }

        val compliance = MdmComplianceCollector.collect(context)

        // ── POST heartbeat payload ────────────────────────────────────────
        val request = HeartbeatRequest(
            borrowerId = borrowerId,
            loanId     = loanId,
            deviceId   = deviceId,
            dpcActive  = dpcActive,
            isSafeMode = safeMode,
            batteryPct = battery,
            frpSeeded  = KopanowPrefs.frpSeeded,
            timestamp  = System.currentTimeMillis(),
            mdmCompliance = compliance,
            appLockActive = KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked,
        )

        val result = KopanowApi.heartbeat(request)
        if (!result.success) {
            Log.e(TAG, "Heartbeat POST failed: ${result.error}")
            return Result.retry()
        }

        val response = result.data ?: run {
            Log.e(TAG, "Heartbeat returned null body")
            return Result.retry()
        }

        Log.i(TAG, "Heartbeat OK — action=${response.action}, locked=${response.locked}, msg=${response.message}")

        // ── Sync local state ──────────────────────────────────────────────
        KopanowPrefs.isLocked   = response.locked
        KopanowPrefs.lockReason = response.lockReason
        KopanowPrefs.amountDue  = response.amountDue

        RepaymentAlarmScheduler.schedule(context, response.invoices)
        RepaymentOverdueChecker.checkAndEnforce(context)

        when (response.action?.uppercase()) {
            ACTION_LOCK -> {
                Log.w(TAG, "Backend command: LOCK — engaging device lock (type=${response.lockType})")
                response.lockType?.let   { KopanowPrefs.lockType   = it }
                response.lockReason?.let { KopanowPrefs.lockReason = it }
                response.amountDue?.let  { KopanowPrefs.amountDue  = it }
                engageBackendLock(response)
            }

            ACTION_UNLOCK -> {
                Log.i(TAG, "Backend command: UNLOCK — releasing device lock")
                DeviceSecurityManager.unlockDevice(context)
            }

            ACTION_REMOVE_ADMIN -> {
                Log.i(TAG, "Backend command: REMOVE_ADMIN — loan closed, removing device admin")
                handleRemoveAdmin(borrowerId, loanId)
            }

            null, "" -> {
                // No backend command — apply local state passively
                if (response.locked) {
                    response.lockType?.let   { KopanowPrefs.lockType   = it }
                    response.lockReason?.let { KopanowPrefs.lockReason = it }
                    response.amountDue?.let  { KopanowPrefs.amountDue  = it }
                    engageBackendLock(response)
                } else {
                    DeviceSecurityManager.unlockDevice(context)
                }
                Log.d(TAG, "No action command — local state synced (locked=${response.locked})")
            }

            else -> {
                Log.w(TAG, "Unknown action '${response.action}' — ignoring")
            }
        }

        return Result.success()
    }

    /**
     * Backend says the device should be locked. For **PAYMENT** overdue locks we use the same
     * PIN path as FCM [SET_SYSTEM_PIN] (watchdog loop until admin Clear PIN). Non-payment locks
     * use screen lock + overlay only.
     */
    private suspend fun engageBackendLock(response: HeartbeatResponse) {
        val lockType = (response.lockType ?: KopanowPrefs.lockType ?: KopanowPrefs.LOCK_TYPE_PAYMENT)
            .trim().uppercase()
        if (lockType == KopanowPrefs.LOCK_TYPE_PAYMENT && !PasscodeManager.hasActivePasscode()) {
            KopanowPrefs.isLocked = true
            withContext(Dispatchers.Main) {
                FcmPinManager.handleSetSystemPin(context.applicationContext)
            }
            return
        }
        KopanowPrefs.isLocked = true
        withContext(Dispatchers.Main) {
            DeviceSecurityManager.lockDevice(context)
            KopanowLockService.ensureRunningForActiveLock(context)
            OverlayLockService.start(context)
        }
    }

    // ── Action: REMOVE_ADMIN ──────────────────────────────────────────────

    /**
     * Gracefully handle loan closure:
     *  1. Tell the backend the device is being released.
     *  2. Clear local prefs.
     *  3. Cancel the heartbeat schedule (no longer needed).
     *  4. Self-remove device admin.
     */
    private suspend fun handleRemoveAdmin(borrowerId: String, loanId: String) {
        // 1. Notify backend
        KopanowApi.updateStatus(borrowerId, loanId, "admin_removed_by_backend")

        RepaymentAlarmScheduler.cancelAll(context)

        // 2. Clear prefs
        KopanowPrefs.clear()

        // 3. Cancel future heartbeats
        HeartbeatScheduler.cancel(context)

        // 4. Remove device admin
        DeviceSecurityManager.removeDeviceAdmin(context)
        Log.i(TAG, "handleRemoveAdmin: prefs cleared, heartbeat cancelled, admin removed")
    }

    // ── Telemetry helpers ─────────────────────────────────────────────────

    /**
     * Reads the current battery percentage (0-100) from the sticky
     * [Intent.ACTION_BATTERY_CHANGED] broadcast — no receiver registration needed.
     * Returns -1 if the reading is unavailable.
     */
    private fun getBatteryPercent(): Int {
        val intent = context.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        ) ?: return -1
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
    }

    /**
     * Detect safe mode via reflection on [android.os.SystemProperties].
     * Primary path works on AOSP; OEM builds may differ.
     */
    private fun isSafeMode(): Boolean {
        return try {
            val clazz = Class.forName("android.os.SystemProperties")
            val get   = clazz.getMethod("get", String::class.java, String::class.java)
            (get.invoke(null, "sys.safemode", "0") as? String) == "1"
        } catch (_: Exception) {
            false
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Kopanow Heartbeat",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Periodic device protection check" }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
