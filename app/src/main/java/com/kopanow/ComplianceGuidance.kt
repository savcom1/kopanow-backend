package com.kopanow

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.StringRes

/**
 * Guided MDM-lite setup order (Accessibility always last). Mirrors [MdmComplianceCollector] required flags.
 */
enum class GuidedComplianceStep(
    val stepNumber: Int,
    @StringRes val titleRes: Int,
    @StringRes val descRes: Int,
) {
    DEVICE_ADMIN(
        1,
        R.string.compliance_step_admin_title,
        R.string.compliance_step_admin_desc,
    ),
    NOTIFICATIONS(
        2,
        R.string.compliance_step_notifications_title,
        R.string.compliance_step_notifications_desc,
    ),
    OVERLAY(
        3,
        R.string.compliance_step_overlay_title,
        R.string.compliance_step_overlay_desc,
    ),
    BATTERY(
        4,
        R.string.compliance_step_battery_title,
        R.string.compliance_step_battery_desc,
    ),
    USAGE(
        5,
        R.string.compliance_step_usage_title,
        R.string.compliance_step_usage_desc,
    ),
    EXACT_ALARMS(
        6,
        R.string.compliance_step_alarms_title,
        R.string.compliance_step_alarms_desc,
    ),
    ACCESSIBILITY(
        7,
        R.string.compliance_step_a11y_title,
        R.string.compliance_step_a11y_desc,
    );

    fun isDone(p: MdmCompliancePayload): Boolean = when (this) {
        DEVICE_ADMIN -> p.deviceAdmin
        NOTIFICATIONS -> p.notificationsEnabled
        OVERLAY -> p.displayOverOtherApps
        BATTERY -> p.batteryOptimizationIgnored
        USAGE -> p.usageStatsGranted
        EXACT_ALARMS -> p.canScheduleExactAlarms
        ACCESSIBILITY -> p.accessibilityService
    }

    /**
     * Opens the best Settings screen for this step. [onRequestDeviceAdmin] runs only for [DEVICE_ADMIN]
     * (system device-admin activation flow).
     */
    fun launch(activity: Activity, onRequestDeviceAdmin: () -> Unit) {
        val pkg = activity.packageName
        when (this) {
            DEVICE_ADMIN -> onRequestDeviceAdmin()
            NOTIFICATIONS -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try {
                        activity.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                                putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                            },
                        )
                    } catch (_: Exception) {
                        openAppDetails(activity, pkg)
                    }
                } else {
                    openAppDetails(activity, pkg)
                }
            }
            OVERLAY -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        activity.startActivity(
                            Intent(
                                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:$pkg"),
                            ),
                        )
                    } catch (_: Exception) {
                        openAppDetails(activity, pkg)
                    }
                }
            }
            BATTERY -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        activity.startActivity(
                            Intent(
                                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                Uri.parse("package:$pkg"),
                            ),
                        )
                    } catch (_: Exception) {
                        openAppDetails(activity, pkg)
                    }
                }
            }
            USAGE -> {
                try {
                    activity.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                } catch (_: Exception) {
                    openAppDetails(activity, pkg)
                }
            }
            EXACT_ALARMS -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        activity.startActivity(
                            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                                data = Uri.parse("package:$pkg")
                            },
                        )
                    } catch (_: Exception) {
                        openAppDetails(activity, pkg)
                    }
                } else {
                    openAppDetails(activity, pkg)
                }
            }
            ACCESSIBILITY -> {
                try {
                    // Start onboarding-only grace window *before* opening Accessibility settings.
                    // Otherwise, the newly-enabled service can see the settings screen and engage tamper lock
                    // before MainActivity has a chance to set the grace flag on return.
                    try {
                        KopanowPrefs.init(activity.applicationContext)
                        if (!KopanowPrefs.onboardingCompleted) {
                            KopanowPrefs.a11yGraceUntilMs = System.currentTimeMillis() + 5L * 60L * 1000L
                        }
                    } catch (_: Exception) {
                        // Best effort: if prefs init fails, proceed to settings anyway.
                    }
                    activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (_: Exception) {
                    openAppDetails(activity, pkg)
                }
            }
        }
    }

    /** App info — for Android 13+ "Allow restricted settings" before enabling Accessibility on sideloaded builds. */
    fun openAppInfo(activity: Activity) {
        openAppDetails(activity, activity.packageName)
    }

    companion object {
        val ORDERED: List<GuidedComplianceStep> = entries.toList()

        fun countDone(p: MdmCompliancePayload): Int =
            ORDERED.count { it.isDone(p) }
    }
}

private fun openAppDetails(ctx: Context, pkg: String) {
    ctx.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", pkg, null)
        },
    )
}
