package com.kopanow

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.WindowCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * LockScreenActivity — Hardened full-screen payment / security blocker.
 *
 * Three modes:
 *  PAYMENT  → lock card + M-Pesa reference submission panel
 *  TAMPER   → lock card only (admin contact message, no payment)
 *  PASSCODE → lock card + PIN keypad (shown when [PasscodeManager.hasActivePasscode] is true)
 *
 * System PIN (DevicePolicyManager.resetPasswordWithToken) is set in parallel by
 * [SystemPinManager] whenever the admin triggers SET_SYSTEM_PIN.  This sets the
 * REAL Android lockscreen PIN so the OS enforces security even outside the app.
 * The in-app PIN keypad provides a secondary verification layer.
 */
class LockScreenActivity : AppCompatActivity() {

    companion object {
        private const val TAG              = "LockScreenActivity"
        private const val POLL_INTERVAL_MS = 30_000L
        const  val SUPPORT_PHONE          = "+255000000000"
        private const val EMERGENCY_NUMBER = "112"
        private const val PIN_LENGTH       = 6
        private const val MAX_PIN_ATTEMPTS = 5
    }

    private val activityJob   = SupervisorJob()
    private val activityScope = CoroutineScope(Dispatchers.IO + activityJob)

    private val pollHandler  = Handler(Looper.getMainLooper())
    private val pollRunnable = object : Runnable {
        override fun run() {
            if (KopanowPrefs.isLocked) {
                checkLockStateFromBackend()
                pollHandler.postDelayed(this, POLL_INTERVAL_MS)
            }
        }
    }

    // PIN state (used when PASSCODE mode is active)
    private val pinBuffer   = StringBuilder()
    private var pinAttempts = 0
    private val pinDotViews = mutableListOf<View>()

    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                KopanowFCMService.ACTION_UNLOCK_SCREEN -> checkLockStateFromBackend(force = true)
                FcmPinManager.ACTION_PASSCODE_CHANGED  -> {
                    val active = intent.getBooleanExtra(FcmPinManager.EXTRA_PASSCODE_ACTIVE, false)
                    runOnUiThread { if (active) showPinKeypad() else hidePinKeypad() }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    override fun onCreate(savedInstanceState: Bundle?) {
        applyLockWindowFlags()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_lock_screen)

        pinDotViews.addAll(listOf(
            findViewById(R.id.pin_dot_1), findViewById(R.id.pin_dot_2),
            findViewById(R.id.pin_dot_3), findViewById(R.id.pin_dot_4),
            findViewById(R.id.pin_dot_5), findViewById(R.id.pin_dot_6)
        ))

        setupLockCard()
        setupPaymentPanel()
        setupPinKeypad()
        blockBackButton()
        registerReceivers()
        enterKioskMode()
    }

    override fun onResume() {
        super.onResume()
        val locked   = KopanowPrefs.isLocked
        val passcode = PasscodeManager.hasActivePasscode()
        if (!locked && !passcode) { safelyDismiss(); return }
        // If the OS killed the foreground watchdog, bring it back so the lock loop never stays dead.
        KopanowLockService.ensureRunningForActiveLock(this)
        hideSystemBars()
        if (locked) pollHandler.post(pollRunnable)
    }

    override fun onPause() {
        if (KopanowPrefs.isLocked || PasscodeManager.hasActivePasscode()) {
            Handler(Looper.getMainLooper()).post { bringToFront() }
        }
        super.onPause()
    }

    override fun onDestroy() {
        try { unregisterReceiver(unlockReceiver) } catch (_: Exception) {}
        pollHandler.removeCallbacks(pollRunnable)
        activityScope.cancel()
        super.onDestroy()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Anti-bypass
    // ─────────────────────────────────────────────────────────────────────────

    private fun enterKioskMode() {
        try { startLockTask() } catch (e: Exception) { Log.w(TAG, "startLockTask: ${e.message}") }
    }

    override fun onUserLeaveHint() {
        if (KopanowPrefs.isLocked || PasscodeManager.hasActivePasscode()) bringToFront()
        super.onUserLeaveHint()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME,
            KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_MENU -> true
            else -> super.onKeyDown(keyCode, event)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lock card UI
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupLockCard() {
        val isPasscode = PasscodeManager.hasActivePasscode()
        val isTamper   = KopanowPrefs.isTamperLock

        // Title
        findViewById<TextView>(R.id.tv_locked_title).text = when {
            isPasscode -> "🔐 Enter PIN"
            isTamper   -> "⛔ Security Violation"
            else       -> "🔒 Device Locked"
        }

        // Amount due
        val tvAmt   = findViewById<TextView>(R.id.tv_amount_due)
        val tvLabel = findViewById<TextView>(R.id.tv_amount_label)
        val tvDays  = findViewById<TextView>(R.id.tv_days_overdue)

        if (isTamper || isPasscode) {
            tvAmt.visibility   = View.GONE
            tvLabel.visibility = View.GONE
            tvDays.visibility  = View.GONE
        } else {
            tvAmt.text = KopanowPrefs.amountDue ?: "—"
            val daysText = KopanowPrefs.lockReason?.let {
                Regex("(\\d+)\\s*days?\\s*overdue", RegexOption.IGNORE_CASE).find(it)?.let { m ->
                    "${m.groupValues[1]} days overdue"
                }
            }
            tvDays.visibility = if (daysText != null) View.VISIBLE else View.GONE
            tvDays.text = daysText ?: ""
        }

        // Lock reason
        val reason = when {
            isPasscode -> "Enter the PIN provided by Kopanow support to unlock your device."
            isTamper   -> KopanowPrefs.lockReason ?: "Locked due to a security violation."
            else       -> KopanowPrefs.lockReason ?: "Please make a payment to unlock your device."
        }
        findViewById<TextView>(R.id.tv_lock_reason).text = reason

        // Tamper: change icon colour to orange
        if (isTamper && !isPasscode) {
            val lockIcon = findViewById<android.widget.ImageView>(R.id.iv_lock_icon)
            lockIcon.setImageResource(android.R.drawable.ic_dialog_alert)
            lockIcon.imageTintList = android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(this, android.R.color.holo_orange_dark)
            )
        }

        // Support call button
        findViewById<MaterialButton>(R.id.btn_call_support).setOnClickListener {
            dismissKeyboard()
            startActivity(Intent(Intent.ACTION_DIAL, "tel:$SUPPORT_PHONE".toUri()))
        }
        // Emergency dial
        findViewById<TextView>(R.id.tv_emergency).setOnClickListener {
            startActivity(Intent(Intent.ACTION_DIAL, "tel:$EMERGENCY_NUMBER".toUri()))
        }

        // Show/hide PIN keypad based on mode
        if (isPasscode) showPinKeypad() else hidePinKeypad()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Payment reference panel
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupPaymentPanel() {
        val isPasscode = PasscodeManager.hasActivePasscode()
        val isTamper   = KopanowPrefs.isTamperLock
        val card       = findViewById<View>(R.id.card_payment_ref)

        // Show only in PAYMENT mode (not tamper, not passcode)
        card.visibility = if (!isPasscode && !isTamper) View.VISIBLE else View.GONE

        val etRef    = findViewById<TextInputEditText>(R.id.et_mpesa_ref)
        val etAmount = findViewById<TextInputEditText>(R.id.et_amount_paid)
        val tvStatus = findViewById<TextView>(R.id.tv_payment_status)
        val btnSubmit = findViewById<MaterialButton>(R.id.btn_submit_ref)
        val btnCheck  = findViewById<MaterialButton>(R.id.btn_check_status)

        btnSubmit.setOnClickListener {
            val ref    = etRef.text?.toString()?.trim()?.uppercase() ?: ""
            val amount = etAmount.text?.toString()?.toDoubleOrNull()

            val tilRef = findViewById<TextInputLayout>(R.id.til_mpesa_ref)
            if (!Regex("^[A-Z0-9]{6,20}$").matches(ref)) {
                tilRef.error = getString(R.string.lock_pay_invalid_ref)
                return@setOnClickListener
            }
            tilRef.error = null
            dismissKeyboard()
            submitPaymentReference(ref, amount, btnSubmit, tvStatus, etRef, etAmount)
        }

        btnCheck.setOnClickListener {
            dismissKeyboard()
            checkPaymentStatus(tvStatus)
        }
    }

    private fun submitPaymentReference(
        ref: String,
        amount: Double?,
        btn: MaterialButton,
        tvStatus: TextView,
        etRef: TextInputEditText,
        etAmount: TextInputEditText
    ) {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId     = KopanowPrefs.loanId     ?: return

        btn.isEnabled = false
        btn.text      = getString(R.string.lock_pay_btn_submitting)
        tvStatus.visibility = View.GONE

        activityScope.launch {
            val result = KopanowApi.submitPaymentReference(
                borrowerId    = borrowerId,
                loanId        = loanId,
                mpesaRef      = ref,
                amountClaimed = amount
            )
            withContext(Dispatchers.Main) {
                btn.isEnabled = true
                btn.text      = getString(R.string.lock_pay_btn_submit)

                if (result.success) {
                    tvStatus.text      = getString(R.string.lock_pay_submitted)
                    tvStatus.setTextColor(ContextCompat.getColor(this@LockScreenActivity, android.R.color.holo_green_light))
                    tvStatus.visibility = View.VISIBLE
                    etRef.setText("")
                    etAmount.setText("")
                } else {
                    val statusCode = result.data?.status
                    val msg = when (statusCode) {
                        "pending"  -> getString(R.string.lock_pay_duplicate_pending)
                        "verified" -> getString(R.string.lock_pay_duplicate_verified)
                        "rejected" -> getString(R.string.lock_pay_duplicate_rejected)
                        else       -> getString(R.string.lock_pay_error_fmt, result.error ?: "Network error")
                    }
                    tvStatus.text      = msg
                    tvStatus.setTextColor(ContextCompat.getColor(this@LockScreenActivity, android.R.color.holo_red_light))
                    tvStatus.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun checkPaymentStatus(tvStatus: TextView) {
        val borrowerId = KopanowPrefs.borrowerId ?: return
        val loanId     = KopanowPrefs.loanId     ?: return

        tvStatus.text      = "Checking…"
        tvStatus.setTextColor(ContextCompat.getColor(this, android.R.color.darker_gray))
        tvStatus.visibility = View.VISIBLE

        activityScope.launch {
            val result = KopanowApi.pollPaymentStatus(borrowerId, loanId)
            withContext(Dispatchers.Main) {
                if (!result.success || result.data?.submissions.isNullOrEmpty()) {
                    tvStatus.text = "No submissions found."
                    return@withContext
                }
                val latest = result.data!!.submissions!!.first()
                val (msg, color) = when (latest.status) {
                    "verified" -> Pair(
                        getString(R.string.lock_pay_status_verified),
                        android.R.color.holo_green_light
                    )
                    "rejected" -> Pair(
                        "${getString(R.string.lock_pay_status_rejected)}\n${latest.reviewerNote ?: ""}",
                        android.R.color.holo_red_light
                    )
                    else -> Pair(
                        getString(R.string.lock_pay_status_pending),
                        android.R.color.darker_gray
                    )
                }
                tvStatus.text = msg
                tvStatus.setTextColor(ContextCompat.getColor(this@LockScreenActivity, color))

                // Payment verified → trigger backend unlock check immediately
                if (latest.status == "verified") {
                    checkLockStateFromBackend(force = true)
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PIN keypad (PASSCODE mode)
    // Used when admin triggers SET_SYSTEM_PIN — device's real system lockscreen
    // PIN (set via DevicePolicyManager.resetPasswordWithToken) is mirrored here
    // so the borrower can also unlock via this in-app keypad.
    // ─────────────────────────────────────────────────────────────────────────

    private fun showPinKeypad() {
        findViewById<View>(R.id.layout_pin_keypad).visibility = View.VISIBLE
        findViewById<View>(R.id.card_payment_ref).visibility  = View.GONE
        resetPinState()
    }

    private fun hidePinKeypad() {
        findViewById<View>(R.id.layout_pin_keypad).visibility = View.GONE
    }

    private fun setupPinKeypad() {
        listOf(
            R.id.pin_btn_0, R.id.pin_btn_1, R.id.pin_btn_2, R.id.pin_btn_3,
            R.id.pin_btn_4, R.id.pin_btn_5, R.id.pin_btn_6, R.id.pin_btn_7,
            R.id.pin_btn_8, R.id.pin_btn_9
        ).forEach { id ->
            val btn = findViewById<MaterialButton>(id)
            btn.setOnClickListener {
                onPinDigitPressed(btn.tag?.toString() ?: return@setOnClickListener)
            }
        }
        findViewById<MaterialButton>(R.id.pin_btn_backspace).setOnClickListener {
            if (pinBuffer.isNotEmpty()) {
                pinBuffer.deleteCharAt(pinBuffer.length - 1)
                refreshDots()
                hidePinError()
            }
        }
    }

    private fun onPinDigitPressed(digit: String) {
        if (pinBuffer.length >= PIN_LENGTH) return
        pinBuffer.append(digit)
        refreshDots()
        hidePinError()
        if (pinBuffer.length == PIN_LENGTH) validatePin()
    }

    private fun validatePin() {
        val entered = pinBuffer.toString()
        if (PasscodeManager.validatePasscode(entered)) {
            // ── TAMPER LOCK: correct PIN but admin-only release ─────────────────────────────────
            // Even with a correct PIN the device stays locked in tamper mode.
            // Only the admin FCM UNLOCK_DEVICE command can clear a tamper lock.
            if (KopanowPrefs.isTamperLock) {
                resetPinState()
                Toast.makeText(
                    this,
                    "⛔ Security alert active. Contact Kopanow to unlock.",
                    Toast.LENGTH_LONG
                ).show()
                // Ensure watchdog is running
                KopanowLockService.start(this)
                return
            }

            // Correct PIN (non-tamper) — clear passcode state
            KopanowPrefs.isPasscodeLocked = false
            KopanowPrefs.passcodeHash     = null
            SystemPinManager.clearSystemPin(this)
            if (!KopanowPrefs.isLocked) {
                safelyDismiss()
            } else {
                hidePinKeypad()
                setupLockCard()
                setupPaymentPanel()
                Toast.makeText(
                    this,
                    "PIN imekubaliwa. Fanya malipo ili kufungua simu kikamilifu.",
                    Toast.LENGTH_LONG
                ).show()
            }
        } else {
            pinAttempts++
            showPinError()
            resetPinState()
            if (pinAttempts >= MAX_PIN_ATTEMPTS) {
                // Too many wrong attempts — escalate to tamper (admin-only release)
                KopanowPrefs.lockType = KopanowPrefs.LOCK_TYPE_TAMPER
                KopanowLockService.start(this)   // ensure watchdog is running
                activityScope.launch {
                    val bId = KopanowPrefs.borrowerId ?: return@launch
                    val lId = KopanowPrefs.loanId     ?: return@launch
                    KopanowApi.reportTamper(bId, lId, "REPEATED_WRONG_PIN")
                }
                Toast.makeText(
                    this,
                    "Majaribio mengi mabaya. Kopanow amearifiwa. Piga simu msaada.",
                    Toast.LENGTH_LONG
                ).show()
                pinAttempts = 0
                setupLockCard()   // re-render to show tamper UI
            }
        }
    }

    private fun refreshDots() {
        pinDotViews.forEachIndexed { i, dot ->
            dot.setBackgroundResource(
                if (i < pinBuffer.length) R.drawable.pin_dot_filled else R.drawable.pin_dot_empty
            )
        }
    }

    private fun resetPinState()  { pinBuffer.clear(); refreshDots() }
    private fun showPinError()   {
        val tv = findViewById<TextView>(R.id.tv_pin_error)
        tv.visibility = View.VISIBLE
        Handler(Looper.getMainLooper()).postDelayed({ tv.visibility = View.GONE }, 2000)
    }
    private fun hidePinError()   {
        findViewById<TextView>(R.id.tv_pin_error).visibility = View.GONE
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Window / system flags
    // ─────────────────────────────────────────────────────────────────────────

    private fun blockBackButton() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { /* suppressed */ }
        })
    }

    private fun registerReceivers() {
        val filter = IntentFilter().apply {
            addAction(KopanowFCMService.ACTION_UNLOCK_SCREEN)
            addAction(FcmPinManager.ACTION_PASSCODE_CHANGED)
        }
        ContextCompat.registerReceiver(
            this, unlockReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    @Suppress("DEPRECATION")
    private fun applyLockWindowFlags() {
        window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val ctrl = window.insetsController ?: return
            ctrl.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            ctrl.systemBarsBehavior = WindowInsetsController.BEHAVIOR_DEFAULT
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE         or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN        or View.SYSTEM_UI_FLAG_LAYOUT_STABLE   or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }
    }

    private fun dismissKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        currentFocus?.let { imm.hideSoftInputFromWindow(it.windowToken, 0) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Backend verification
    // ─────────────────────────────────────────────────────────────────────────

    private fun checkLockStateFromBackend(force: Boolean = false) {
        val bId = KopanowPrefs.borrowerId ?: return
        val lId = KopanowPrefs.loanId     ?: return

        // FCM UNLOCK / REMOVE_ADMIN already cleared lock flags — dismiss without racing the heartbeat API.
        if (force && !KopanowPrefs.isLocked && !PasscodeManager.hasActivePasscode()) {
            activityScope.launch(Dispatchers.Main) {
                safelyDismiss()
            }
            return
        }

        activityScope.launch {
            try {
                val req = HeartbeatRequest(
                    borrowerId = bId, loanId = lId,
                    deviceId   = DeviceSecurityManager.getDeviceId(this@LockScreenActivity),
                    dpcActive  = DeviceSecurityManager.isAdminActive(this@LockScreenActivity),
                    isSafeMode = false, batteryPct = -1,
                    frpSeeded  = KopanowPrefs.frpSeeded,
                    timestamp  = System.currentTimeMillis()
                )
                val res = KopanowApi.heartbeat(req)
                if (res.success && res.data?.locked == false) {
                    Log.i(TAG, "checkLockStateFromBackend: backend confirms UNLOCKED — clearing all local lock state")
                    // Clear passcode + tamper flags so safelyDismiss() sees a clean slate.
                    // FCM handler normally does this, but the poll path must also cover the
                    // offline-FCM-delayed case.
                    KopanowPrefs.isPasscodeLocked = false
                    KopanowPrefs.passcodeHash     = null
                    KopanowPrefs.lockType         = KopanowPrefs.LOCK_TYPE_PAYMENT
                    KopanowLockService.stop(this@LockScreenActivity)
                    withContext(Dispatchers.Main) { safelyDismiss() }
                }
            } catch (e: Exception) {
                Log.e(TAG, "checkLockStateFromBackend: ${e.message}")
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dismiss
    // ─────────────────────────────────────────────────────────────────────────

    private fun safelyDismiss() {
        Log.i(TAG, "safelyDismiss — admin confirmed unlock")
        pollHandler.removeCallbacks(pollRunnable)
        KopanowPrefs.isLocked         = false
        KopanowPrefs.lockReason       = null
        KopanowPrefs.amountDue        = null
        KopanowPrefs.lockType         = KopanowPrefs.LOCK_TYPE_PAYMENT  // reset to default
        KopanowPrefs.isPasscodeLocked = false
        KopanowPrefs.passcodeHash     = null
        DeviceSecurityManager.unlockDevice(this)
        // Stop persistent foreground watchdog — device is fully unlocked
        KopanowLockService.stop(this)
        try { stopLockTask() } catch (_: Exception) {}
        finish()
    }

    private fun bringToFront() {
        startActivity(
            Intent(this, LockScreenActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK        or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
            }
        )
    }
}
