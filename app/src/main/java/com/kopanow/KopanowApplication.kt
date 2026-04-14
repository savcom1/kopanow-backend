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

        // Initialize secure preferences singleton
        KopanowPrefs.init(this)
    }
}
