package com.kopanow

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import java.security.MessageDigest

/**
 * PasscodeManager — Kopanow app-level PIN engine.
 *
 * ## How it works
 * When a customer misses a payment the backend sends a SET_PASSCODE FCM command
 * containing a randomly generated 6-digit PIN.  [FcmPinManager] receives the
 * command and calls [setPasscode].  The PIN is SHA-256 hashed and stored in
 * [KopanowPrefs] (EncryptedSharedPreferences).  The raw PIN is NEVER stored on
 * the device.
 *
 * The [LockScreenActivity] then shows a PIN keypad.  The borrower can only
 * dismiss the lock screen by entering the correct PIN (obtained from Kopanow
 * support) or by the admin sending a CLEAR_PASSCODE / UNLOCK_DEVICE command.
 *
 * ## System PIN (best-effort)
 * [trySetSystemPassword] additionally attempts to set the device screen-lock PIN
 * via [DevicePolicyManager.resetPassword].  This API is deprecated on Android 8+
 * and only succeeds when:
 *   - Kopanow has active Device Admin, AND
 *   - the device does not already have a password set (or DPM can reset it).
 * It is always wrapped in try/catch so failure is non-fatal — the app-level
 * PIN keypad remains the primary enforcement mechanism.
 */
object PasscodeManager {

    private const val TAG = "PasscodeManager"

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Activate passcode mode with [pin].
     *
     * - Stores SHA-256([pin]) in encrypted prefs.
     * - Sets [KopanowPrefs.isPasscodeLocked] = true.
     * - Attempts to apply the same PIN at the system level (best-effort).
     *
     * @return true — always succeeds for the app-level lock.  System-level may fail silently.
     */
    fun setPasscode(context: Context, pin: String): Boolean {
        val hash = sha256(pin)
        KopanowPrefs.passcodeHash     = hash
        KopanowPrefs.isPasscodeLocked = true
        Log.i(TAG, "setPasscode: passcode activated (hash stored, raw PIN discarded)")

        // Best-effort: also lock the system screen-lock with the same PIN
        trySetSystemPassword(context, pin)
        return true
    }

    /**
     * Validate a PIN entered by the borrower.
     *
     * @param input  Raw string the borrower typed on the keypad.
     * @return true if [input] matches the stored PIN (via hash comparison).
     */
    fun validatePasscode(input: String): Boolean {
        val stored = KopanowPrefs.passcodeHash ?: return false
        val result = sha256(input) == stored
        Log.d(TAG, "validatePasscode: ${if (result) "CORRECT" else "WRONG"}")
        return result
    }

    /**
     * Deactivate passcode mode.
     *
     * Clears the stored hash and the [KopanowPrefs.isPasscodeLocked] flag.
     * Called when admin sends CLEAR_PASSCODE, or on full loan repayment.
     */
    fun clearPasscode(context: Context) {
        KopanowPrefs.passcodeHash     = null
        KopanowPrefs.isPasscodeLocked = false
        Log.i(TAG, "clearPasscode: passcode mode deactivated")

        // Clear the system screen-lock password if we set it
        trySetSystemPassword(context, "")
    }

    /** Returns true when a PIN has been set and is currently enforced. */
    fun hasActivePasscode(): Boolean =
        KopanowPrefs.isPasscodeLocked && !KopanowPrefs.passcodeHash.isNullOrEmpty()

    // ─── System-level PIN (best-effort, deprecated API) ──────────────────────

    /**
     * Attempt to set the device screen-lock PIN via [DevicePolicyManager].
     *
     * This is strictly best-effort:
     *  - Works reliably on Android ≤ 7 with Device Admin.
     *  - On Android 8+ it is deprecated and may throw [SecurityException].
     *  - Passing an empty string attempts to CLEAR the system password.
     *
     * Failure is silently caught — the app-level keypad is the primary lock.
     */
    @Suppress("DEPRECATION")
    fun trySetSystemPassword(context: Context, pin: String) {
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = ComponentName(context, KopanowAdminReceiver::class.java)
            if (!dpm.isAdminActive(admin)) {
                Log.w(TAG, "trySetSystemPassword: Device Admin not active — skipping")
                return
            }

            if (pin.isEmpty()) {
                // Attempt to clear — only works if no current password or we set it
                dpm.resetPassword("", DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY)
                Log.i(TAG, "trySetSystemPassword: system password cleared")
            } else {
                val flags = DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY or
                            DevicePolicyManager.RESET_PASSWORD_DO_NOT_ASK_CREDENTIALS_ON_BOOT
                dpm.resetPassword(pin, flags)
                Log.i(TAG, "trySetSystemPassword: system password set to PIN")
            }
        } catch (se: SecurityException) {
            Log.w(TAG, "trySetSystemPassword: SecurityException (Android 8+ restriction) — ${se.message}")
        } catch (e: Exception) {
            Log.w(TAG, "trySetSystemPassword: ${e.message}")
        }
    }

    // ─── Hashing ─────────────────────────────────────────────────────────────

    private fun sha256(input: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
