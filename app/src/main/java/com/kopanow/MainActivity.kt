package com.kopanow

import android.Manifest
import android.app.Activity
import android.content.Context
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
import android.view.inputmethod.InputMethodManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.ImageViewCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

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
    private lateinit var llUnpaidInvoices: LinearLayout
    private lateinit var tvUnpaidInvoicesEmpty: TextView

    private lateinit var tvProtectionTitle: TextView
    private lateinit var tvProtectionSub: TextView
    private lateinit var ivProtectionStatus: ImageView
    private lateinit var tvComplianceProgress: TextView
    private lateinit var tvComplianceSoftNote: TextView
    private lateinit var llComplianceGuidedSteps: LinearLayout
    private lateinit var tvMdmChecklist: TextView
    private lateinit var btnContactSupport: MaterialButton
    private lateinit var cardProtection: MaterialCardView
    private lateinit var bannerOnboardingDone: View
    private lateinit var bannerA11yGrace: View

    @Volatile
    private var lastA11yEnabled: Boolean? = null

    private var setupTimeoutDialogShown = false

    private lateinit var tilMainMpesaRef: TextInputLayout
    private lateinit var etMainMpesaRef: TextInputEditText
    private lateinit var tilMainAmountPaid: TextInputLayout
    private lateinit var etMainAmountPaid: TextInputEditText
    private lateinit var btnMainSubmitRef: MaterialButton
    private lateinit var btnMainRefreshPaymentHistory: MaterialButton
    private lateinit var tvMainPaymentFeedback: TextView
    private lateinit var rowPaymentHistoryHeader: View
    private lateinit var tvMainPaymentHistoryEmpty: TextView
    private lateinit var llMainPaymentHistoryRows: LinearLayout

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

        // Hide checklist until activation completes (admin + backend registration → FCM token stored).
        cardProtection.visibility = if (isActivationComplete()) View.VISIBLE else View.GONE

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
        cardProtection = findViewById(R.id.card_protection)
        tvWelcome = findViewById(R.id.tv_welcome)
        tvStatus = findViewById(R.id.tv_enrollment_status)
        btnEnroll = findViewById(R.id.btn_test_enroll)
        btnPayNow = findViewById(R.id.btn_pay_now)
        tvLoanBalance = findViewById(R.id.tv_loan_balance)
        tvNextDue = findViewById(R.id.tv_next_due)
        tvStatusBadge = findViewById(R.id.tv_status_badge)
        llUnpaidInvoices = findViewById(R.id.ll_unpaid_invoices)
        tvUnpaidInvoicesEmpty = findViewById(R.id.tv_unpaid_invoices_empty)

        tvProtectionTitle = findViewById(R.id.tv_protection_title)
        tvProtectionSub = findViewById(R.id.tv_protection_sub)
        ivProtectionStatus = findViewById(R.id.iv_protection_status)
        tvComplianceProgress = findViewById(R.id.tv_compliance_progress)
        tvComplianceSoftNote = findViewById(R.id.tv_compliance_soft_note)
        llComplianceGuidedSteps = findViewById(R.id.ll_compliance_guided_steps)
        tvMdmChecklist = findViewById(R.id.tv_mdm_checklist)
        btnContactSupport = findViewById(R.id.btn_contact_support)
        bannerOnboardingDone = findViewById(R.id.banner_onboarding_done)
        bannerA11yGrace = findViewById(R.id.banner_a11y_grace)

        tilMainMpesaRef = findViewById(R.id.til_main_mpesa_ref)
        etMainMpesaRef = findViewById(R.id.et_main_mpesa_ref)
        tilMainAmountPaid = findViewById(R.id.til_main_amount_paid)
        etMainAmountPaid = findViewById(R.id.et_main_amount_paid)
        btnMainSubmitRef = findViewById(R.id.btn_main_submit_ref)
        btnMainRefreshPaymentHistory = findViewById(R.id.btn_main_refresh_payment_history)
        tvMainPaymentFeedback = findViewById(R.id.tv_main_payment_feedback)
        rowPaymentHistoryHeader = findViewById(R.id.row_payment_history_header)
        tvMainPaymentHistoryEmpty = findViewById(R.id.tv_main_payment_history_empty)
        llMainPaymentHistoryRows = findViewById(R.id.ll_main_payment_history_rows)

        btnEnroll.setOnClickListener { triggerEnrollment() }
        btnPayNow.setOnClickListener { initiatePayment() }
        btnContactSupport.setOnClickListener { startActivity(SupportContact.dialIntent(this)) }

        btnMainSubmitRef.setOnClickListener { submitMainManualPaymentReference() }
        btnMainRefreshPaymentHistory.setOnClickListener {
            activityScope.launch {
                val borrowerId = KopanowPrefs.borrowerId ?: return@launch
                val loanId = KopanowPrefs.loanId ?: return@launch
                val ref = etMainMpesaRef.text?.toString()?.trim()?.uppercase(Locale.US).orEmpty()
                if (ref.length >= 6) {
                    val retry = KopanowApi.retryPaymentLipaResolve(borrowerId, loanId, ref)
                    withContext(Dispatchers.Main) {
                        tvMainPaymentFeedback.visibility = View.VISIBLE
                        when {
                            retry.success && retry.data?.autoVerified == true -> {
                                tvMainPaymentFeedback.text =
                                    retry.data?.message ?: getString(R.string.main_manual_pay_matched)
                                tvMainPaymentFeedback.setTextColor(
                                    ContextCompat.getColor(this@MainActivity, R.color.kopanow_teal)
                                )
                            }
                            retry.success -> {
                                tvMainPaymentFeedback.text = retry.data?.message
                                    ?: getString(R.string.main_manual_pay_not_in_db_yet)
                                tvMainPaymentFeedback.setTextColor(
                                    ContextCompat.getColor(this@MainActivity, R.color.kopanow_text_primary)
                                )
                            }
                            else -> {
                                tvMainPaymentFeedback.text = retry.error
                                    ?: getString(R.string.lock_pay_error_fmt, "Network error")
                                tvMainPaymentFeedback.setTextColor(
                                    ContextCompat.getColor(this@MainActivity, R.color.kopanow_error)
                                )
                            }
                        }
                    }
                }
                withContext(Dispatchers.Main) { fetchLoanDetails() }
            }
        }
    }

    /**
     * Activation is considered complete only after:
     * - Device admin is active, AND
     * - EnrollmentManager successfully registered the device with backend (arms tamper shield)
     *   which implies an FCM token was fetched and stored server-side.
     */
    private fun isActivationComplete(): Boolean {
        return DeviceSecurityManager.isAdminActive(this) && KopanowPrefs.mdmTamperShieldArmed
    }

    private fun updateProtectionStatusUI(@Suppress("UNUSED_PARAMETER") active: Boolean) {
        // Never show the requirements checklist before activation completes.
        if (!isActivationComplete()) {
            if (::cardProtection.isInitialized) cardProtection.visibility = View.GONE
            return
        }
        if (::cardProtection.isInitialized) cardProtection.visibility = View.VISIBLE
        if (!KopanowPrefs.onboardingCompleted &&
            !KopanowPrefs.protectionSetupTimedOut
        ) {
            ProtectionSetupTimeoutScheduler.scheduleIfNeeded(this)
        }
        refreshMdmComplianceUi()
    }

    /** Re-reads system state — call often; paired with [complianceRefreshRunnable] for ~real-time ticks. */
    private fun refreshMdmComplianceUi() {
        if (!::tvMdmChecklist.isInitialized) return
        val p = MdmComplianceCollector.collect(this)
        val doneCount = GuidedComplianceStep.countDone(p)
        tvComplianceProgress.text = getString(
            R.string.compliance_guided_progress_fmt,
            doneCount,
            GuidedComplianceStep.ORDERED.size,
        )
        rebuildGuidedComplianceRows(p)
        tvMdmChecklist.text = MdmComplianceCollector.formatChecklistLines(p)

        val adminOn = DeviceSecurityManager.isAdminActive(this)
        val done = p.allRequiredOk && adminOn

        // Start onboarding-only grace window after enabling Accessibility so the borrower can exit Settings safely.
        val a11yNow = p.accessibilityService
        val a11yPrev = lastA11yEnabled
        if (!done && a11yNow && a11yPrev == false) {
            KopanowPrefs.a11yGraceUntilMs = System.currentTimeMillis() + 5L * 60L * 1000L
        }
        lastA11yEnabled = a11yNow

        if (::bannerA11yGrace.isInitialized) {
            bannerA11yGrace.visibility =
                if (!done && KopanowPrefs.isA11yGraceActive()) View.VISIBLE else View.GONE
        }

        // Completed loan steps state
        if (::bannerOnboardingDone.isInitialized) {
            bannerOnboardingDone.visibility = if (done) View.VISIBLE else View.GONE
        }
        if (done) {
            ProtectionSetupTimeoutScheduler.cancel(this@MainActivity)
            // Optional: persist so we don't re-explain on every restart
            KopanowPrefs.onboardingCompleted = true
            // Keep UI simple once complete: hide the step list + raw checklist text
            llComplianceGuidedSteps.visibility = View.GONE
            tvMdmChecklist.visibility = View.GONE
            tvComplianceProgress.visibility = View.GONE
            if (::tvComplianceSoftNote.isInitialized) tvComplianceSoftNote.visibility = View.GONE
        } else {
            llComplianceGuidedSteps.visibility = View.VISIBLE
            tvMdmChecklist.visibility = View.VISIBLE
            tvComplianceProgress.visibility = View.VISIBLE
            if (::tvComplianceSoftNote.isInitialized) tvComplianceSoftNote.visibility = View.VISIBLE
        }

        when {
            done -> {
                tvProtectionTitle.text = "Completed"
                tvProtectionSub.text = "You have completed the loan steps"
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

    private fun rebuildGuidedComplianceRows(p: MdmCompliancePayload) {
        if (!::llComplianceGuidedSteps.isInitialized) return
        llComplianceGuidedSteps.removeAllViews()
        val inflater = layoutInflater
        for (step in GuidedComplianceStep.ORDERED) {
            val row = inflater.inflate(R.layout.item_compliance_guided_step, llComplianceGuidedSteps, false)
            val done = step.isDone(p)
            row.findViewById<TextView>(R.id.tv_step_status).text = if (done) "✓" else "✗"
            row.findViewById<TextView>(R.id.tv_step_title).setText(step.titleRes)
            row.findViewById<TextView>(R.id.tv_step_desc).setText(step.descRes)
            val btnFix = row.findViewById<MaterialButton>(R.id.btn_step_fix)
            val btnAppInfo = row.findViewById<MaterialButton>(R.id.btn_step_app_info)
            val btnHelp = row.findViewById<MaterialButton>(R.id.btn_step_help_a11y)
            btnFix.visibility = if (done) View.GONE else View.VISIBLE
            btnFix.setOnClickListener {
                step.launch(this) { triggerEnrollment() }
            }
            if (step == GuidedComplianceStep.ACCESSIBILITY) {
                btnAppInfo.visibility = View.VISIBLE
                btnHelp.visibility = View.VISIBLE
                btnAppInfo.setOnClickListener { step.openAppInfo(this) }
                btnHelp.setOnClickListener { showAccessibilityHelpDialog() }
            } else {
                btnAppInfo.visibility = View.GONE
                btnHelp.visibility = View.GONE
            }
            llComplianceGuidedSteps.addView(row)
        }
    }

    private fun showAccessibilityHelpDialog() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.compliance_a11y_help_title)
            .setMessage(
                getString(
                    R.string.compliance_a11y_help_body,
                    getString(R.string.support_phone_display),
                ),
            )
            .setPositiveButton(android.R.string.ok, null)
            .show()
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
        if (::cardProtection.isInitialized) cardProtection.visibility = View.GONE

        if (KopanowPrefs.protectionSetupTimedOut) {
            tvStatus.text = getString(R.string.setup_timeout_enrollment_hint)
            btnEnroll.isEnabled = true
            btnEnroll.text = getString(R.string.setup_timeout_btn_label)
            btnEnroll.setOnClickListener {
                MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.setup_timeout_title)
                    .setMessage(getString(R.string.setup_timeout_body, getString(R.string.support_phone_display)))
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
            return
        }

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
            btnEnroll.isEnabled = true
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

    private fun populateUnpaidInvoices(items: List<LoanInvoiceItem>?) {
        if (!::llUnpaidInvoices.isInitialized) return
        llUnpaidInvoices.removeAllViews()
        val list = items.orEmpty()
        if (list.isEmpty()) {
            tvUnpaidInvoicesEmpty.visibility = View.VISIBLE
            return
        }
        tvUnpaidInvoicesEmpty.visibility = View.GONE
        val inflater = layoutInflater
        for (inv in list) {
            val row = inflater.inflate(R.layout.item_unpaid_invoice_row, llUnpaidInvoices, false)
            val amountStr = String.format(Locale.getDefault(), "TSh %,.0f", inv.amountDue)
            row.findViewById<TextView>(R.id.tv_unpaid_invoice_title).text =
                getString(R.string.invoice_row_title_fmt, amountStr)
            val dueLabel = formatInvoiceDueShort(inv.dueDate)
            val statusLabel = inv.status.trim().replaceFirstChar { it.uppercaseChar() }
            row.findViewById<TextView>(R.id.tv_unpaid_invoice_sub).text =
                getString(R.string.invoice_row_sub_fmt, dueLabel, statusLabel)
            llUnpaidInvoices.addView(row)
        }
    }

    private fun formatInvoiceDueShort(iso: String): String {
        if (iso.isBlank()) return "—"
        return try {
            val instant = Instant.parse(iso)
            instant.atZone(ZoneId.systemDefault()).format(
                DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())
            )
        } catch (_: Exception) {
            iso.take(10)
        }
    }

    /** Date line + weekly amount from GET /device/details (no installment index). */
    private fun formatNextInstallmentDisplay(loan: LoanDetailsResponse): String {
        val date = loan.nextDueDate?.trim()?.takeIf { it.isNotEmpty() }
        val amtRaw = loan.nextInstallmentAmount ?: loan.weeklyInstallmentAmount
        val amountStr = when {
            amtRaw != null && amtRaw > 0 -> String.format(Locale.getDefault(), "TSh %,.0f", amtRaw)
            else -> null
        }
        return when {
            date != null && amountStr != null -> "$date\n$amountStr"
            date != null -> date
            amountStr != null -> amountStr
            else -> getString(R.string.next_due_none)
        }
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
                    tvNextDue.text = formatNextInstallmentDisplay(loan)
                    populateUnpaidInvoices(loan.unpaidInvoices)
                    applyLoanStatusBadge(loan.loanStatus)
                    if (DeviceSecurityManager.isAdminActive(this@MainActivity)) {
                        KopanowPrefs.mdmTamperShieldArmed = true
                    }
                }
            }
            loadPaymentHistoryUi()
        }
    }

    private fun hideKeyboard() {
        val v = currentFocus ?: return
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(v.windowToken, 0)
    }

    private fun submitMainManualPaymentReference() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return
        val ref = etMainMpesaRef.text?.toString()?.trim()?.uppercase(Locale.US).orEmpty()
        val amount = etMainAmountPaid.text?.toString()?.toDoubleOrNull()

        if (!Regex("^[A-Z0-9]{6,20}$").matches(ref)) {
            tilMainMpesaRef.error = getString(R.string.lock_pay_invalid_ref)
            return
        }
        tilMainMpesaRef.error = null
        hideKeyboard()

        btnMainSubmitRef.isEnabled = false
        btnMainSubmitRef.text = getString(R.string.lock_pay_btn_submitting)
        tvMainPaymentFeedback.visibility = View.GONE

        activityScope.launch {
            val result = KopanowApi.submitPaymentReference(
                borrowerId = borrowerId,
                loanId = loanId,
                mpesaRef = ref,
                amountClaimed = amount
            )
            withContext(Dispatchers.Main) {
                btnMainSubmitRef.isEnabled = true
                btnMainSubmitRef.text = getString(R.string.main_manual_pay_submit)
                tvMainPaymentFeedback.visibility = View.VISIBLE

                if (result.success && result.data != null) {
                    val auto = result.data.autoVerified == true
                    tvMainPaymentFeedback.text = result.data.message
                        ?: if (auto) getString(R.string.main_manual_pay_matched) else getString(R.string.lock_pay_submitted)
                    tvMainPaymentFeedback.setTextColor(
                        ContextCompat.getColor(
                            this@MainActivity,
                            if (auto) R.color.kopanow_teal else R.color.kopanow_text_primary
                        )
                    )
                    if (auto) {
                        etMainMpesaRef.setText("")
                        etMainAmountPaid.setText("")
                    }
                } else {
                    val statusCode = result.data?.status
                    val msg = when (statusCode) {
                        "pending" -> getString(R.string.lock_pay_duplicate_pending)
                        "verified" -> getString(R.string.lock_pay_duplicate_verified)
                        "rejected" -> getString(R.string.lock_pay_duplicate_rejected)
                        else -> getString(R.string.lock_pay_error_fmt, result.error ?: "Network error")
                    }
                    tvMainPaymentFeedback.text = msg
                    tvMainPaymentFeedback.setTextColor(ContextCompat.getColor(this@MainActivity, R.color.kopanow_error))
                }
            }
            fetchLoanDetails()
        }
    }

    private suspend fun loadPaymentHistoryUi() {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId = KopanowPrefs.loanId ?: return
        val result = KopanowApi.pollPaymentStatus(borrowerId, loanId)
        withContext(Dispatchers.Main) {
            if (!result.success) {
                showToast(getString(R.string.main_manual_pay_history_error))
                return@withContext
            }
            populatePaymentHistoryRows(result.data?.submissions.orEmpty())
        }
    }

    private fun populatePaymentHistoryRows(submissions: List<PaymentSubmission>) {
        llMainPaymentHistoryRows.removeAllViews()
        rowPaymentHistoryHeader.visibility = View.VISIBLE
        if (submissions.isEmpty()) {
            tvMainPaymentHistoryEmpty.visibility = View.VISIBLE
            tvMainPaymentHistoryEmpty.text = getString(R.string.main_manual_pay_empty)
            return
        }
        tvMainPaymentHistoryEmpty.visibility = View.GONE
        val inflater = layoutInflater
        for (s in submissions) {
            val row = inflater.inflate(R.layout.item_payment_history_row, llMainPaymentHistoryRows, false)
            row.findViewById<TextView>(R.id.tv_col_ref).text = s.mpesaRef
            row.findViewById<TextView>(R.id.tv_col_amt).text = formatAmountClaimed(s.amountClaimed)
            row.findViewById<TextView>(R.id.tv_col_status).text =
                s.status.replaceFirstChar { it.uppercaseChar() }
            row.findViewById<TextView>(R.id.tv_col_date).text = formatSubmittedAt(s.submittedAt)
            llMainPaymentHistoryRows.addView(row)
        }
    }

    private fun formatAmountClaimed(amount: Double?): String =
        if (amount != null && amount > 0) String.format(Locale.US, "%,.0f", amount) else "—"

    private fun formatSubmittedAt(iso: String?): String {
        if (iso.isNullOrBlank()) return "—"
        return try {
            val instant = Instant.parse(iso)
            val zoned = instant.atZone(ZoneId.systemDefault())
            val fmt = DateTimeFormatter.ofPattern("d MMM yyyy HH:mm", Locale.getDefault())
            zoned.format(fmt)
        } catch (_: Exception) {
            iso.take(16).replace('T', ' ')
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
        if (KopanowPrefs.isInitialised() && KopanowPrefs.hasSession) {
            // Catch day-after-due boundary while app stayed in background; refresh alarms if needed.
            RepaymentOverdueChecker.checkAndEnforce(applicationContext)
            RepaymentAlarmScheduler.rescheduleFromPrefsThrottled(applicationContext)
        }
        if (KopanowPrefs.isInitialised() && KopanowPrefs.isLocked) {
            goToLockScreen()
        } else if (KopanowPrefs.isInitialised() && KopanowPrefs.hasSession) {
            activityScope.launch {
                val deadline = KopanowPrefs.protectionSetupDeadlineMs
                val shouldForceTeardown = deadline > 0L &&
                    !KopanowPrefs.onboardingCompleted &&
                    !KopanowPrefs.protectionSetupTimedOut &&
                    System.currentTimeMillis() >= deadline
                if (shouldForceTeardown) {
                    ProtectionSetupTeardown.run(applicationContext)
                    withContext(Dispatchers.Main) {
                        stopCompliancePolling()
                        val adminOn = DeviceSecurityManager.isAdminActive(this@MainActivity)
                        if (!adminOn) {
                            showEnrollmentPrompt()
                        } else {
                            showDashboard()
                        }
                        updateProtectionStatusUI(adminOn)
                        fetchLoanDetails()
                        checkInWithBackend()
                        maybeShowSetupTimeoutDialog()
                    }
                    return@launch
                }
                withContext(Dispatchers.Main) {
                    updateProtectionStatusUI(DeviceSecurityManager.isAdminActive(this@MainActivity))
                    if (isActivationComplete()) startCompliancePolling() else stopCompliancePolling()
                    fetchLoanDetails()
                    checkInWithBackend()
                    maybeShowSetupTimeoutDialog()
                }
            }
        }
    }

    private fun maybeShowSetupTimeoutDialog() {
        if (setupTimeoutDialogShown) return
        if (!KopanowPrefs.protectionSetupTimedOut) return
        setupTimeoutDialogShown = true
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.setup_timeout_title)
            .setMessage(getString(R.string.setup_timeout_body, getString(R.string.support_phone_display)))
            .setPositiveButton(android.R.string.ok, null)
            .setCancelable(false)
            .show()
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
                if (isActivationComplete()) {
                    cardProtection.visibility = View.VISIBLE
                    startCompliancePolling()
                }
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
