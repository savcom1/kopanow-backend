package com.kopanow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
        const val  CHANNEL_ID            = "kopanow_watchdog"
        private const val NOTIFICATION_ID = 9001
        private const val LOOP_MS         = 1500L   // re-check every 1.5 s

        const val ACTION_START = "com.kopanow.START_LOCK_SERVICE"
        const val ACTION_STOP  = "com.kopanow.STOP_LOCK_SERVICE"

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
            context.startService(
                Intent(context, KopanowLockService::class.java).setAction(ACTION_STOP)
            )
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var running = false

    // ── Lock loop ─────────────────────────────────────────────────────────────

    private val lockLoop = object : Runnable {
        override fun run() {
            if (!running) return

            if (KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked) {
                Log.d(TAG, "lockLoop ▶ device locked — relaunching LockScreenActivity")
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

        Log.i(TAG, "Starting foreground watchdog")
        startForeground(NOTIFICATION_ID, buildNotification())

        if (!running) {
            running = true
            handler.post(lockLoop)
        }

        return START_STICKY   // Android restarts this if killed — critical for persistence
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(lockLoop)
        Log.w(TAG, "onDestroy — service destroyed, attempting self-restart")

        // Self-restart when destroyed by the OS (if device is still locked)
        if (KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked) {
            start(applicationContext)
        }

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Notification ─────────────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, LockScreenActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Kopanow Device Management")
            .setContentText("This device is managed by Kopanow Loan Services")
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)          // cannot be dismissed by user
            .setShowWhen(false)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Kopanow Watchdog",
                NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps device management running"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }
}
