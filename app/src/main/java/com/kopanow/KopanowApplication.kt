package com.kopanow

import android.app.Application
import android.util.Log

/**
 * KopanowApplication — Global application state and initialisation.
 */
class KopanowApplication : Application() {

    companion object {
        private const val TAG = "KopanowApplication"
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate: Initialising Kopanow application context")

        // Initialize secure preferences singleton first — must be before anything else
        KopanowPrefs.init(this)

        // Start the persistent foreground watchdog on every process start.
        // This covers: app launch, WorkManager wake, FCM wake, and boot.
        // The service is START_STICKY + self-restarts via AlarmManager, so
        // calling start() here is safe and idempotent.
        if (KopanowPrefs.hasSession) {
            KopanowLockService.start(this)
            Log.i(TAG, "KopanowLockService started from Application")
        }
    }
}

