package com.kopanow

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.ImageViewCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * MainActivity — application entry point.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PREF_FIRST_RUN_DONE = "first_run_done"
    }

    private val activityJob   = SupervisorJob()
    private val activityScope = CoroutineScope(Dispatchers.IO + activityJob)

    // ── Activity Result Launcher (replaces deprecated onActivityResult) ────────
    private val adminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result: ActivityResult ->
        if (result.resultCode == Activity.RESULT_OK) onAdminGranted() else onAdminDenied()
    }

    private lateinit var cardEnrollment: MaterialCardView
    private lateinit var cardDashboard: MaterialCardView
    private lateinit var tvWelcome: TextView
    private lateinit var tvStatus: TextView
    private lateinit var btnEnroll: MaterialButton
    private lateinit var btnPayNow: MaterialButton
    private lateinit var tvLoanBalance: TextView
    private lateinit var tvNextDue: TextView
    private lateinit var tvStatusBadge: TextView
    
    private lateinit var tvProtectionTitle: TextView
    private lateinit var tvProtectionSub: TextView
    private lateinit var ivProtectionStatus: ImageView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        KopanowPrefs.init(applicationContext)

        if (!KopanowPrefs.hasSession) {
            startActivity(Intent(this, RegistrationActivity::class.java))
            finish()
            return
        }

        if (KopanowPrefs.isLocked) {
            goToLockScreen()
            return
        }

        setContentView(R.layout.activity_main)
        bindViews()

        val enrolled = DeviceSecurityManager.isAdminActive(this)
        updateProtectionStatusUI(enrolled)
        
        if (enrolled) {
            showDashboard()
            fetchLoanDetails()
        } else {
            showEnrollmentPrompt()
        }

        // Always (re-)schedule the heartbeat when a session is active.
        // WorkManager's UPDATE policy makes this idempotent — safe to call on every launch.
        // This ensures the job survives app updates and WorkManager resets.
        HeartbeatScheduler.schedule(this)
    }

    private fun bindViews() {
        cardEnrollment = findViewById(R.id.card_enrollment)
        cardDashboard = findViewById(R.id.card_dashboard)
        tvWelcome = findViewById(R.id.tv_welcome)
        tvStatus = findViewById(R.id.tv_enrollment_status)
        btnEnroll = findViewById(R.id.btn_test_enroll)
        btnPayNow = findViewById(R.id.btn_pay_now)
        tvLoanBalance = findViewById(R.id.tv_loan_balance)
        tvNextDue = findViewById(R.id.tv_next_due)
        tvStatusBadge = findViewById(R.id.tv_status_badge)
        
        tvProtectionTitle = findViewById(R.id.tv_protection_title)
        tvProtectionSub = findViewById(R.id.tv_protection_sub)
        ivProtectionStatus = findViewById(R.id.iv_protection_status)

        btnEnroll.setOnClickListener { triggerEnrollment() }
        btnPayNow.setOnClickListener { initiatePayment() }
    }

    private fun updateProtectionStatusUI(active: Boolean) {
        if (active) {
            tvProtectionTitle.text = "Protection Active"
            tvProtectionSub.text = "Your device is secured by Kopanow"
            ivProtectionStatus.setImageResource(android.R.drawable.presence_online)
            ImageViewCompat.setImageTintList(ivProtectionStatus, ColorStateList.valueOf(ContextCompat.getColor(this, android.R.color.holo_green_dark)))
        } else {
            tvProtectionTitle.text = "Protection Inactive"
            tvProtectionSub.text = "Device admin permission required"
            ivProtectionStatus.setImageResource(android.R.drawable.presence_busy)
            ImageViewCompat.setImageTintList(ivProtectionStatus, ColorStateList.valueOf(ContextCompat.getColor(this, android.R.color.holo_red_dark)))
        }
    }

    private fun showEnrollmentPrompt() {
        cardEnrollment.visibility = View.VISIBLE
        cardDashboard.visibility = View.GONE
    }

    private fun showDashboard() {
        cardEnrollment.visibility = View.GONE
        cardDashboard.visibility = View.VISIBLE
        tvWelcome.text = "Hello, ${KopanowPrefs.borrowerId ?: "User"}"
    }

    private fun fetchLoanDetails() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return

        activityScope.launch {
            val result = KopanowApi.getLoanDetails(borrowerId, loanId)
            withContext(Dispatchers.Main) {
                if (result.success && result.data != null) {
                    val loan = result.data
                    tvLoanBalance.text = loan.balance ?: "TSh 0.00"
                    tvNextDue.text = loan.nextDueDate ?: "N/A"
                    tvStatusBadge.text = loan.loanStatus?.replaceFirstChar { it.uppercase() } ?: "Unknown"
                    
                    val colorRes = when(loan.loanStatus) {
                        "active" -> android.R.color.holo_green_dark
                        "locked" -> android.R.color.holo_red_dark
                        "processing" -> android.R.color.holo_orange_dark
                        else -> android.R.color.darker_gray
                    }
                    tvStatusBadge.setTextColor(ContextCompat.getColor(this@MainActivity, colorRes))
                }
            }
        }
    }

    private fun checkInWithBackend() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return
        
        activityScope.launch {
            val request = HeartbeatRequest(
                borrowerId = borrowerId,
                loanId = loanId,
                deviceId = DeviceSecurityManager.getDeviceId(this@MainActivity),
                dpcActive = DeviceSecurityManager.isAdminActive(this@MainActivity),
                isSafeMode = false,
                batteryPct = -1,
                frpSeeded = KopanowPrefs.frpSeeded,
                timestamp = System.currentTimeMillis()
            )
            KopanowApi.heartbeat(request) // Silent check-in to update "Last Seen"
        }
    }

    private fun initiatePayment() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return
        showToast("Initiating M-Pesa Payment...")
        activityScope.launch {
            val result = KopanowApi.initiateStkPush(borrowerId, loanId, 100L)
            withContext(Dispatchers.Main) {
                if (result.success) showToast("STK Push Sent.") else showToast("Payment failed: ${result.error}")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (KopanowPrefs.isInitialised() && KopanowPrefs.isLocked) {
            goToLockScreen()
        } else if (KopanowPrefs.isInitialised() && KopanowPrefs.hasSession) {
            updateProtectionStatusUI(DeviceSecurityManager.isAdminActive(this))
            fetchLoanDetails()
            checkInWithBackend() // Update "Online" status on dashboard
        }
    }

    override fun onDestroy() {
        activityScope.cancel()
        super.onDestroy()
    }

    // onActivityResult replaced by ActivityResultLauncher (adminLauncher) above

    private fun triggerEnrollment() {
        activityScope.launch {
            val eligibility = EnrollmentManager.checkDeviceEligibility(this@MainActivity)
            withContext(Dispatchers.Main) {
                if (eligibility.eligible) EnrollmentManager.requestDeviceAdmin(this@MainActivity, adminLauncher)
                else showToast(eligibility.reason ?: "Device not eligible")
            }
        }
    }

    private fun onAdminGranted() {
        EnrollmentManager.onAdminActivated(this, activityScope) { success, message ->
            showToast(message)
            if (success) {
                KopanowPrefs.isAdmin = true
                updateProtectionStatusUI(true)
                showDashboard()
                fetchLoanDetails()
            }
        }
    }

    private fun onAdminDenied() {
        showToast("Admin access is required.")
        updateProtectionStatusUI(false)
    }

    private fun goToLockScreen() {
        startActivity(Intent(this, LockScreenActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        })
        finish()
    }

    private fun isFirstRunDone(): Boolean = getSharedPreferences("kopanow_prefs", MODE_PRIVATE).getBoolean(PREF_FIRST_RUN_DONE, false)
    private fun markFirstRunDone() = getSharedPreferences("kopanow_prefs", MODE_PRIVATE).edit().putBoolean(PREF_FIRST_RUN_DONE, true).apply()
    private fun showToast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
