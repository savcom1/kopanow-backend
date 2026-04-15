package com.kopanow

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * KopanowLauncherActivity — MDM Lite default launcher intercept.
 *
 * Registered with CATEGORY_HOME + CATEGORY_DEFAULT so Android treats Kopanow
 * as a launcher candidate. During onboarding, the app prompts the borrower to
 * set this as the default launcher.
 *
 * Effect: every time the borrower presses the HOME button:
 *   • If device is LOCKED   → LockScreenActivity is shown (can't escape)
 *   • If device is UNLOCKED → MainActivity is shown normally
 *
 * This makes the Home button act as an additional lock barrier — the borrower
 * can never reach the Android home screen while locked.
 */
class KopanowLauncherActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        route()
    }

    override fun onResume() {
        super.onResume()
        route()   // Re-check on every resume (handles multi-tasking back press)
    }

    private fun route() {
        if (KopanowPrefs.isLocked || KopanowPrefs.isPasscodeLocked) {
            startActivity(Intent(this, LockScreenActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            })
        } else if (KopanowPrefs.hasSession) {
            startActivity(Intent(this, MainActivity::class.java))
        }
        // If no session (un-enrolled phone) just finish — fall back to Android chooser
        finish()
    }
}
