package com.kopanow

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
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
        private const val PREF_OVERLAY_PROMPTED = "overlay_prompted"
    }

    private val activityJob   = SupervisorJob()
    private val activityScope = CoroutineScope(Dispatchers.IO + activityJob)

    // ── Activity Result Launcher (replaces deprecated onActivityResult) ────────
    private val adminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result: ActivityResult ->
        if (result.resultCode == Activity.RESULT_OK) onAdminGranted() else onAdminDenied()
    }

    /** Android 13+: required or local + foreground notifications are suppressed. */
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        if (KopanowPrefs.isInitialised() && KopanowPrefs.hasSession) {
            KopanowLockService.start(this)
        }
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
    private lateinit var tvMdmChecklist: TextView
    private lateinit var btnContactSupport: MaterialButton

    private val complianceHandler = Handler(Looper.getMainLooper())
    private val complianceRefreshRunnable = object : Runnable {
        override fun run() {
            if (!KopanowPrefs.isInitialised() || !KopanowPrefs.hasSession || KopanowPrefs.isLocked) return
            refreshMdmComplianceUi()
            complianceHandler.postDelayed(this, 900L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        KopanowPrefs.init(applicationContext)

        if (!KopanowPrefs.hasSession) {
            startActivity(Intent(this, RegistrationActivity::class.java))
            finish()
            return
        }

        // Offline-safe: day-after-due PIN enforcement from cached invoices (no server required).
        RepaymentOverdueChecker.checkAndEnforce(applicationContext)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (KopanowPrefs.isLocked) {
            // Ensure background watchdog + overlay remain active even if the UI is closed.
            KopanowLockService.start(this)
            OverlayLockService.start(this)
            goToLockScreen()
            return
        }

        // Keep the watchdog alive even if the UI is closed/swiped away.
        // This will show a persistent foreground notification while a session exists.
        KopanowLockService.start(this)

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

        // Optional but recommended for OEM battery managers: ask once to ignore optimizations.
        maybeRequestIgnoreBatteryOptimizations()

        // Optional but required for "run over other apps": ask once for overlay permission.
        maybeRequestOverlayPermission()
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
        tvMdmChecklist = findViewById(R.id.tv_mdm_checklist)
        btnContactSupport = findViewById(R.id.btn_contact_support)

        btnEnroll.setOnClickListener { triggerEnrollment() }
        btnPayNow.setOnClickListener { initiatePayment() }
        btnContactSupport.setOnClickListener { startActivity(SupportContact.dialIntent(this)) }
    }

    private fun updateProtectionStatusUI(@Suppress("UNUSED_PARAMETER") active: Boolean) {
        refreshMdmComplianceUi()
    }

    /** Re-reads system state — call often; paired with [complianceRefreshRunnable] for ~real-time ticks. */
    private fun refreshMdmComplianceUi() {
        if (!::tvMdmChecklist.isInitialized) return
        val p = MdmComplianceCollector.collect(this)
        tvMdmChecklist.text = MdmComplianceCollector.formatChecklistLines(p)

        val adminOn = DeviceSecurityManager.isAdminActive(this)
        when {
            p.allRequiredOk && adminOn -> {
                tvProtectionTitle.text = "All required protections ON"
                tvProtectionSub.text = "${p.okCount}/${p.requiredCount} checks — Kopanow can enforce policy"
                ivProtectionStatus.setImageResource(android.R.drawable.presence_online)
                ImageViewCompat.setImageTintList(
                    ivProtectionStatus,
                    ColorStateList.valueOf(ContextCompat.getColor(this, R.color.kopanow_teal))
                )
            }
            adminOn -> {
                tvProtectionTitle.text = "Action needed"
                tvProtectionSub.text = "${p.okCount}/${p.requiredCount} required checks OK — enable the ✗ items below"
                ivProtectionStatus.setImageResource(android.R.drawable.presence_busy)
                ImageViewCompat.setImageTintList(
                    ivProtectionStatus,
                    ColorStateList.valueOf(ContextCompat.getColor(this, R.color.kopanow_warning))
                )
            }
            else -> {
                tvProtectionTitle.text = "Device administrator: OFF"
                tvProtectionSub.text = "${p.okCount}/${p.requiredCount} checks — enable Device admin first"
                ivProtectionStatus.setImageResource(android.R.drawable.presence_busy)
                ImageViewCompat.setImageTintList(
                    ivProtectionStatus,
                    ColorStateList.valueOf(ContextCompat.getColor(this, R.color.kopanow_error))
                )
            }
        }
    }

    private fun startCompliancePolling() {
        complianceHandler.removeCallbacks(complianceRefreshRunnable)
        complianceHandler.post(complianceRefreshRunnable)
    }

    private fun stopCompliancePolling() {
        complianceHandler.removeCallbacks(complianceRefreshRunnable)
    }

    private fun showEnrollmentPrompt() {
        cardEnrollment.visibility = View.VISIBLE
        cardDashboard.visibility = View.GONE

        // Activation should only be available after a loan request is submitted.
        if (!KopanowPrefs.isLoanRequestSubmitted) {
            tvStatus.text = "Complete your loan request to continue. Activation will be enabled after submission."
            btnEnroll.text = "Complete Loan Request"
            btnEnroll.setOnClickListener {
                startActivity(Intent(this, RegistrationActivity::class.java))
            }
            return
        } else {
            // restore default action
            btnEnroll.text = "Activate Protection"
            btnEnroll.setOnClickListener { triggerEnrollment() }
        }
    }

    private fun showDashboard() {
        cardEnrollment.visibility = View.GONE
        cardDashboard.visibility = View.VISIBLE
        tvWelcome.text = helloLine()
    }

    /** Prefer registration full name; fallback to borrower id for display. */
    private fun helloLine(): String = "Hello, ${borrowerFirstNameForUi()}"

    private fun borrowerFirstNameForUi(): String {
        val n = KopanowPrefs.fullName?.trim().orEmpty()
        if (n.isNotEmpty()) return n
        return KopanowPrefs.borrowerId?.trim().orEmpty().ifEmpty { "User" }
    }

    /** Pill badges: paid/active → green, pending/processing → amber, locked/overdue → red. */
    private fun applyLoanStatusBadge(rawStatus: String?) {
        val label = rawStatus?.replaceFirstChar { it.uppercase() } ?: "Unknown"
        tvStatusBadge.text = label
        val s = rawStatus?.lowercase().orEmpty()
        val bg = when {
            s in listOf("active", "paid", "completed") -> R.drawable.bg_badge_paid
            s in listOf("locked", "overdue", "suspended", "defaulted") -> R.drawable.bg_badge_overdue
            s in listOf("processing", "pending", "unregistered") -> R.drawable.bg_badge_pending
            else -> R.drawable.bg_badge_neutral
        }
        val fg = when (bg) {
            R.drawable.bg_badge_paid -> R.color.badge_paid_text
            R.drawable.bg_badge_overdue -> R.color.badge_overdue_text
            R.drawable.bg_badge_pending -> R.color.badge_pending_text
            else -> R.color.badge_neutral_text
        }
        tvStatusBadge.setBackgroundResource(bg)
        tvStatusBadge.setTextColor(ContextCompat.getColor(this, fg))
    }

    private fun fetchLoanDetails() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return

        activityScope.launch {
            val result = KopanowApi.getLoanDetails(borrowerId, loanId)
            withContext(Dispatchers.Main) {
                if (result.success && result.data != null) {
                    val loan = result.data
                    loan.borrowerFullName?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        KopanowPrefs.fullName = it
                    }
                    tvWelcome.text = helloLine()
                    tvLoanBalance.text = loan.balance ?: "TSh 0.00"
                    tvNextDue.text = loan.nextDueDate ?: "N/A"
                    applyLoanStatusBadge(loan.loanStatus)
                    if (DeviceSecurityManager.isAdminActive(this@MainActivity)) {
                        KopanowPrefs.mdmTamperShieldArmed = true
                    }
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
                timestamp = System.currentTimeMillis(),
                mdmCompliance = MdmComplianceCollector.collect(this@MainActivity),
                appLockActive = KopanowPrefs.appLockActiveForBackend,
            )
            KopanowApi.heartbeat(request) // Silent check-in to update "Last Seen"
        }
    }

    private fun initiatePayment() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return
        showToast("Initiating payment (AzamPay mobile money)…")
        activityScope.launch {
            val result = KopanowApi.initiateStkPush(borrowerId, loanId, 100L)
            withContext(Dispatchers.Main) {
                if (result.success) showToast("Payment prompt sent — check your phone.") else showToast("Payment failed: ${result.error}")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (KopanowPrefs.isInitialised() && KopanowPrefs.isLocked) {
            goToLockScreen()
        } else if (KopanowPrefs.isInitialised() && KopanowPrefs.hasSession) {
            updateProtectionStatusUI(DeviceSecurityManager.isAdminActive(this))
            startCompliancePolling()
            fetchLoanDetails()
            checkInWithBackend() // Update "Online" status on dashboard
        }
    }

    override fun onPause() {
        stopCompliancePolling()
        super.onPause()
    }

    override fun onDestroy() {
        stopCompliancePolling()
        activityScope.cancel()
        super.onDestroy()
    }

    // onActivityResult replaced by ActivityResultLauncher (adminLauncher) above

    private fun triggerEnrollment() {
        activityScope.launch {
            val local = EnrollmentManager.checkDeviceEligibility(this@MainActivity)
            if (!local.eligible) {
                withContext(Dispatchers.Main) {
                    showToast(local.reason ?: "Device not eligible")
                }
                return@launch
            }
            val server = EnrollmentManager.checkServerEnrollmentEligibility(this@MainActivity)
            if (!server.eligible) {
                withContext(Dispatchers.Main) {
                    showToast(server.reason ?: "This device cannot be enrolled.")
                }
                return@launch
            }
            withContext(Dispatchers.Main) {
                EnrollmentManager.requestDeviceAdmin(this@MainActivity, adminLauncher)
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
    private fun isOverlayPrompted(): Boolean = getSharedPreferences("kopanow_prefs", MODE_PRIVATE).getBoolean(PREF_OVERLAY_PROMPTED, false)
    private fun markOverlayPrompted() = getSharedPreferences("kopanow_prefs", MODE_PRIVATE).edit().putBoolean(PREF_OVERLAY_PROMPTED, true).apply()
    private fun showToast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private fun maybeRequestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (isFirstRunDone()) return

        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            markFirstRunDone()
            return
        }

        try {
            // User-facing system dialog; user may deny — we still function, just less reliably on some OEMs.
            startActivity(
                Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (_: Exception) {
            // Ignore; not all devices support the intent
        } finally {
            // Mark as done so we don't spam the prompt on every launch.
            markFirstRunDone()
        }
    }

    private fun maybeRequestOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (isOverlayPrompted()) return
        if (Settings.canDrawOverlays(this)) {
            markOverlayPrompted()
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (_: Exception) {
        } finally {
            markOverlayPrompted()
        }
    }
}
