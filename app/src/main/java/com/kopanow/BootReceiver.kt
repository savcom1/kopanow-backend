package com.kopanow

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * BootReceiver — survives device reboot to restore the MDM lock and
 * restart background services.
 *
 * Registered in AndroidManifest.xml for:
 *   • android.intent.action.BOOT_COMPLETED          (normal boot)
 *   • android.intent.action.LOCKED_BOOT_COMPLETED   (direct-boot / encrypted storage)
 *
 * On every boot (regardless of lock state) this receiver:
 *  1. Initialises [KopanowPrefs] from encrypted storage.
 *  2. Detects **safe mode** ([ActivityManager.isInLockTaskMode] + intent flag);
 *     if true, immediately reports a tamper event to the backend via an
 *     EXPEDITED [TamperReportWorker].
 *  3. Re-schedules the periodic [HeartbeatWorker] so the cadence restarts
 *     from now instead of waiting for the old (cancelled) period to elapse.
 *  4. If [KopanowPrefs.isLocked] was true before the reboot, re-applies the device lock.
 *
 * Note: [KopanowPrefs.init] must be called before reading prefs. We do it
 * here because the Application class may not have run yet in direct-boot.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"

        /** Extra flag set by Android when the device boots into safe mode. */
        private const val EXTRA_SAFE_MODE = "android.intent.extra.SAFE_BOOT"

        /** Tamper event name sent to backend when safe mode is detected. */
        private const val TAMPER_SAFE_MODE = "safe_mode_boot"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.LOCKED_BOOT_COMPLETED"
        ) return

        Log.i(TAG, "onReceive: action=$action")

        // ── 1. Initialise encrypted prefs ─────────────────────────────────
        try {
            KopanowPrefs.init(context.applicationContext)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to init KopanowPrefs on boot — aborting", e)
            return
        }

        // Only act if a borrower session is enrolled; no session → nothing to do
        if (!KopanowPrefs.hasSession) {
            Log.i(TAG, "No active session — skipping all boot tasks")
            return
        }

        // ── 2. Safe-mode detection ────────────────────────────────────────
        val isSafeMode = detectSafeMode(context, intent)
        if (isSafeMode) {
            Log.w(TAG, "⚠️ Device booted into SAFE MODE — reporting tamper event")
            enqueueSafeModeReport(context)
            // Continue — we still re-schedule the heartbeat and lock if needed,
            // because WorkManager itself runs in safe mode (it is a system service).
        }

        // ── 3. Re-schedule periodic heartbeat ────────────────────────────
        HeartbeatScheduler.schedule(context)
        Log.i(TAG, "HeartbeatWorker re-scheduled after reboot")

        // ── 4. Start MDM Lite foreground watchdog (always when enrolled) ───
        KopanowLockService.start(context)
        Log.i(TAG, "KopanowLockService started after reboot")

        // ── 5. Re-apply lock if device was locked before reboot ───────────
        if (KopanowPrefs.isLocked) {
            Log.w(TAG, "Device is locked — applying immediate restrictions (OFFLINE support)")

            // Force screen lock immediately (Synchronous, no network needed)
            DeviceSecurityManager.lockDevice(context)

            // Launch the LockScreenActivity overlay immediately
            val lockIntent = Intent(context, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            context.startActivity(lockIntent)

            // Enqueue a sync worker to check with backend once online
            enqueueSyncWorker(context)
        } else {
            Log.i(TAG, "Device not locked before reboot — skipping lock restoration")
        }
    }

    // ── Safe-mode detection ───────────────────────────────────────────────

    /**
     * Returns true if the device has booted into safe mode.
     */
    private fun detectSafeMode(context: Context, intent: Intent): Boolean {
        // Primary: intent extra (reliable on API 26+)
        if (intent.getBooleanExtra(EXTRA_SAFE_MODE, false)) {
            Log.w(TAG, "detectSafeMode: intent extra indicates safe mode")
            return true
        }

        // Fallback: read SystemProperties (works on AOSP, may not on all OEMs)
        return try {
            val clazz = Class.forName("android.os.SystemProperties")
            val get   = clazz.getMethod("get", String::class.java, String::class.java)
            val value = get.invoke(null, "sys.safemode", "0") as? String
            val safe  = value == "1"
            if (safe) Log.w(TAG, "detectSafeMode: SystemProperties sys.safemode=1")
            safe
        } catch (e: Exception) {
            Log.d(TAG, "detectSafeMode: SystemProperties fallback unavailable — ${e.message}")
            false
        }
    }

    // ── Enqueue helpers ───────────────────────────────────────────────────

    private fun enqueueSafeModeReport(context: Context) {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId     = KopanowPrefs.loanId     ?: return

        val inputData = Data.Builder()
            .putString(TamperReportWorker.KEY_BORROWER_ID, borrowerId)
            .putString(TamperReportWorker.KEY_LOAN_ID, loanId)
            .putString(TamperReportWorker.KEY_EVENT, TAMPER_SAFE_MODE)
            .build()

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<TamperReportWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .setInputData(inputData)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueue(request)
        Log.i(TAG, "Safe-mode tamper report enqueued (EXPEDITED)")
    }

    /**
     * Enqueue a sync worker that checks with backend once online.
     */
    private fun enqueueSyncWorker(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<LockDeviceWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            LockDeviceWorker.UNIQUE_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request
        )

        Log.i(TAG, "Sync worker enqueued (unique=${LockDeviceWorker.UNIQUE_WORK_NAME})")
    }
}
