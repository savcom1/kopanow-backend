package com.kopanow

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * KopanowLockService — MDM Lite persistent foreground watchdog.
 *
 * Runs with START_STICKY so Android restarts it if killed.
 * Every [LOOP_MS] milliseconds it relaunches LockScreenActivity when the device is
 * in a locked state, creating a persistent lock loop that makes bypassing the lock
 * extremely difficult without the correct PIN.
 *
 * Lifecycle:
 *  • Started by BootReceiver on every reboot (if enrolled)
 *  • Started by FcmPinManager/KopanowFCMService on LOCK_DEVICE / SET_SYSTEM_PIN
 *  • Stopped by KopanowFCMService on UNLOCK_DEVICE / REMOVE_ADMIN
 */
class KopanowLockService : Service() {

    companion object {
        private const val TAG            = "KopanowLockService"
        /** v2: IMPORTANCE_LOW so the ongoing FG notification stays visible after API 26 channel lock-in. */
        const val  CHANNEL_ID            = "kopanow_watchdog_v2"
        private const val NOTIFICATION_ID = 9001
        private const val LOOP_MS         = 1500L   // re-check every 1.5 s

        const val ACTION_START = "com.kopanow.START_LOCK_SERVICE"
        const val ACTION_STOP  = "com.kopanow.STOP_LOCK_SERVICE"
        private const val ACTION_RESTART = "com.kopanow.RESTART_LOCK_SERVICE"

        /** Start or restart the service. */
        fun start(context: android.content.Context) {
            val intent = Intent(context, KopanowLockService::class.java)
                .setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Stop the service (only after full unlock). */
        fun stop(context: android.content.Context) {
            // Use stopService (no background start restrictions).
            context.stopService(Intent(context, KopanowLockService::class.java).setAction(ACTION_STOP))
        }

        /**
         * True while the watchdog must keep relaunching [LockScreenActivity] / overlay.
         * Single source of truth for the lock loop and for restart-after-kill scheduling.
         * Includes [PasscodeManager.hasActivePasscode] so prefs cannot desync from real PIN state.
         */
        fun shouldEnforceLockLoop(): Boolean =
            KopanowPrefs.isLocked ||
                KopanowPrefs.isPasscodeLocked ||
                PasscodeManager.hasActivePasscode() ||
                KopanowPrefs.isTamperLock

        /**
         * If the device is in a lock/tamper/passcode state but the foreground service was killed
         * (OEM task-kill, low memory), bring the watchdog back. Safe to call repeatedly.
         */
        fun ensureRunningForActiveLock(context: android.content.Context) {
            if (!shouldEnforceLockLoop()) return
            start(context.applicationContext)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var running = false

    // ── Lock loop ─────────────────────────────────────────────────────────────

    private val lockLoop = object : Runnable {
        override fun run() {
            if (!running) return

            if (shouldEnforceLockLoop()) {
                Log.d(TAG, "lockLoop ▶ device locked — relaunching LockScreenActivity")
                // Also show an overlay over other apps (if user granted permission).
                OverlayLockService.start(this@KopanowLockService)
                try {
                    startActivity(
                        Intent(this@KopanowLockService, LockScreenActivity::class.java).apply {
                            addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK          or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP        or
                                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                            )
                        }
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "lockLoop: startActivity failed: ${e.message}")
                }
            } else {
                // Not locked: ensure overlay is removed (service will stop itself).
                OverlayLockService.stop(this@KopanowLockService)
            }

            handler.postDelayed(this, LOOP_MS)
        }
    }

    // ── Service lifecycle ────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "STOP received")
            stopSelf()
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_RESTART) {
            Log.i(TAG, "RESTART received")
        }

        Log.i(TAG, "Starting foreground watchdog")
        startForegroundWithLockType()

        if (!running) {
            running = true
            handler.post(lockLoop)
        }

        return START_STICKY   // Android restarts this if killed — critical for persistence
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Triggered when the user swipes the app away from Recents.
        // START_STICKY is not guaranteed to restart immediately on all OEM builds,
        // so we schedule an explicit restart when protection is still needed.
        if (shouldEnforceLockLoop()) {
            Log.w(TAG, "onTaskRemoved — scheduling watchdog restart")
            scheduleRestart()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(lockLoop)
        Log.w(TAG, "onDestroy — service destroyed, attempting self-restart")

        // Self-restart when destroyed by the OS while lock/tamper/passcode is still active
        if (shouldEnforceLockLoop()) {
            scheduleRestart()
        }

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun scheduleRestart() {
        try {
            val intent = Intent(applicationContext, KopanowLockService::class.java).apply {
                action = ACTION_RESTART
            }
            val pi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // On Android 8+ background service starts are restricted; use a foreground-service PendingIntent.
                PendingIntent.getForegroundService(
                    applicationContext,
                    1,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            } else {
                PendingIntent.getService(
                    applicationContext,
                    1,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            }
            val am = getSystemService(ALARM_SERVICE) as AlarmManager
            val triggerAt = SystemClock.elapsedRealtime() + 2_000L
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            } else {
                @Suppress("DEPRECATION")
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            }
        } catch (e: Exception) {
            Log.e(TAG, "scheduleRestart failed: ${e.message}")
            // Last resort: immediate restart attempt
            try { start(applicationContext) } catch (_: Exception) {}
        }
    }

    // ── Notification ─────────────────────────────────────────────────────────

    /**
     * Android 14+ (targetSdk 34+): must pass [ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE]
     * to match manifest `foregroundServiceType="specialUse"` or the system can crash the FGS.
     */
    private fun startForegroundWithLockType() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, LockScreenActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Kopanow Device Management")
            .setContentText(getString(R.string.fg_notification_managed_with_phone))
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)          // cannot be dismissed by user
            .setShowWhen(false)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Kopanow Watchdog",
                NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps device management running in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }
}
