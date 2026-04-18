package com.kopanow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.google.android.material.button.MaterialButton
import android.widget.TextView

/**
 * OverlayLockService — shows a full-screen overlay over other apps while locked.
 *
 * Requires user-granted "Display over other apps" permission.
 * This is used to keep the lock visible even when the UI is not in foreground.
 */
class OverlayLockService : Service() {
    companion object {
        private const val TAG = "OverlayLockService"
        private const val CHANNEL_ID = "kopanow_overlay_v2"
        private const val NOTIFICATION_ID = 9004

        const val ACTION_START = "com.kopanow.START_OVERLAY"
        const val ACTION_STOP = "com.kopanow.STOP_OVERLAY"

        fun start(context: android.content.Context) {
            val i = Intent(context, OverlayLockService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
        }

        fun stop(context: android.content.Context) {
            context.startService(Intent(context, OverlayLockService::class.java).setAction(ACTION_STOP))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var overlayView: View? = null
    private var wm: WindowManager? = null

    private val loop = object : Runnable {
        override fun run() {
            try {
                val shouldShow = (KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked) && Settings.canDrawOverlays(this@OverlayLockService)
                if (shouldShow) {
                    KopanowLockService.ensureRunningForActiveLock(this@OverlayLockService)
                    ensureOverlayShown()
                } else ensureOverlayHidden()
            } catch (e: Exception) {
                Log.e(TAG, "loop: ${e.message}")
            }
            handler.postDelayed(this, 1000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                ensureOverlayHidden()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                startForegroundWithLockType()
                handler.removeCallbacks(loop)
                handler.post(loop)
                return START_STICKY
            }
            else -> return START_STICKY
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(loop)
        ensureOverlayHidden()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureOverlayShown() {
        if (overlayView != null) {
            refreshTexts()
            return
        }
        val windowManager = wm ?: return
        val view = LayoutInflater.from(this).inflate(R.layout.overlay_lock, null, false)

        view.findViewById<MaterialButton>(R.id.btn_open_lock_screen).setOnClickListener {
            startActivity(Intent(this, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            })
        }
        view.findViewById<MaterialButton>(R.id.btn_call_support).setOnClickListener {
            startActivity(SupportContact.dialIntent(this@OverlayLockService).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_FULLSCREEN or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }

        try {
            windowManager.addView(view, params)
            overlayView = view
            refreshTexts()
            Log.i(TAG, "Overlay shown")
        } catch (e: Exception) {
            Log.e(TAG, "addView failed: ${e.message}")
            overlayView = null
        }
    }

    private fun ensureOverlayHidden() {
        val view = overlayView ?: return
        try {
            wm?.removeView(view)
        } catch (_: Exception) {
        } finally {
            overlayView = null
        }
    }

    private fun refreshTexts() {
        val v = overlayView ?: return
        val title = v.findViewById<TextView>(R.id.tv_title)
        val body = v.findViewById<TextView>(R.id.tv_body)

        val isPasscode = KopanowPrefs.isPasscodeLocked
        val isTamper = KopanowPrefs.isTamperLock
        title.text = when {
            isPasscode -> "Enter PIN"
            isTamper -> "Security Violation"
            else -> "Device Locked"
        }
        body.text = when {
            isPasscode -> getString(R.string.overlay_body_passcode_with_phone)
            isTamper -> KopanowPrefs.lockReason ?: "Locked due to a security violation. Call 0744505529."
            else -> KopanowPrefs.lockReason
                ?: "Please make a payment to unlock your device. Support: 0744505529."
        }
    }

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
            .setContentTitle("Kopanow protection")
            .setContentText("Lock overlay is active")
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Kopanow Overlay", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows lock overlay over other apps"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }
}

