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
 *   3. Starts the foreground watchdog + overlay loop until ops clears via admin UI (FCM UNLOCK)
 *
 * Setup: the borrower is prompted to enable this during onboarding.
 */
class KopanowAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "KopanowAccessibility"

        private val DANGEROUS_KEYWORDS = listOf(
            "DeviceAdminSettings",
            "DeviceAdminAdd",
            "BindDeviceAdmin",
            "ManageDeviceAdmins",
            "UninstallDeviceAdmin",
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
            // OEM / AOSP variants
            "SecuritySettings",
            "AdvancedSecuritySettings",
            "DeviceAdmin",
        )

        /** Shown on the system Device admin / administrators screen (AOSP + common OEM). */
        private val DEVICE_ADMIN_WINDOW_PHRASES = listOf(
            "Device admin apps",
            "Device administrators",
            "Device administrator",
            "Administrator apps",
            "Deactivate this device admin app",
            "Remove Kopanow",
        )

        private val SETTINGS_PACKAGES = setOf(
            "com.android.settings",
            "com.samsung.android.settings",
            "com.miui.securitycenter",
            "com.huawei.systemmanager",
            "com.oppo.settings",
            "com.coloros.settings",
            "com.vivo.settings",
        )

    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onServiceConnected() {
        super.onServiceConnected()
        try { KopanowPrefs.init(applicationContext) } catch (_: Exception) {}
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            notificationTimeout = 0
        }
        Log.i(TAG, "Accessibility service connected — tamper shield active")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        // Protect whenever MDM is relevant: device admin flag and/or loan session (not loanId alone).
        if (!KopanowPrefs.isMdmProtectionActive) return

        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return

        val pkg = event.packageName?.toString() ?: return
        val cls = event.className?.toString() ?: ""

        if (pkg !in SETTINGS_PACKAGES) return

        val dangerousByClass = DANGEROUS_KEYWORDS.any { cls.contains(it, ignoreCase = true) }
        if (dangerousByClass) {
            Log.w(TAG, "⚠️ TAMPER (class): $pkg / $cls — ENGAGING LOCK")
            engageTamperLock(reason = "Security Alert: Attempt to bypass device protection.")
            return
        }

        // Many OEMs use a generic SubSettings activity; detect the Device admin screen by visible text.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            looksLikeGenericSettingsContainer(cls)
        ) {
            val root = rootInActiveWindow
            if (root != null) {
                try {
                    if (treeContainsDeviceAdminPhrases(root)) {
                        Log.w(TAG, "⚠️ TAMPER (text scan): $pkg / $cls — ENGAGING LOCK")
                        engageTamperLock(reason = "Security Alert: Attempt to access device administrator settings.")
                        return
                    }
                } finally {
                    root.recycle()
                }
            }
        }

        // App info → Force stop
        if (cls.contains("InstalledAppDetails", ignoreCase = true) ||
            cls.contains("AppInfoDashboard", ignoreCase = true) ||
            cls.contains("ManageApplications", ignoreCase = true)
        ) {
            val src = event.source
            if (src != null) {
                try {
                    if (containsForceStopControl(src)) {
                        Log.w(TAG, "⚠️ FORCE STOP screen detected ($pkg / $cls) — ENGAGING TAMPER LOCK")
                        engageTamperLock(reason = "Security Alert: Attempt to force stop Kopanow.")
                        return
                    }
                } finally {
                    src.recycle()
                }
            }
        }
    }

    /** Many builds use a generic activity name; we then scan window text for device-admin phrases. */
    private fun looksLikeGenericSettingsContainer(cls: String): Boolean {
        if (cls.isBlank()) return false
        return cls.contains("SubSettings", ignoreCase = true) ||
            cls.contains("SettingsActivity", ignoreCase = true) ||
            cls.contains("MiuiSettings", ignoreCase = true) ||
            cls.contains("HwSettings", ignoreCase = true)
    }

    private fun treeContainsDeviceAdminPhrases(root: AccessibilityNodeInfo): Boolean {
        for (needle in DEVICE_ADMIN_WINDOW_PHRASES) {
            if (findTextInTree(root, needle)) return true
        }
        return false
    }

    private fun findTextInTree(node: AccessibilityNodeInfo?, needle: String): Boolean {
        if (node == null) return false
        val chunk = buildString {
            append(node.text ?: "")
            append(' ')
            append(node.contentDescription ?: "")
        }
        if (chunk.contains(needle, ignoreCase = true)) return true
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (findTextInTree(child, needle)) {
                child.recycle()
                return true
            }
            child.recycle()
        }
        return false
    }

    private fun containsForceStopControl(root: AccessibilityNodeInfo): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
            try {
                val ids = listOf(
                    "com.android.settings:id/force_stop_button",
                    "com.samsung.android.settings:id/force_stop_button",
                    "com.miui.securitycenter:id/force_stop",
                    "com.miui.securitycenter:id/btn_force_stop",
                    "com.huawei.systemmanager:id/force_stop",
                    "com.huawei.systemmanager:id/force_stop_button",
                    "com.oppo.settings:id/force_stop_button",
                    "com.coloros.settings:id/force_stop_button",
                    "com.vivo.settings:id/force_stop_button",
                )
                for (id in ids) {
                    val nodes = root.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) return true
                }
            } catch (_: Exception) {
            }
        }

        return try {
            val phrases = listOf(
                "Force stop",
                "Lazimisha kusitisha",
                "Lazimisha kusimamisha",
                "Forcer l'arrêt",
                "Forzar detención",
                "Forçar parada",
                "Stopp erzwingen",
                "Forza arresto",
                "Принудительная остановка",
                "إيقاف إجباري",
                "强行停止",
                "强制停止",
                "強制停止",
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
        KopanowPrefs.lockReason = reason

        DeviceSecurityManager.lockDevice(this)

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
        val loanId = KopanowPrefs.loanId ?: return
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
