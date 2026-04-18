package com.kopanow

import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.MaterialAutoCompleteTextView
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * RegistrationActivity — handles initial user identity collection.
 */
class RegistrationActivity : AppCompatActivity() {

    private val job = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + job)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KopanowPrefs.init(applicationContext)
        setContentView(R.layout.activity_registration)

        val etFullName   = findViewById<TextInputEditText>(R.id.et_full_name)
        val etNationalId = findViewById<TextInputEditText>(R.id.et_national_id)
        val etPhone      = findViewById<TextInputEditText>(R.id.et_phone)
        val etRegion     = findViewById<TextInputEditText>(R.id.et_region)
        val etAddress    = findViewById<TextInputEditText>(R.id.et_address)

        val etAmount     = findViewById<TextInputEditText>(R.id.et_loan_amount)
        val actvRepaymentMonths = findViewById<MaterialAutoCompleteTextView>(R.id.actv_repayment_months)
        val etPurpose    = findViewById<TextInputEditText>(R.id.et_loan_purpose)

        val tilPhone     = findViewById<TextInputLayout>(R.id.til_phone)
        val tilAmount    = findViewById<TextInputLayout>(R.id.til_loan_amount)
        val tilRepaymentMonths = findViewById<TextInputLayout>(R.id.til_repayment_months)
        val tilPurpose   = findViewById<TextInputLayout>(R.id.til_loan_purpose)

        val btnSubmit    = findViewById<MaterialButton>(R.id.btn_submit_request)
        val tvStatus     = findViewById<android.widget.TextView>(R.id.tv_request_status)

        // Pre-fill if user returns here
        etFullName.setText(KopanowPrefs.fullName ?: "")
        etNationalId.setText(KopanowPrefs.nationalId ?: "")
        etPhone.setText(KopanowPrefs.phoneNumber ?: "")
        etRegion.setText(KopanowPrefs.region ?: "")
        etAddress.setText(KopanowPrefs.address ?: "")
        if (KopanowPrefs.requestedLoanAmountTzs > 0) etAmount.setText(KopanowPrefs.requestedLoanAmountTzs.toString())
        val monthLabels = resources.getStringArray(R.array.repayment_month_options)
        actvRepaymentMonths.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_list_item_1, monthLabels.toList())
        )
        when {
            KopanowPrefs.requestedLoanRepaymentMonths in 1..3 ->
                actvRepaymentMonths.setText(monthLabels[KopanowPrefs.requestedLoanRepaymentMonths - 1], false)
            KopanowPrefs.requestedLoanTenorDays > 0 -> {
                val approxMonths = ((KopanowPrefs.requestedLoanTenorDays + 15) / 30).coerceIn(1, 3)
                actvRepaymentMonths.setText(monthLabels[approxMonths - 1], false)
            }
            else -> actvRepaymentMonths.setText(monthLabels[0], false)
        }
        etPurpose.setText(KopanowPrefs.requestedLoanPurpose ?: "")

        btnSubmit.setOnClickListener {
            val fullName = etFullName.text?.toString()?.trim().orEmpty()
            val nationalId = etNationalId.text?.toString()?.trim().orEmpty()
            val phone = etPhone.text?.toString()?.trim().orEmpty()
            val region = etRegion.text?.toString()?.trim().orEmpty()
            val address = etAddress.text?.toString()?.trim().orEmpty()

            val amount = etAmount.text?.toString()?.trim()?.toLongOrNull()
            val purpose = etPurpose.text?.toString()?.trim().orEmpty()

            // Basic validation
            tilPhone.error = null
            tilAmount.error = null
            tilRepaymentMonths.error = null
            tilPurpose.error = null

            // Tanzania M-Pesa format: 255XXXXXXXXX (12 digits)
            if (!phone.startsWith("255") || phone.length != 12) {
                tilPhone.error = "Use format 255XXXXXXXXX (12 digits)"
                return@setOnClickListener
            }

            if (fullName.length < 3 || nationalId.length < 5 || region.length < 2 || address.length < 5) {
                Toast.makeText(this, "Please complete your personal details.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (amount == null || amount <= 0) {
                tilAmount.error = "Enter a valid amount"
                return@setOnClickListener
            }
            val selectedLabel = actvRepaymentMonths.text?.toString()?.trim().orEmpty()
            val monthIdx = monthLabels.indexOf(selectedLabel)
            if (monthIdx < 0) {
                tilRepaymentMonths.error = "Select repayment period"
                return@setOnClickListener
            }
            val repaymentMonths = monthIdx + 1
            val tenorDays = repaymentMonths * 30
            if (purpose.length < 4) {
                tilPurpose.error = "Enter purpose"
                return@setOnClickListener
            }

            // Persist locally (even if network fails)
            if (KopanowPrefs.borrowerId.isNullOrBlank()) {
                // Simple stable local borrower id if backend doesn't provide one yet
                KopanowPrefs.borrowerId = "B-${System.currentTimeMillis()}"
            }
            KopanowPrefs.fullName = fullName
            KopanowPrefs.nationalId = nationalId
            KopanowPrefs.phoneNumber = phone
            KopanowPrefs.region = region
            KopanowPrefs.address = address
            KopanowPrefs.requestedLoanAmountTzs = amount
            KopanowPrefs.requestedLoanRepaymentMonths = repaymentMonths
            KopanowPrefs.requestedLoanTenorDays = tenorDays
            KopanowPrefs.requestedLoanPurpose = purpose

            btnSubmit.isEnabled = false
            btnSubmit.text = "Submitting…"
            tvStatus.visibility = View.VISIBLE
            tvStatus.text = "Submitting your request… (first request may take up to 60s)"

            val borrowerId = KopanowPrefs.borrowerId ?: return@setOnClickListener
            val androidDeviceId = DeviceSecurityManager.getDeviceId(this@RegistrationActivity)
            val dm = resources.displayMetrics
            val batteryPct: Int? = try {
                val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
                val p = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                if (p >= 0) p else null
            } catch (_: Exception) {
                null
            }
            val rooted = DeviceSecurityManager.checkRoot(this@RegistrationActivity).isRooted
            scope.launch {
                val result = KopanowApi.requestLoan(
                    LoanRequest(
                        borrowerId = borrowerId,
                        phone = phone,
                        fullName = fullName,
                        nationalId = nationalId,
                        region = region,
                        address = address,
                        amountTzs = amount,
                        repaymentMonths = repaymentMonths,
                        installmentWeeks = repaymentMonths * 4,
                        tenorDays = tenorDays,
                        purpose = purpose,
                        deviceId = androidDeviceId,
                        deviceModel = Build.MODEL,
                        manufacturer = Build.MANUFACTURER,
                        brand = Build.BRAND,
                        androidVersion = Build.VERSION.RELEASE,
                        sdkVersion = Build.VERSION.SDK_INT,
                        screenDensity = dm.densityDpi,
                        screenWidthDp = (dm.widthPixels / dm.density).toInt(),
                        screenHeightDp = (dm.heightPixels / dm.density).toInt(),
                        batteryPct = batteryPct,
                        buildProduct = Build.PRODUCT,
                        buildDevice = Build.DEVICE,
                        isRooted = rooted
                    )
                )
                withContext(Dispatchers.Main) {
                    btnSubmit.isEnabled = true
                    btnSubmit.text = "Submit Loan Request"
                    if (result.success && result.data?.success == true) {
                        // backend may return official ids
                        result.data.borrowerId?.let { KopanowPrefs.borrowerId = it }
                        result.data.loanId?.let { KopanowPrefs.loanId = it }
                        KopanowPrefs.isLoanRequestSubmitted = true
                        tvStatus.text = result.data.message ?: "Request submitted successfully."

                        KopanowLockService.start(this@RegistrationActivity)
                        HeartbeatScheduler.schedule(this@RegistrationActivity)

                        startActivity(Intent(this@RegistrationActivity, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        })
                        finish()
                    } else {
                        KopanowPrefs.isLoanRequestSubmitted = false
                        tvStatus.text = result.data?.message ?: (result.error ?: "Request failed. Please try again.")
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
