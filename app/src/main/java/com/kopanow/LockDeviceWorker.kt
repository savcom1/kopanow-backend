package com.kopanow

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

/**
 * LockDeviceWorker — re-applies the device lock screen after a device reboot.
 */
class LockDeviceWorker(
    private val context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG         = "LockDeviceWorker"
        private const val MAX_RETRIES = 3

        private const val CHANNEL_ID      = "kopanow_lock_channel"
        private const val NOTIFICATION_ID = 9002

        /** Unique name used with WorkManager.enqueueUniqueWork to avoid duplicates. */
        const val UNIQUE_WORK_NAME = "kopanow_lock_device_on_boot"
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Kopanow Security")
            .setContentText("Restoring device protection after reboot…")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    override suspend fun doWork(): Result {
        // Ensure KopanowPrefs is initialised — workers can start before Application.onCreate()
        KopanowPrefs.init(context)

        val attempt = runAttemptCount
        Log.i(TAG, "doWork: attempt ${attempt + 1}/${MAX_RETRIES + 1} after reboot")

        if (attempt > MAX_RETRIES) return Result.failure()

        // Sync local lock state with backend truth
        val borrowerId = KopanowPrefs.borrowerId
        val loanId     = KopanowPrefs.loanId

        if (borrowerId == null || loanId == null) return Result.success()

        val heartbeatRequest = HeartbeatRequest(
            borrowerId = borrowerId,
            loanId     = loanId,
            deviceId   = DeviceSecurityManager.getDeviceId(context),
            dpcActive  = DeviceSecurityManager.isAdminActive(context),
            isSafeMode = false,
            batteryPct = -1,
            frpSeeded  = KopanowPrefs.frpSeeded,
            timestamp  = System.currentTimeMillis(),
            mdmCompliance = null,
            appLockActive = KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked,
        )
        val heartbeatResult = KopanowApi.heartbeat(heartbeatRequest)

        if (!heartbeatResult.success) {
            Log.e(TAG, "Sync failed: ${heartbeatResult.error} — retrying")
            return Result.retry()
        }

        val response = heartbeatResult.data
        if (response != null) {
            KopanowPrefs.isLocked   = response.locked
            KopanowPrefs.lockReason = response.lockReason
            KopanowPrefs.amountDue  = response.amountDue

            // Restore lock type from backend — determines whether user sees pay button or not
            // Backend returns action="LOCK" with lockType="TAMPER" for tamper scenarios
            val isServerTamperLock = response.lockType == "TAMPER" ||
                (response.locked && KopanowPrefs.isTamperLock)
            if (response.locked) {
                KopanowPrefs.lockType = if (isServerTamperLock)
                    KopanowPrefs.LOCK_TYPE_TAMPER
                else
                    KopanowPrefs.LOCK_TYPE_PAYMENT
            }

            // Backend says unlocked — send broadcast so LockScreenActivity verifies + dismisses
            if (!response.locked) {
                DeviceSecurityManager.unlockDevice(context)
                context.sendBroadcast(
                    Intent(KopanowFCMService.ACTION_UNLOCK_SCREEN).apply {
                        setPackage(context.packageName)
                    }
                )
            }
        }

        return Result.success()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Kopanow Device Lock",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Device lock restoration after reboot" }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
