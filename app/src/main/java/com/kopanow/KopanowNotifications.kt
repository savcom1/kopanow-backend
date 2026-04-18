package com.kopanow

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Local notification helpers so FCM data messages and foreground work produce
 * visible alerts when the app is not in the foreground (Android 13+ also
 * requires [android.Manifest.permission.POST_NOTIFICATIONS] at runtime).
 */
object KopanowNotifications {

    const val CHANNEL_ALERTS = "kopanow_alerts"

    const val NOTIF_ID_LOCK_COMMAND = 9101
    const val NOTIF_ID_UNLOCK_COMMAND = 9102

    fun canPostNotifications(context: Context): Boolean {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.POST_NOTIFICATIONS
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return nm.areNotificationsEnabled()
    }

    fun ensureAlertChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(
            CHANNEL_ALERTS,
            "Kopanow alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Loan and device security notifications"
            enableVibration(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(ch)
    }

    /**
     * Heads-up style notification for push-driven commands (FCM data payload).
     */
    fun showAlert(
        context: Context,
        notificationId: Int,
        title: String,
        text: String,
        contentIntent: PendingIntent?
    ) {
        if (!canPostNotifications(context)) return
        ensureAlertChannel(context)
        val appCtx = context.applicationContext
        val builder = NotificationCompat.Builder(appCtx, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
        contentIntent?.let { builder.setContentIntent(it) }
        val nm = appCtx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(notificationId, builder.build())
    }
}
