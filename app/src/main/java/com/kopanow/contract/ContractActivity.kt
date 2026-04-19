package com.kopanow.contract

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.ViewTreeObserver
import androidx.activity.OnBackPressedCallback
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.widget.NestedScrollView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.kopanow.BuildConfig
import com.kopanow.ContractAcceptanceRequest
import com.kopanow.DeviceSecurityManager
import com.kopanow.KopanowPrefs
import com.kopanow.R
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_BORROWER_ID
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_BORROWER_NAME
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_BORROWER_PHONE
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_BORROWER_REGION
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_CONTRACT_NUMBER
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_FIRST_REPAYMENT_DATE
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_LAST_REPAYMENT_DATE
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_LOAN_AMOUNT
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_LOAN_ID
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_LOAN_START_DATE
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_NUM_WEEKS
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_TOTAL_REPAYMENT
import com.kopanow.contract.LoanContractExtras.Companion.EXTRA_WEEKLY_INSTALLMENT
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.format.DateTimeFormatter

@AndroidEntryPoint
class ContractActivity : AppCompatActivity() {

    private val viewModel: ContractViewModel by viewModels()

    private var scrolledToBottom = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KopanowPrefs.init(applicationContext)
        setContentView(R.layout.activity_contract)

        val extras = LoanContractExtras.fromIntent(intent)
        if (extras == null) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar_contract)
        setSupportActionBar(toolbar)
        AppCompatResources.getDrawable(this, androidx.appcompat.R.drawable.abc_ic_ab_back_material)?.let {
            toolbar.navigationIcon = it
        }
        toolbar.setNavigationOnClickListener { finishCancelled() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    finishCancelled()
                }
            },
        )

        val scroll = findViewById<NestedScrollView>(R.id.scroll_contract)
        val tvBody = findViewById<android.widget.TextView>(R.id.tv_contract_body)
        val btnReject = findViewById<MaterialButton>(R.id.btn_contract_reject)
        val btnAccept = findViewById<MaterialButton>(R.id.btn_contract_accept)

        val scheduleRows = ContractScheduleHelper.buildWeeklyRows(
            extras.loanStartDateIso,
            extras.totalRepaymentTzs,
            extras.numWeeks,
        )
        tvBody.text = ContractCopy.buildContractText(extras, scheduleRows)

        fun syncAcceptEnabled() {
            val submitting = viewModel.uiState.value.isSubmitting
            btnAccept.isEnabled = scrolledToBottom && !submitting
        }

        scroll.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                scroll.viewTreeObserver.removeOnGlobalLayoutListener(this)
                val child = scroll.getChildAt(0) ?: return
                scrolledToBottom = child.height <= scroll.height
                syncAcceptEnabled()
            }
        })

        val threshold = resources.displayMetrics.density * 24f
        scroll.setOnScrollChangeListener { v: NestedScrollView, _, scrollY, _, _ ->
            val child = v.getChildAt(0) ?: return@setOnScrollChangeListener
            scrolledToBottom = scrollY + v.height >= child.height - threshold
            syncAcceptEnabled()
        }

        btnReject.setOnClickListener { finishCancelled() }

        btnAccept.setOnClickListener {
            val acceptedAt = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
            val deviceId = DeviceSecurityManager.getDeviceId(this)
            val req = ContractAcceptanceRequest(
                contractNumber = extras.contractNumber,
                loanId = extras.loanId,
                borrowerId = extras.borrowerId,
                borrowerName = extras.borrowerName,
                borrowerPhone = extras.borrowerPhone,
                borrowerRegion = extras.borrowerRegion,
                loanAmountTzs = extras.loanAmountTzs,
                totalRepaymentTzs = extras.totalRepaymentTzs,
                weeklyInstallmentTzs = extras.weeklyInstallmentTzs,
                numWeeks = extras.numWeeks,
                loanStartDate = extras.loanStartDateIso,
                firstRepaymentDate = extras.firstRepaymentDateIso,
                lastRepaymentDate = extras.lastRepaymentDateIso,
                deviceAndroidModel = null,
                deviceImei = null,
                deviceSerial = null,
                googleAccount = null,
                androidDeviceId = deviceId,
                appVersion = BuildConfig.VERSION_NAME,
                acceptedAt = acceptedAt,
            )
            viewModel.submitAcceptance(req)
        }

        var lastError: String? = null
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state ->
                    btnAccept.text = if (state.isSubmitting) {
                        getString(R.string.contract_submitting)
                    } else {
                        getString(R.string.contract_btn_accept)
                    }
                    syncAcceptEnabled()
                    val err = state.error
                    if (!err.isNullOrBlank() && err != lastError) {
                        lastError = err
                        MaterialAlertDialogBuilder(this@ContractActivity)
                            .setTitle(R.string.contract_error_title)
                            .setMessage(err)
                            .setPositiveButton(android.R.string.ok, null)
                            .show()
                    }
                    if (state.success) {
                        viewModel.consumeSuccess()
                        MaterialAlertDialogBuilder(this@ContractActivity)
                            .setTitle(R.string.contract_success_title)
                            .setMessage(R.string.contract_success_message)
                            .setPositiveButton(android.R.string.ok) { _, _ ->
                                setResult(RESULT_OK)
                                finish()
                            }
                            .setCancelable(false)
                            .show()
                    }
                }
            }
        }
    }

    private fun finishCancelled() {
        setResult(RESULT_CANCELED)
        finish()
    }

    companion object {

        fun createIntent(ctx: Context, extras: LoanContractExtras): Intent =
            Intent(ctx, ContractActivity::class.java).apply { extras.applyToIntent(this) }

        fun putExtras(
            intent: Intent,
            loanId: String,
            borrowerId: String,
            borrowerName: String,
            borrowerPhone: String,
            borrowerRegion: String,
            loanAmount: Long,
            totalRepayment: Long,
            weeklyInstallment: Long,
            numWeeks: Int,
            loanStart: String,
            firstRepay: String,
            lastRepay: String,
            contractNumber: String,
        ) {
            intent.putExtra(EXTRA_LOAN_ID, loanId)
            intent.putExtra(EXTRA_BORROWER_ID, borrowerId)
            intent.putExtra(EXTRA_BORROWER_NAME, borrowerName)
            intent.putExtra(EXTRA_BORROWER_PHONE, borrowerPhone)
            intent.putExtra(EXTRA_BORROWER_REGION, borrowerRegion)
            intent.putExtra(EXTRA_LOAN_AMOUNT, loanAmount)
            intent.putExtra(EXTRA_TOTAL_REPAYMENT, totalRepayment)
            intent.putExtra(EXTRA_WEEKLY_INSTALLMENT, weeklyInstallment)
            intent.putExtra(EXTRA_NUM_WEEKS, numWeeks)
            intent.putExtra(EXTRA_LOAN_START_DATE, loanStart)
            intent.putExtra(EXTRA_FIRST_REPAYMENT_DATE, firstRepay)
            intent.putExtra(EXTRA_LAST_REPAYMENT_DATE, lastRepay)
            intent.putExtra(EXTRA_CONTRACT_NUMBER, contractNumber)
        }
    }
}
