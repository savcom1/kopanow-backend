package com.kopanow

import android.app.AlarmManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.gson.annotations.SerializedName

/**
 * Snapshots user-granted capabilities Kopanow needs (admin, accessibility, overlay,
 * notifications, battery exemption, usage stats, exact alarms). Sent on every heartbeat
 * so the ops dashboard can see what is missing per device.
 */
object MdmComplianceCollector {

    fun collect(context: Context): MdmCompliancePayload {
        val app = context.applicationContext
        val pkg = app.packageName

        val deviceAdmin = DeviceSecurityManager.isAdminActive(app)
        val accessibility = isKopanowAccessibilityServiceEnabled(app)
        val displayOverOtherApps =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Settings.canDrawOverlays(app)
            } else {
                true
            }

        val notificationsEnabled = NotificationManagerCompat.from(app).areNotificationsEnabled()
        val postNotificationsGranted =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    app,
                    android.Manifest.permission.POST_NOTIFICATIONS
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        val notificationsOk = notificationsEnabled && postNotificationsGranted

        val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        val batteryIgnored = pm.isIgnoringBatteryOptimizations(pkg)

        val usageStatsOk = hasUsageStatsAccess(app)

        val exactAlarmsOk =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                am.canScheduleExactAlarms()
            } else {
                true
            }

        val fcmTokenPresent = !KopanowPrefs.fcmToken.isNullOrBlank()

        val fullScreenIntentOk =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.canUseFullScreenIntent()
            } else {
                true
            }

        // Required for MDM-lite: everything except FCM (auto) and full-screen intent (API 34+ nuance).
        val requiredFlags = listOf(
            deviceAdmin,
            accessibility,
            displayOverOtherApps,
            notificationsOk,
            batteryIgnored,
            usageStatsOk,
            exactAlarmsOk,
        )
        val okCount = requiredFlags.count { it }
        val requiredCount = requiredFlags.size
        val allRequiredOk = okCount == requiredCount

        return MdmCompliancePayload(
            deviceAdmin = deviceAdmin,
            accessibilityService = accessibility,
            displayOverOtherApps = displayOverOtherApps,
            notificationsEnabled = notificationsOk,
            postNotificationsPermission = postNotificationsGranted,
            batteryOptimizationIgnored = batteryIgnored,
            usageStatsGranted = usageStatsOk,
            canScheduleExactAlarms = exactAlarmsOk,
            fullScreenIntentAllowed = fullScreenIntentOk,
            fcmTokenPresent = fcmTokenPresent,
            sdkInt = Build.VERSION.SDK_INT,
            allRequiredOk = allRequiredOk,
            okCount = okCount,
            requiredCount = requiredCount,
            capturedAtMs = System.currentTimeMillis(),
        )
    }

    /** True when KopaNow [KopanowAccessibilityService] is listed in [Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES]. */
    fun isKopanowAccessibilityServiceEnabled(context: Context): Boolean {
        val cn = "${context.packageName}/${KopanowAccessibilityService::class.java.name}"
        val raw = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return raw.split(':').any {
            it.equals(cn, ignoreCase = true) ||
                (it.contains(context.packageName, ignoreCase = true) &&
                    it.contains("KopanowAccessibilityService", ignoreCase = true))
        }
    }

    private fun hasUsageStatsAccess(context: Context): Boolean {
        return try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                context.packageName
            )
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) {
            false
        }
    }

    /** Multi-line status for on-device UI (✓ / ✗ updates in real time). */
    fun formatChecklistLines(p: MdmCompliancePayload): String {
        fun line(ok: Boolean, label: String) =
            "${if (ok) "✓" else "✗"} $label"
        return buildString {
            appendLine(line(p.deviceAdmin, "Device administrator"))
            appendLine(line(p.accessibilityService, "Accessibility service"))
            appendLine(line(p.displayOverOtherApps, "Display over other apps"))
            appendLine(line(p.notificationsEnabled, "Notifications"))
            appendLine(line(p.batteryOptimizationIgnored, "Battery: unrestricted"))
            appendLine(line(p.usageStatsGranted, "Usage access"))
            appendLine(line(p.canScheduleExactAlarms, "Alarms & reminders (exact)"))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                appendLine(line(p.fullScreenIntentAllowed, "Full-screen intents (API 34+)"))
            }
            appendLine(line(p.fcmTokenPresent, "Push (FCM) token"))
        }.trimEnd()
    }
}

data class MdmCompliancePayload(
    @SerializedName("device_admin") val deviceAdmin: Boolean,
    @SerializedName("accessibility_service") val accessibilityService: Boolean,
    @SerializedName("display_over_other_apps") val displayOverOtherApps: Boolean,
    /** Post-notifications permission (API 33+) + notifications not blocked at app level. */
    @SerializedName("notifications_ok") val notificationsEnabled: Boolean,
    @SerializedName("post_notifications_permission") val postNotificationsPermission: Boolean,
    @SerializedName("battery_optimization_ignored") val batteryOptimizationIgnored: Boolean,
    @SerializedName("usage_stats_granted") val usageStatsGranted: Boolean,
    @SerializedName("can_schedule_exact_alarms") val canScheduleExactAlarms: Boolean,
    @SerializedName("full_screen_intent_allowed") val fullScreenIntentAllowed: Boolean,
    @SerializedName("fcm_token_present") val fcmTokenPresent: Boolean,
    @SerializedName("sdk_int") val sdkInt: Int,
    @SerializedName("all_required_ok") val allRequiredOk: Boolean,
    @SerializedName("ok_count") val okCount: Int,
    @SerializedName("required_count") val requiredCount: Int,
    @SerializedName("captured_at_ms") val capturedAtMs: Long,
)
