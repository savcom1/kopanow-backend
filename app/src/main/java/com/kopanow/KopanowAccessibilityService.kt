package com.kopanow

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * KopanowAccessibilityService — MDM Lite tamper detection shield.
 *
 * Monitors window state changes across all apps. When a borrower navigates to
 * dangerous settings screens (Device Admin page, Factory Reset, Developer Options,
 * App Info page where they could force-stop Kopanow), this service:
 *   1. Marks the device as TAMPER locked
 *   2. Immediately fires LockScreenActivity (before the settings page fully loads)
 *   3. Starts the foreground watchdog to keep relaunching the lock screen
 *
 * Setup: the borrower is prompted to enable this during onboarding.
 * Without it, the tamper detection won't fire — so the prompt is critical.
 */
class KopanowAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "KopanowAccessibility"

        private val DANGEROUS_KEYWORDS = listOf(
            "DeviceAdminSettings",
            "DeviceAdminAdd",
            "MasterClear",
            "MasterClearConfirm",
            "FactoryReset",
            "ResetDashboard",
            "EraseEverything",
            "PrivacySettings",
            "DevelopmentSettings",
            "DevelopmentSettingsDashboard",
            "UsageAccessSettings",
            "AccessibilitySettings",
            "ToggleAccessibilityService",
            "InstalledAppDetails",
            "AppInfoDashboard",
            "RunningServices",
        )

        private val SETTINGS_PACKAGES = setOf(
            "com.android.settings",
            "com.samsung.android.settings",
            "com.miui.securitycenter",
            "com.huawei.systemmanager",
            "com.oppo.settings",
            "com.coloros.settings",
        )
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes    = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType  = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags         = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            notificationTimeout = 100
        }
        Log.i(TAG, "Accessibility service connected — tamper shield active")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!KopanowPrefs.hasSession) return   // no session, nothing to protect
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val pkg = event.packageName?.toString() ?: return
        val cls = event.className?.toString()  ?: ""

        // Check if user navigated into a dangerous settings screen
        if (pkg in SETTINGS_PACKAGES) {
            val isDangerous = DANGEROUS_KEYWORDS.any { cls.contains(it, ignoreCase = true) }
            if (isDangerous) {
                Log.w(TAG, "⚠️ TAMPER ATTEMPT: $pkg / $cls — ENGAGING LOCK")
                engageTamperLock()
            }
        }
    }

    private fun engageTamperLock() {
        KopanowPrefs.isLocked = true
        KopanowPrefs.lockType = KopanowPrefs.LOCK_TYPE_TAMPER

        try {
            startActivity(Intent(this, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            })
        } catch (e: Exception) {
            Log.e(TAG, "engageTamperLock: startActivity failed: ${e.message}")
        }

        KopanowLockService.start(applicationContext)

        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId     = KopanowPrefs.loanId     ?: return
        scope.launch {
            try {
                KopanowApi.reportTamper(borrowerId, loanId, "settings_tamper_detected")
            } catch (e: Exception) {
                Log.e(TAG, "Tamper report failed: ${e.message}")
            }
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted")
    }
}
