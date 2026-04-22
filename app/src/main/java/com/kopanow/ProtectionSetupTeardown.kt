package com.kopanow

import android.content.Context
import android.util.Log
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * One-hour protection-setup timeout: remove device admin and release local MDM state when the borrower
 * does not complete required checklist steps in time.
 */
object ProtectionSetupTeardown {

    private const val TAG = "ProtectionSetupTeardown"
    private val mutex = Mutex()

    /**
     * Idempotent: safe to call from worker or UI backup path.
     */
    suspend fun run(context: Context) {
        val app = context.applicationContext
        KopanowPrefs.init(app)

        mutex.withLock {
            if (KopanowPrefs.onboardingCompleted) {
                Log.d(TAG, "skip: onboarding already completed")
                return
            }
            if (KopanowPrefs.protectionSetupTimedOut) {
                Log.d(TAG, "skip: already timed out")
                return
            }

            val p = MdmComplianceCollector.collect(app)
            val adminOn = DeviceSecurityManager.isAdminActive(app)
            if (p.allRequiredOk && adminOn) {
                Log.d(TAG, "skip: all required checks OK")
                return
            }
        }

        Log.w(TAG, "Running protection setup timeout teardown")

        withContext(Dispatchers.Main) {
            FcmPinManager.handleClearSystemPin(app)
        }

        if (DeviceSecurityManager.isAdminActive(app)) {
            DeviceSecurityManager.removeDeviceAdmin(app)
        }

        val bid = KopanowPrefs.borrowerId
        val lid = KopanowPrefs.loanId
        withContext(Dispatchers.IO) {
            if (bid != null && lid != null) {
                // Backend allows only: registered, active, locked, admin_removed, suspended
                KopanowApi.updateStatus(bid, lid, "suspended")
            }
            RepaymentAlarmScheduler.cancelAll(app)
        }
        HeartbeatScheduler.cancel(app)

        KopanowPrefs.mdmTamperShieldArmed = false
        KopanowPrefs.isAdmin = false
        KopanowPrefs.onboardingCompleted = false
        KopanowPrefs.isLocked = false
        KopanowPrefs.lockReason = null
        KopanowPrefs.amountDue = null
        KopanowPrefs.passcodeHash = null
        KopanowPrefs.isPasscodeLocked = false
        KopanowPrefs.lockType = KopanowPrefs.LOCK_TYPE_PAYMENT
        KopanowPrefs.a11yGraceUntilMs = 0L
        KopanowPrefs.tamperEnforceAfterMs = 0L
        KopanowPrefs.protectionSetupDeadlineMs = 0L
        KopanowPrefs.protectionSetupTimedOut = true

        WorkManager.getInstance(app).cancelUniqueWork(ProtectionSetupTimeoutScheduler.UNIQUE_WORK)

        Log.i(TAG, "Teardown complete — admin removed or was inactive, prefs updated")
    }
}
