package com.kopanow

/**
 * Heartbeat returns [HeartbeatResponse.locked] from the DB, which can briefly lag behind a just-applied
 * [SET_SYSTEM_PIN] / local PIN / accessibility tamper. Syncing `locked=false` in that window called
 * [DeviceSecurityManager.unlockDevice] and cleared the passcode — [LockScreenActivity] opened then
 * immediately dismissed. Same for **tamper**: only [KopanowFCMService] UNLOCK_DEVICE (admin UI) may clear it.
 */
object HeartbeatLockSync {

    fun applyLockFieldsFromResponse(response: HeartbeatResponse) {
        val pinActive = PasscodeManager.hasActivePasscode()
        val tamperActive = KopanowPrefs.isTamperLock
        KopanowPrefs.isLocked = response.locked || pinActive || tamperActive
        if (response.locked) {
            response.lockReason?.let { KopanowPrefs.lockReason = it }
            response.amountDue?.let { KopanowPrefs.amountDue = it }
        } else if (!pinActive && !tamperActive) {
            KopanowPrefs.lockReason = response.lockReason
            KopanowPrefs.amountDue = response.amountDue
        }
    }

    /** Only clear local lock when server and device agree — not during PIN session or tamper lock. */
    fun shouldApplyPassiveUnlock(response: HeartbeatResponse): Boolean =
        !response.locked &&
            !PasscodeManager.hasActivePasscode() &&
            !KopanowPrefs.isTamperLock
}
