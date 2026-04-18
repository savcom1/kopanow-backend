package com.kopanow

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager

/**
 * KopanowAdminReceiver — Aggressive Tamper Protection.
 */
class KopanowAdminReceiver : DeviceAdminReceiver() {

    companion object {
        private const val TAG = "KopanowAdminReceiver"
        private const val CHANNEL_ID = "kopanow_security_alerts"
    }

    override fun onReceive(context: Context, intent: Intent) {
        KopanowPrefs.init(context.applicationContext)
        super.onReceive(context, intent)
    }

    /**
     * Aggressive Trigger: User clicked 'Deactivate' in Settings.
     * We lock the device BEFORE they can confirm.
     */
    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        Log.w(TAG, "onDisableRequested: Attempt to deactivate detected. Locking...")
        
        triggerTamperLock(context)
        
        return "SECURITY ALERT: This device is now locked. Your attempt to disable protection has been logged and reported to Kopanow Security."
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        KopanowPrefs.isAdmin = true

        val dpm   = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
        val admin = android.content.ComponentName(context, KopanowAdminReceiver::class.java)
        val isDeviceOwner = dpm.isDeviceOwnerApp(context.packageName)

        Log.i(TAG, "onEnabled: Device Admin active. Device Owner = $isDeviceOwner")

        if (isDeviceOwner) {
            // setLockTaskPackages() requires Device Owner — skip silently if not DO
            try {
                dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
                Log.i(TAG, "onEnabled: lock task packages set (kiosk mode enabled) ✓")
            } catch (e: Exception) {
                Log.w(TAG, "onEnabled: setLockTaskPackages failed: ${e.message}")
            }
        } else {
            Log.w(TAG, "onEnabled: NOT Device Owner — kiosk mode and system PIN will be unavailable. " +
                    "To enable: adb shell dpm set-device-owner com.kopanow/.KopanowAdminReceiver")
        }

        enqueueTamperReport(context, "admin_enabled")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        KopanowPrefs.init(context.applicationContext)

        val remoteRemoval = DeviceSecurityManager.consumePendingRemoteAdminRemoval()
        KopanowPrefs.isAdmin = false

        if (remoteRemoval) {
            Log.i(TAG, "onDisabled: device admin removed by Kopanow (remote release) — no tamper lock")
            return
        }

        Log.e(TAG, "onDisabled: device admin removed without remote release — treating as tamper")
        if (!KopanowPrefs.hasSession) {
            Log.w(TAG, "onDisabled: no active session — skipping tamper lock UI")
            return
        }

        KopanowPrefs.isLocked = true
        triggerTamperLock(context)
        enqueueTamperReport(context, "admin_disabled_by_user")
    }

    /**
     * Forces an immediate system lock and pops up the overlay using a FullScreenIntent.
     */
    private fun triggerTamperLock(context: Context) {
        KopanowPrefs.isLocked  = true
        KopanowPrefs.lockType  = KopanowPrefs.LOCK_TYPE_TAMPER   // ← tamper = no pay button
        if (KopanowPrefs.lockReason.isNullOrBlank()) {
            KopanowPrefs.lockReason = "Security Alert: Unauthorized attempt to disable device protection."
        }

        // 1. Immediate System Lock
        DeviceSecurityManager.lockDevice(context)

        // 1b. Start persistent watchdog + overlay immediately (even if activity launch is blocked)
        KopanowLockService.start(context.applicationContext)
        OverlayLockService.start(context.applicationContext)

        // 2. Prepare Intent
        val lockIntent = Intent(context, LockScreenActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        
        val pendingIntent = PendingIntent.getActivity(
            context, 0, lockIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 3. Setup Notification Channel
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Security Alerts", NotificationManager.IMPORTANCE_HIGH)
            notificationManager.createNotificationChannel(channel)
        }

        // 4. Build and Notify with FullScreenIntent
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Security Violation")
            .setContentText("Device is locked due to tampering.")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(false)
            .setOngoing(true)
            .build()

        notificationManager.notify(999, notification)
        
        // 5. Direct launch attempt as backup
        try {
            context.startActivity(lockIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Direct launch failed, relying on FullScreenIntent")
        }
    }

    private fun enqueueTamperReport(context: Context, event: String) {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return

        val inputData = Data.Builder()
            .putString(TamperReportWorker.KEY_BORROWER_ID, borrowerId)
            .putString(TamperReportWorker.KEY_LOAN_ID, loanId)
            .putString(TamperReportWorker.KEY_EVENT, event)
            .build()

        val request = OneTimeWorkRequestBuilder<TamperReportWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInputData(inputData)
            .build()

        WorkManager.getInstance(context).enqueue(request)
    }
}
