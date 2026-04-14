package com.kopanow

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.util.Log

/**
 * FRPManager — Google Account Factory Reset Protection (FRP) seeding.
 *
 * ## What this does
 * During enrollment Kopanow adds its own Google account to the borrower's phone.
 * If the borrower performs a factory reset to escape the MDM, Android's built-in
 * FRP screen requires the credentials of that Google account before the phone can
 * be set up again. Since only Kopanow knows the password, the phone is effectively
 * a brick until the loan is repaid.
 *
 * This is the same technique used by M-Kopa, Watu Credit, and Aspire.
 */
class FRPManager(private val context: Context) {

    companion object {
        private const val TAG = "KopanowFRP"

        /** Your company Google account — created once, used across ALL enrolled devices. */
        const val KOPANOW_ACCOUNT_EMAIL = "castorjoseph009@gmail.com"
        const val KOPANOW_ACCOUNT_TYPE  = "com.google"

        /** Request code for the Google sign-in intent launched by [promptAccountSignIn]. */
        const val REQUEST_CODE_ADD_ACCOUNT = 2001
    }

    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private val adminComponent: ComponentName =
        ComponentName(context, KopanowAdminReceiver::class.java)

    private val accountManager: AccountManager = AccountManager.get(context)

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1 — Prompt borrower to sign into the Kopanow Google account
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Launches the standard Android "Add Google Account" dialog.
     */
    fun promptAccountSignIn(activity: Activity) {
        try {
            // Launch the Google sign-in flow. Result arrives in
            // Activity.onActivityResult(REQUEST_CODE_ADD_ACCOUNT).
            accountManager.addAccount(
                KOPANOW_ACCOUNT_TYPE,             // "com.google"
                "oauth2:email profile",           // desired auth token type
                null,                             // required features
                Bundle().apply {
                    // Pre-fill the email so the borrower just enters the password
                    putString("authAccount", KOPANOW_ACCOUNT_EMAIL)
                    putBoolean("allowSkip", false)
                },
                activity,
                null,   // callback — result handled via onActivityResult
                null
            )
            Log.i(TAG, "promptAccountSignIn: Google account sign-in initiated")
        } catch (e: Exception) {
            Log.e(TAG, "promptAccountSignIn failed: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1b — Direct account seeding via auth token (Device Owner only)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Programmatically adds the Kopanow Google account using an OAuth token.
     */
    fun seedAccount(authToken: String, loanId: String): Boolean {
        return try {
            val account = Account(KOPANOW_ACCOUNT_EMAIL, KOPANOW_ACCOUNT_TYPE)

            // Skip if already seeded (re-enrollment)
            if (isAccountSeeded()) {
                Log.d(TAG, "seedAccount: Kopanow account already present — locking removal")
                lockAccountRemoval()
                return true
            }

            val added = accountManager.addAccountExplicitly(
                account,
                null, // password not stored, uses token
                Bundle().apply {
                    putString("kopanow_loan_id",   loanId)
                    putString("kopanow_protected", "true")
                }
            )

            if (added) {
                accountManager.setAuthToken(
                    account,
                    "oauth2:email profile",
                    authToken
                )
                lockAccountRemoval()
                Log.i(TAG, "seedAccount: Kopanow FRP account seeded successfully")
            }

            added
        } catch (e: Exception) {
            Log.e(TAG, "seedAccount failed: ${e.message}")
            false
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2 — Lock the account so the borrower cannot remove it from Settings
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Prevents the borrower from removing the Kopanow Google account.
     */
    fun lockAccountRemoval() {
        try {
            if (!dpm.isAdminActive(adminComponent)) {
                Log.w(TAG, "lockAccountRemoval: Device Admin not active — cannot lock")
                return
            }
            dpm.setAccountManagementDisabled(
                adminComponent,
                KOPANOW_ACCOUNT_TYPE,
                true
            )
            KopanowPrefs.frpSeeded = true
            Log.i(TAG, "lockAccountRemoval: account removal LOCKED")
        } catch (e: Exception) {
            Log.e(TAG, "lockAccountRemoval failed: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3 — Remove the account when loan is fully repaid
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Unlocks account management and removes the Kopanow Google account.
     */
    fun removeAccount(): Boolean {
        return try {
            if (dpm.isAdminActive(adminComponent)) {
                dpm.setAccountManagementDisabled(adminComponent, KOPANOW_ACCOUNT_TYPE, false)
            }

            val account = accountManager
                .getAccountsByType(KOPANOW_ACCOUNT_TYPE)
                .firstOrNull { it.name.equals(KOPANOW_ACCOUNT_EMAIL, ignoreCase = true) }

            if (account != null) {
                val removed = accountManager.removeAccountExplicitly(account)
                Log.i(TAG, "removeAccount: Kopanow account removed = $removed")
                KopanowPrefs.frpSeeded = false
                removed
            } else {
                KopanowPrefs.frpSeeded = false
                true
            }
        } catch (e: Exception) {
            Log.e(TAG, "removeAccount failed: ${e.message}")
            false
        }
    }

    /** Returns true if the Kopanow Google account is currently on this device. */
    fun isAccountSeeded(): Boolean =
        accountManager
            .getAccountsByType(KOPANOW_ACCOUNT_TYPE)
            .any { it.name.equals(KOPANOW_ACCOUNT_EMAIL, ignoreCase = true) }
}
