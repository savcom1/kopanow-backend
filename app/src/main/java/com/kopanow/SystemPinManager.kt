package com.kopanow

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * SystemPinManager
 *
 * Sets and clears the device's REAL system lockscreen PIN using the
 * Device Owner API [DevicePolicyManager.resetPasswordWithToken].
 *
 * ## Why token-based reset?
 * [DevicePolicyManager.resetPassword] is deprecated on Android 8+ and throws
 * a [SecurityException] when called while the screen is locked (which is exactly
 * when we need it).  The token-based API [resetPasswordWithToken] lets us apply
 * a new PIN at any time — even when the device is locked — as long as we set
 * the token in advance while the device was last unlocked.
 *
 * ## Flow
 *  1. **Enrollment** → [initResetToken] called once.  Token stored in encrypted prefs.
 *     Token becomes "active" automatically the next time the user unlocks the device.
 *  2. **Admin locks** → FCM `SET_SYSTEM_PIN` received → [activateSystemPin] generates
 *     a random 6-digit PIN, calls [resetPasswordWithToken], calls [lockNow].
 *     PIN reported to the backend so admin can read it to the borrower.
 *  3. **Admin unlocks** → FCM `CLEAR_SYSTEM_PIN` received → [clearSystemPin] sets
 *     empty password via [resetPasswordWithToken], clears stored PIN.
 */
object SystemPinManager {

    private const val TAG               = "SystemPinManager"
    private const val PREFS_FILE        = "kopanow_system_pin"
    private const val KEY_RESET_TOKEN   = "reset_token"
    private const val KEY_ACTIVE_PIN    = "active_pin"          // stored only until reported
    private const val PIN_DIGITS        = 6

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Token initialisation (call once at enrollment / on first boot post-admin)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generate and register a password-reset token with DevicePolicyManager.
     *
     * Must be called WHILE THE DEVICE IS UNLOCKED (e.g. from [HeartbeatWorker]
     * when [DevicePolicyManager.isDeviceOwnerApp] is true and no token exists yet).
     *
     * The token becomes "active" (usable for password reset) automatically
     * once the user unlocks the device.  After that, [activateSystemPin] and
     * [clearSystemPin] can be called at any time.
     *
     * @return true if the token was successfully set.
     */
    /**
     * Returns true if this app is the Device Owner.
     * [resetPasswordWithToken] and [setResetPasswordToken] REQUIRE Device Owner.
     * Device Admin alone is NOT sufficient.
     *
     * To enrol as Device Owner (one-time adb command before any accounts are added):
     *   adb shell dpm set-device-owner com.kopanow/.KopanowAdminReceiver
     */
    fun isDeviceOwner(context: Context): Boolean =
        dpm(context).isDeviceOwnerApp(context.packageName)

    fun initResetToken(context: Context): Boolean {
        val dpm   = dpm(context)
        val admin = adminComponent(context)

        // MUST be Device Owner — Device Admin alone cannot call setResetPasswordToken()
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            Log.e(TAG, "initResetToken: *** NOT a Device Owner *** — " +
                    "run: adb shell dpm set-device-owner com.kopanow/.KopanowAdminReceiver")
            return false
        }

        // Generate 32-byte cryptographically random token (Android requirement: ≥ 32 bytes)
        val token = ByteArray(32)
        SecureRandom().nextBytes(token)

        return try {
            val success = dpm.setResetPasswordToken(admin, token)
            if (success) {
                prefs(context).edit().putString(KEY_RESET_TOKEN, token.toHex()).apply()
                Log.i(TAG, "initResetToken: token set ✓")
            } else {
                Log.w(TAG, "initResetToken: setResetPasswordToken returned false — " +
                        "token may already be active or a password quality policy is blocking it")
            }
            success
        } catch (e: SecurityException) {
            Log.e(TAG, "initResetToken: SecurityException — requires Device Owner: ${e.message}")
            false
        } catch (e: Exception) {
            Log.e(TAG, "initResetToken: ${e.message}")
            false
        }
    }

    /** Returns true if a reset token has been stored locally. */
    fun hasToken(context: Context): Boolean =
        prefs(context).getString(KEY_RESET_TOKEN, null) != null

    /** Returns true if the stored token is currently active (device was unlocked since token was set). */
    fun isTokenActive(context: Context): Boolean {
        val dpm   = dpm(context)
        val admin = adminComponent(context)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                dpm.isResetPasswordTokenActive(admin)
            } else false
        } catch (e: Exception) { false }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. LOCK — set a random system PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generate a random [PIN_DIGITS]-digit PIN, set it as the device screen-lock
     * password via [DevicePolicyManager.resetPasswordWithToken], then call
     * [DevicePolicyManager.lockNow] to activate the system lockscreen immediately.
     *
     * The device is now locked and can ONLY be unlocked by entering the PIN on the
     * standard Android lockscreen — no custom UI needed.
     *
     * @param context  Application or service context.
     * @param onPinGenerated  Callback with the plain PIN, used to report it to the
     *                        backend so the admin can read it to the borrower.
     *                        Called on the calling thread.
     * @return true if the system PIN was set successfully.
     */
    fun activateSystemPin(
        context:        Context,
        onPinGenerated: (pin: String) -> Unit = {}
    ): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return activateSystemPinLegacy(context, onPinGenerated)
        }

        val dpm   = dpm(context)
        val admin = adminComponent(context)

        // resetPasswordWithToken() REQUIRES Device Owner — not just Device Admin
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            Log.e(TAG, "activateSystemPin: *** NOT a Device Owner *** — system PIN cannot be set. " +
                    "Enrol as DO first: adb shell dpm set-device-owner com.kopanow/.KopanowAdminReceiver")
            return false
        }

        val tokenHex = prefs(context).getString(KEY_RESET_TOKEN, null)
        if (tokenHex == null) {
            Log.e(TAG, "activateSystemPin: no reset token — call initResetToken first")
            // Fallback: try to init token right now (only works if device is unlocked)
            if (!initResetToken(context)) return false
            return activateSystemPin(context, onPinGenerated) // retry once
        }

        if (!dpm.isResetPasswordTokenActive(admin)) {
            Log.e(TAG, "activateSystemPin: token not yet active — device hasn't been unlocked since token was set")
            return false
        }

        val pin   = generatePin()
        val token = tokenHex.hexToBytes()

        return try {
            val flags = DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY
            val ok = dpm.resetPasswordWithToken(admin, pin, token, flags)
            if (ok) {
                // Persist PIN temporarily (so it can be re-reported if the API call fails)
                prefs(context).edit().putString(KEY_ACTIVE_PIN, pin).apply()
                onPinGenerated(pin)
                dpm.lockNow()
                Log.i(TAG, "activateSystemPin: system PIN set + device locked ✓")
            } else {
                Log.e(TAG, "activateSystemPin: resetPasswordWithToken returned false")
            }
            ok
        } catch (e: SecurityException) {
            Log.e(TAG, "activateSystemPin: SecurityException — ${e.message}")
            false
        } catch (e: Exception) {
            Log.e(TAG, "activateSystemPin: ${e.message}")
            false
        }
    }

    /**
     * Fallback for Android ≤ 7 (API < 26) — uses the deprecated [resetPassword].
     * Works reliably on older devices where Kopanow has Device Admin.
     */
    @Suppress("DEPRECATION")
    private fun activateSystemPinLegacy(
        context:        Context,
        onPinGenerated: (pin: String) -> Unit
    ): Boolean {
        val dpm   = dpm(context)
        val admin = adminComponent(context)
        if (!dpm.isAdminActive(admin)) return false
        val pin = generatePin()
        return try {
            val flags = DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY or
                        DevicePolicyManager.RESET_PASSWORD_DO_NOT_ASK_CREDENTIALS_ON_BOOT
            dpm.resetPassword(pin, flags)
            prefs(context).edit().putString(KEY_ACTIVE_PIN, pin).apply()
            onPinGenerated(pin)
            dpm.lockNow()
            Log.i(TAG, "activateSystemPinLegacy: system PIN set ✓")
            true
        } catch (e: Exception) {
            Log.e(TAG, "activateSystemPinLegacy: ${e.message}")
            false
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. UNLOCK — clear the system PIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Remove the Kopanow-set system PIN.
     *
     * After this call the device returns to having no lockscreen password
     * (the borrower's own pattern/biometric is NOT affected — this only removes
     * a Kopanow-set PIN because that is what we wrote with [activateSystemPin]).
     *
     * Note: if the borrower had their own PIN before Kopanow set one, it is
     * overwritten and cannot be restored here.  Document this in the loan T&C.
     */
    fun clearSystemPin(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return clearSystemPinLegacy(context)
        }

        val dpm   = dpm(context)
        val admin = adminComponent(context)

        // resetPasswordWithToken() REQUIRES Device Owner
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            Log.w(TAG, "clearSystemPin: not Device Owner — cannot clear system PIN via token"); return false
        }

        val tokenHex = prefs(context).getString(KEY_RESET_TOKEN, null)
        if (tokenHex == null) {
            Log.e(TAG, "clearSystemPin: no token stored"); return false
        }

        return try {
            val ok = dpm.resetPasswordWithToken(admin, "", tokenHex.hexToBytes(), 0)
            if (ok) {
                prefs(context).edit().remove(KEY_ACTIVE_PIN).apply()
                Log.i(TAG, "clearSystemPin: system PIN removed ✓")
            }
            ok
        } catch (e: Exception) {
            Log.e(TAG, "clearSystemPin: ${e.message}")
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun clearSystemPinLegacy(context: Context): Boolean {
        val dpm   = dpm(context)
        val admin = adminComponent(context)
        return try {
            dpm.resetPassword("", 0)
            prefs(context).edit().remove(KEY_ACTIVE_PIN).apply()
            Log.i(TAG, "clearSystemPinLegacy: cleared ✓")
            true
        } catch (e: Exception) {
            Log.e(TAG, "clearSystemPinLegacy: ${e.message}"); false
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Report stored PIN (in case first API call failed)
    // ─────────────────────────────────────────────────────────────────────────

    /** Return the currently active PIN if it's still in local storage (not yet reported). */
    fun getPendingPin(context: Context): String? =
        prefs(context).getString(KEY_ACTIVE_PIN, null)

    /** Call once the PIN has been successfully reported to the backend. */
    fun clearPendingPin(context: Context) =
        prefs(context).edit().remove(KEY_ACTIVE_PIN).apply()

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private fun generatePin(): String {
        // SecureRandom — cryptographically safe, not guessable
        val rng = SecureRandom()
        // Ensure first digit is never 0 (some devices reject leading-zero PINs)
        val first = 1 + rng.nextInt(9)
        val rest  = (1 until PIN_DIGITS).map { rng.nextInt(10) }.joinToString("")
        return "$first$rest"
    }

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private fun adminComponent(context: Context) =
        ComponentName(context, KopanowAdminReceiver::class.java)

    private fun prefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context, PREFS_FILE, masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            // Encrypted prefs unavailable — fall back to plain SharedPreferences
            Log.w(TAG, "prefs: falling back to plain SharedPreferences — ${e.message}")
            context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        }
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun String.hexToBytes(): ByteArray {
        check(length % 2 == 0) { "Hex string must have even length" }
        return ByteArray(length / 2) { i -> Integer.parseInt(substring(i * 2, i * 2 + 2), 16).toByte() }
    }
}
