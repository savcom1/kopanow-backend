package com.kopanow

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
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
        // Ensure prefs are ready even if Application hasn't run yet
        try { KopanowPrefs.init(applicationContext) } catch (_: Exception) {}
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes    = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType  = AccessibilityServiceInfo.FEEDBACK_GENERIC
            // Keep latency as low as possible; we want the tamper lock to fire immediately.
            flags         = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            notificationTimeout = 0
        }
        Log.i(TAG, "Accessibility service connected — tamper shield active")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!KopanowPrefs.hasSession) return   // no session, nothing to protect
        // We listen to both STATE_CHANGED and CONTENT_CHANGED for earliest possible interception.
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return

        val pkg = event.packageName?.toString() ?: return
        val cls = event.className?.toString()  ?: ""

        // Check if user navigated into a dangerous settings screen
        if (pkg in SETTINGS_PACKAGES) {
            val isDangerous = DANGEROUS_KEYWORDS.any { cls.contains(it, ignoreCase = true) }
            if (isDangerous) {
                Log.w(TAG, "⚠️ TAMPER ATTEMPT: $pkg / $cls — ENGAGING LOCK")
                engageTamperLock(reason = "Security Alert: Attempt to bypass device protection.")
                return
            }

            // Special case: App info screen where the user can press "Force stop".
            // We try to detect the presence of the Force stop button by view-id or text
            // and engage lock immediately before they can tap it.
            if (cls.contains("InstalledAppDetails", ignoreCase = true) ||
                cls.contains("AppInfoDashboard", ignoreCase = true) ||
                cls.contains("ManageApplications", ignoreCase = true)
            ) {
                val src = event.source
                if (src != null && containsForceStopControl(src)) {
                    Log.w(TAG, "⚠️ FORCE STOP screen detected ($pkg / $cls) — ENGAGING TAMPER LOCK")
                    engageTamperLock(reason = "Security Alert: Attempt to force stop Kopanow.")
                    return
                }
            }
        }
    }

    private fun containsForceStopControl(root: AccessibilityNodeInfo): Boolean {
        // 1) Resource-id based detection (AOSP + some OEMs)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
            try {
                val ids = listOf(
                    // AOSP Settings
                    "com.android.settings:id/force_stop_button",
                    "com.samsung.android.settings:id/force_stop_button",
                    // MIUI / SecurityCenter variants
                    "com.miui.securitycenter:id/force_stop",
                    "com.miui.securitycenter:id/btn_force_stop",
                    // Huawei / System Manager variants
                    "com.huawei.systemmanager:id/force_stop",
                    "com.huawei.systemmanager:id/force_stop_button",
                    // Oppo / ColorOS variants
                    "com.oppo.settings:id/force_stop_button",
                    "com.coloros.settings:id/force_stop_button",
                    // Vivo variants
                    "com.vivo.settings:id/force_stop_button",
                )
                for (id in ids) {
                    val nodes = root.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) return true
                }
            } catch (_: Exception) {
                // ignore
            }
        }

        // 2) Text based detection (multi-language, best-effort)
        return try {
            val phrases = listOf(
                // English
                "Force stop",
                // Swahili (common in TZ/KE builds)
                "Lazimisha kusitisha",
                "Lazimisha kusimamisha",
                // French
                "Forcer l'arrêt",
                "Forcer l’arret",
                // Spanish
                "Forzar detención",
                "Forzar detencion",
                // Portuguese
                "Forçar parada",
                // German
                "Stopp erzwingen",
                // Italian
                "Forza arresto",
                // Russian
                "Принудительная остановка",
                // Arabic
                "إيقاف إجباري",
                // Chinese (simplified)
                "强行停止",
                "强制停止",
                // Japanese
                "強制停止",
                // Korean
                "강제 종료",
            )
            phrases.any { phrase ->
                val nodes = root.findAccessibilityNodeInfosByText(phrase)
                !nodes.isNullOrEmpty()
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun engageTamperLock(reason: String) {
        KopanowPrefs.isLocked = true
        KopanowPrefs.lockType = KopanowPrefs.LOCK_TYPE_TAMPER
        // Always overwrite so the lock UI reflects the most recent tamper attempt.
        KopanowPrefs.lockReason = reason

        // Immediate system lock (best effort; requires device admin)
        DeviceSecurityManager.lockDevice(this)

        // Start background enforcement first (so even if activity launch is blocked, we keep trying)
        KopanowLockService.start(applicationContext)
        OverlayLockService.start(applicationContext)

        try {
            startActivity(Intent(this, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            })
        } catch (e: Exception) {
            Log.e(TAG, "engageTamperLock: startActivity failed: ${e.message}")
        }

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
