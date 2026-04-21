package com.kopanow

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * KopanowPrefs — single source of truth for all persisted app state.
 *
 * Backed by EncryptedSharedPreferences (AES-256 via Android Keystore).
 */
object KopanowPrefs {

    private const val TAG = "KopanowPrefs"
    private const val PREFS_FILE = "kopanow_secure_prefs"

    // ── Keys ──────────────────────────────────────────────────────────────
    private const val KEY_BORROWER_ID   = "borrower_id"
    private const val KEY_LOAN_ID       = "loan_id"
    private const val KEY_PHONE_NUMBER  = "phone_number"
    private const val KEY_IS_ADMIN      = "is_admin"
    /** Set after first successful [KopanowApi.registerDevice] post–device-admin (full MDM enrollment). */
    private const val KEY_MDM_TAMPER_SHIELD_ARMED = "mdm_tamper_shield_armed"
    private const val KEY_IS_LOCKED     = "is_locked"
    private const val KEY_FCM_TOKEN     = "fcm_token"
    private const val KEY_LOCK_REASON   = "lock_reason"
    private const val KEY_AMOUNT_DUE    = "amount_due"
    private const val KEY_LOCK_TYPE     = "lock_type"
    private const val KEY_FRP_SEEDED    = "frp_seeded"
    private const val KEY_PASSCODE_HASH = "passcode_hash"
    private const val KEY_PASSCODE_LOCK = "passcode_locked"

    /** JSON array of [LoanInvoiceItem] for offline repayment alarms. */
    private const val KEY_REPAYMENT_INVOICES_JSON = "repayment_invoices_json"
    /** Comma-separated PendingIntent request codes for [RepaymentAlarmScheduler]. */
    private const val KEY_REPAYMENT_ALARM_CODES   = "repayment_alarm_req_codes"
    /** Last invoice we auto-PIN-locked locally (avoid duplicate). */
    private const val KEY_LOCAL_PIN_LOCK_INVOICE  = "local_pin_lock_invoice"

    // ── Registration / profile ───────────────────────────────────────────
    private const val KEY_FULL_NAME     = "full_name"
    private const val KEY_NATIONAL_ID   = "national_id"
    private const val KEY_REGION        = "region"
    private const val KEY_ADDRESS       = "address"

    // ── Loan request ─────────────────────────────────────────────────────
    private const val KEY_LOAN_REQ_AMOUNT  = "loan_req_amount"
    private const val KEY_LOAN_REQ_TENOR   = "loan_req_tenor"
    private const val KEY_LOAN_REQ_MONTHS  = "loan_req_months"
    private const val KEY_LOAN_REQ_PURPOSE = "loan_req_purpose"
    private const val KEY_LOAN_REQ_DONE    = "loan_req_done"
    private const val KEY_ONBOARDING_COMPLETED = "onboarding_completed"

    private var prefs: SharedPreferences? = null

    /**
     * Call once from Application.onCreate() before any other usage.
     */
    fun init(context: Context) {
        if (prefs != null) return

        try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            prefs = EncryptedSharedPreferences.create(
                context,
                PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            Log.i(TAG, "init: Secure preferences initialised")
        } catch (e: Exception) {
            Log.e(TAG, "init: Failed to initialize EncryptedSharedPreferences", e)
            prefs = context.getSharedPreferences(PREFS_FILE + "_fallback", Context.MODE_PRIVATE)
        }
    }

    private fun getPrefs(): SharedPreferences {
        return prefs ?: throw IllegalStateException("KopanowPrefs not initialised. Call init(context) first.")
    }

    var borrowerId: String?
        get() = getPrefs().getString(KEY_BORROWER_ID, null)
        set(value) = getPrefs().edit().putString(KEY_BORROWER_ID, value).apply()

    var loanId: String?
        get() = getPrefs().getString(KEY_LOAN_ID, null)
        set(value) = getPrefs().edit().putString(KEY_LOAN_ID, value).apply()

    var phoneNumber: String?
        get() = getPrefs().getString(KEY_PHONE_NUMBER, null)
        set(value) = getPrefs().edit().putString(KEY_PHONE_NUMBER, value).apply()

    var fullName: String?
        get() = getPrefs().getString(KEY_FULL_NAME, null)
        set(value) = getPrefs().edit().putString(KEY_FULL_NAME, value).apply()

    var nationalId: String?
        get() = getPrefs().getString(KEY_NATIONAL_ID, null)
        set(value) = getPrefs().edit().putString(KEY_NATIONAL_ID, value).apply()

    var region: String?
        get() = getPrefs().getString(KEY_REGION, null)
        set(value) = getPrefs().edit().putString(KEY_REGION, value).apply()

    var address: String?
        get() = getPrefs().getString(KEY_ADDRESS, null)
        set(value) = getPrefs().edit().putString(KEY_ADDRESS, value).apply()

    var requestedLoanAmountTzs: Long
        get() = getPrefs().getLong(KEY_LOAN_REQ_AMOUNT, 0L)
        set(value) = getPrefs().edit().putLong(KEY_LOAN_REQ_AMOUNT, value).apply()

    var requestedLoanTenorDays: Int
        get() = getPrefs().getInt(KEY_LOAN_REQ_TENOR, 0)
        set(value) = getPrefs().edit().putInt(KEY_LOAN_REQ_TENOR, value).apply()

    /** 1–3 months repayment term (weekly schedule on server). */
    var requestedLoanRepaymentMonths: Int
        get() = getPrefs().getInt(KEY_LOAN_REQ_MONTHS, 0)
        set(value) = getPrefs().edit().putInt(KEY_LOAN_REQ_MONTHS, value).apply()

    var requestedLoanPurpose: String?
        get() = getPrefs().getString(KEY_LOAN_REQ_PURPOSE, null)
        set(value) = getPrefs().edit().putString(KEY_LOAN_REQ_PURPOSE, value).apply()

    var isLoanRequestSubmitted: Boolean
        get() = getPrefs().getBoolean(KEY_LOAN_REQ_DONE, false)
        set(value) = getPrefs().edit().putBoolean(KEY_LOAN_REQ_DONE, value).apply()

    var isAdmin: Boolean
        get() = getPrefs().getBoolean(KEY_IS_ADMIN, false)
        set(value) = getPrefs().edit().putBoolean(KEY_IS_ADMIN, value).apply()

    /**
     * True after device admin is active **and** the device has completed first-time server registration
     * (`registerDevice`). The accessibility tamper shield requires this so enrollment flows (Settings,
     * device-admin wizard, accessibility toggle) do not trigger a lock before MDM is fully live.
     */
    var mdmTamperShieldArmed: Boolean
        get() = getPrefs().getBoolean(KEY_MDM_TAMPER_SHIELD_ARMED, false)
        set(value) = getPrefs().edit().putBoolean(KEY_MDM_TAMPER_SHIELD_ARMED, value).apply()

    /** True after borrower finishes all required phone-protection steps (self-service onboarding complete). */
    var onboardingCompleted: Boolean
        get() = getPrefs().getBoolean(KEY_ONBOARDING_COMPLETED, false)
        set(value) = getPrefs().edit().putBoolean(KEY_ONBOARDING_COMPLETED, value).apply()

    var isLocked: Boolean
        get() = getPrefs().getBoolean(KEY_IS_LOCKED, false)
        set(value) = getPrefs().edit().putBoolean(KEY_IS_LOCKED, value).apply()

    var lockReason: String?
        get() = getPrefs().getString(KEY_LOCK_REASON, null)
        set(value) = getPrefs().edit().putString(KEY_LOCK_REASON, value).apply()

    var amountDue: String?
        get() = getPrefs().getString(KEY_AMOUNT_DUE, null)
        set(value) = getPrefs().edit().putString(KEY_AMOUNT_DUE, value).apply()

    var fcmToken: String?
        get() = getPrefs().getString(KEY_FCM_TOKEN, null)
        set(value) = getPrefs().edit().putString(KEY_FCM_TOKEN, value).apply()

    /** True when the Kopanow Google account has been seeded on this device (FRP protection active). */
    var frpSeeded: Boolean
        get() = getPrefs().getBoolean(KEY_FRP_SEEDED, false)
        set(value) = getPrefs().edit().putBoolean(KEY_FRP_SEEDED, value).apply()

    // ── Passcode (PIN) ───────────────────────────────────────────────────────
    /** SHA-256 hash of the admin-issued PIN. Null when no passcode is active. */
    var passcodeHash: String?
        get() = getPrefs().getString(KEY_PASSCODE_HASH, null)
        set(value) = getPrefs().edit().putString(KEY_PASSCODE_HASH, value).apply()

    /** True while a PIN is actively enforced on the lock screen. */
    var isPasscodeLocked: Boolean
        get() = getPrefs().getBoolean(KEY_PASSCODE_LOCK, false)
        set(value) = getPrefs().edit().putBoolean(KEY_PASSCODE_LOCK, value).apply()

    // ── Lock types ────────────────────────────────────────────────────────────
    const val LOCK_TYPE_PAYMENT = "PAYMENT"   // unlockable by STK push
    const val LOCK_TYPE_TAMPER  = "TAMPER"    // admin-only / payment unlock only

    var lockType: String?
        get() = getPrefs().getString(KEY_LOCK_TYPE, LOCK_TYPE_PAYMENT)
        set(value) = getPrefs().edit().putString(KEY_LOCK_TYPE, value).apply()

    val isTamperLock: Boolean get() = lockType == LOCK_TYPE_TAMPER

    /**
     * True while any client-side lock UX is active (payment / tamper / passcode).
     * Sent as [HeartbeatRequest.appLockActive] so the server does not clear `is_locked` while local
     * tamper is active (same idea as [HeartbeatLockSync] + PIN session).
     */
    val appLockActiveForBackend: Boolean
        get() = isLocked || isPasscodeLocked || isTamperLock

    val hasSession: Boolean
        get() = borrowerId != null && loanId != null

    /**
     * True while MDM protections should apply: device admin is (or was expected to be) active,
     * or there is an active loan session. The accessibility tamper shield instead checks
     * runtime device-admin active (see accessibility service) so pre-enrollment Settings navigation
     * does not trigger a lock.
     */
    val isMdmProtectionActive: Boolean
        get() = isAdmin || hasSession

    var repaymentInvoicesJson: String?
        get() = getPrefs().getString(KEY_REPAYMENT_INVOICES_JSON, null)
        set(value) = getPrefs().edit().putString(KEY_REPAYMENT_INVOICES_JSON, value).apply()

    var repaymentAlarmRequestCodes: String?
        get() = getPrefs().getString(KEY_REPAYMENT_ALARM_CODES, null)
        set(value) = getPrefs().edit().putString(KEY_REPAYMENT_ALARM_CODES, value).apply()

    var localPinLockInvoiceNumber: String?
        get() = getPrefs().getString(KEY_LOCAL_PIN_LOCK_INVOICE, null)
        set(value) = getPrefs().edit().putString(KEY_LOCAL_PIN_LOCK_INVOICE, value).apply()

    fun clear() = getPrefs().edit().clear().apply()

    fun isInitialised(): Boolean = prefs != null
}
