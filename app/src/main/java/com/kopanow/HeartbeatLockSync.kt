package com.kopanow

/**
 * Heartbeat returns [HeartbeatResponse.locked] from the DB, which can briefly lag behind a just-applied
 * [SET_SYSTEM_PIN] / local PIN. Syncing `locked=false` in that window called [DeviceSecurityManager.unlockDevice]
 * and cleared the passcode — [LockScreenActivity] opened then immediately dismissed.
 */
object HeartbeatLockSync {

    fun applyLockFieldsFromResponse(response: HeartbeatResponse) {
        val pinActive = PasscodeManager.hasActivePasscode()
        KopanowPrefs.isLocked = response.locked || pinActive
        if (response.locked) {
            response.lockReason?.let { KopanowPrefs.lockReason = it }
            response.amountDue?.let { KopanowPrefs.amountDue = it }
        } else if (!pinActive) {
            KopanowPrefs.lockReason = response.lockReason
            KopanowPrefs.amountDue = response.amountDue
        }
    }

    /** Only clear local lock when server and device agree there is no PIN session. */
    fun shouldApplyPassiveUnlock(response: HeartbeatResponse): Boolean =
        !response.locked && !PasscodeManager.hasActivePasscode()
}
