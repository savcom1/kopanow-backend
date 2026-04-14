package com.kopanow

import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File

/**
 * DeviceSecurityManager — MDM lock engine for Kopanow.
 *
 * Responsibilities:
 *  • 4-layer root detection
 *  • Lock / unlock the device screen via DevicePolicyManager
 *  • Disable ADB / USB debugging
 *  • Remove device admin (self-removes on loan closure)
 *  • Retrieve a stable device ID
 */
object DeviceSecurityManager {

    private const val TAG = "DeviceSecurityManager"

    // ─── Root detection ──────────────────────────────────────────────────

    /**
     * Layer 1 — well-known su binary paths.
     * Any rooted device will have su in at least one of these locations.
     */
    private val SU_PATHS = listOf(
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su",
        "/su/bin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/data/local/su",
        "/system/sd/xbin/su",
        "/system/bin/failsafe/su",
        "/dev/com.koushikdutta.superuser.daemon/"
    )

    private fun checkSuPaths(): Boolean =
        SU_PATHS.any { File(it).exists() }.also { found ->
            if (found) Log.w(TAG, "Root layer 1: su binary found")
        }

    /**
     * Layer 2 — Magisk Manager package presence.
     */
    private fun checkMagisk(context: Context): Boolean {
        val magiskPackages = listOf(
            "com.topjohnwu.magisk",
            "com.github.topjohnwu.magisk",
            "io.github.vvb2060.magisk",          // hidden Magisk
            "io.github.huskydg.magisk"            // Kitsune / Delta
        )
        val pm = context.packageManager
        return magiskPackages.any { pkg ->
            try {
                pm.getPackageInfo(pkg, 0)
                Log.w(TAG, "Root layer 2: Magisk package found — $pkg")
                true
            } catch (_: Exception) { false }
        }
    }

    /**
     * Layer 3 — test-keys build tag.
     * Production devices are signed with "release-keys"; rooted/custom ROMs
     * often use "test-keys" or "dev-keys".
     */
    private fun checkTestKeys(): Boolean {
        val tags = Build.TAGS ?: ""
        val rooted = tags.contains("test-keys", ignoreCase = true) ||
                tags.contains("dev-keys", ignoreCase = true)
        if (rooted) Log.w(TAG, "Root layer 3: test/dev-keys build tag detected — $tags")
        return rooted
    }

    /**
     * Layer 4 — Execute `which su` via Runtime.
     * If su is on the PATH this returns a non-empty result.
     */
    private fun checkWhichSu(): Boolean {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("/system/xbin/which", "su"))
            val result = process.inputStream.bufferedReader().readLine()
            val found = !result.isNullOrBlank()
            if (found) Log.w(TAG, "Root layer 4: 'which su' returned — $result")
            found
        } catch (e: Exception) {
            Log.d(TAG, "Root layer 4: which su check inconclusive — ${e.message}")
            false
        }
    }

    /**
     * Run all 4 root detection layers.
     * Returns true if ANY layer detects root.
     *
     * @return RootCheckResult with a flag per layer for detailed reporting.
     */
    fun checkRoot(context: Context): RootCheckResult {
        val suPaths  = checkSuPaths()
        val magisk   = checkMagisk(context)
        val testKeys = checkTestKeys()
        val whichSu  = checkWhichSu()
        val isRooted = suPaths || magisk || testKeys || whichSu
        Log.i(TAG, "Root check — rooted=$isRooted (su=$suPaths, magisk=$magisk, testKeys=$testKeys, whichSu=$whichSu)")
        return RootCheckResult(isRooted, suPaths, magisk, testKeys, whichSu)
    }

    data class RootCheckResult(
        val isRooted: Boolean,
        val suPathsFound: Boolean,
        val magiskFound: Boolean,
        val testKeysFound: Boolean,
        val whichSuFound: Boolean
    )

    // ─── Device admin helpers ─────────────────────────────────────────────

    private fun adminComponent(context: Context) =
        ComponentName(context, KopanowAdminReceiver::class.java)

    private fun dpm(context: Context) =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** True if Kopanow is an active device administrator. */
    fun isAdminActive(context: Context): Boolean =
        dpm(context).isAdminActive(adminComponent(context))

    // ─── Lock / unlock ────────────────────────────────────────────────────

    /**
     * Immediately lock the device screen.
     * Requires device admin to be active.
     */
    fun lockDevice(context: Context): Boolean {
        return try {
            if (!isAdminActive(context)) {
                Log.e(TAG, "lockDevice: admin not active, cannot lock")
                return false
            }
            dpm(context).lockNow()
            Log.i(TAG, "lockDevice: screen locked")
            true
        } catch (e: Exception) {
            Log.e(TAG, "lockDevice failed", e)
            false
        }
    }

    /**
     * Unlock the device by clearing the password lock set by Kopanow.
     * Note: Can only clear a password that Kopanow itself set via
     * resetPassword (deprecated API ≥ Android 8). On Android 8+ this
     * requires Device Owner — for MDM-lite we rely on FCM + WorkManager
     * to stop showing the lock overlay rather than clearing the PIN.
     */
    fun unlockDevice(context: Context): Boolean {
        return try {
            if (!isAdminActive(context)) {
                Log.e(TAG, "unlockDevice: admin not active")
                return false
            }
            // Store unlocked state — LockCheckWorker will stop showing LockScreenActivity
            KopanowPrefs.isLocked = false
            KopanowPrefs.lockReason = null
            KopanowPrefs.amountDue = null
            Log.i(TAG, "unlockDevice: lock state cleared")
            true
        } catch (e: Exception) {
            Log.e(TAG, "unlockDevice failed", e)
            false
        }
    }

    // ─── USB / ADB debugging ──────────────────────────────────────────────

    /**
     * Disable ADB / USB debugging via Device Policy.
     * Requires Device Owner permission on Android ≥ 9.
     * On non-Device Owner installs this logs a warning instead of crashing.
     */
    fun disableUsbDebugging(context: Context) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val dpm = dpm(context)
                val admin = adminComponent(context)
                if (dpm.isDeviceOwnerApp(context.packageName)) {
                    dpm.setGlobalSetting(admin, Settings.Global.ADB_ENABLED, "0")
                    Log.i(TAG, "disableUsbDebugging: ADB disabled via Device Owner")
                } else {
                    Log.w(TAG, "disableUsbDebugging: not Device Owner, skipping (MDM-lite mode)")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "disableUsbDebugging failed", e)
        }
    }

    // ─── Self-remove admin ────────────────────────────────────────────────

    /**
     * Remove Kopanow from device administrators.
     * Called on loan closure / full repayment.
     */
    fun removeDeviceAdmin(context: Context) {
        try {
            dpm(context).removeActiveAdmin(adminComponent(context))
            Log.i(TAG, "removeDeviceAdmin: admin removed")
        } catch (e: Exception) {
            Log.e(TAG, "removeDeviceAdmin failed", e)
        }
    }

    // ─── Device ID ────────────────────────────────────────────────────────

    /**
     * Returns a stable pseudo device ID.
     * Uses ANDROID_ID (unique per app-signing key + user since Android 8).
     * Falls back to Build fingerprint hash if ANDROID_ID is unavailable.
     */
    @SuppressLint("HardwareIds")
    fun getDeviceId(context: Context): String {
        val androidId = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ANDROID_ID
        )
        return if (!androidId.isNullOrBlank() && androidId != "9774d56d682e549c") {
            androidId
        } else {
            // Fallback: hash the build fingerprint
            Build.FINGERPRINT.hashCode().toString()
        }
    }
}
