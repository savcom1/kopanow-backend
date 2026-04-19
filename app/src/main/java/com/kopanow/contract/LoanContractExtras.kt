package com.kopanow.contract

import android.content.Intent

/**
 * Intent extras for [ContractActivity] (keys match product spec).
 */
data class LoanContractExtras(
    val loanId: String,
    val borrowerId: String,
    val borrowerName: String,
    val borrowerPhone: String,
    val borrowerRegion: String,
    val loanAmountTzs: Long,
    val totalRepaymentTzs: Long,
    val weeklyInstallmentTzs: Long,
    val numWeeks: Int,
    val loanStartDateIso: String,
    val firstRepaymentDateIso: String,
    val lastRepaymentDateIso: String,
    val contractNumber: String,
) {
    fun applyToIntent(target: Intent) {
        target.putExtra(EXTRA_LOAN_ID, loanId)
        target.putExtra(EXTRA_BORROWER_ID, borrowerId)
        target.putExtra(EXTRA_BORROWER_NAME, borrowerName)
        target.putExtra(EXTRA_BORROWER_PHONE, borrowerPhone)
        target.putExtra(EXTRA_BORROWER_REGION, borrowerRegion)
        target.putExtra(EXTRA_LOAN_AMOUNT, loanAmountTzs)
        target.putExtra(EXTRA_TOTAL_REPAYMENT, totalRepaymentTzs)
        target.putExtra(EXTRA_WEEKLY_INSTALLMENT, weeklyInstallmentTzs)
        target.putExtra(EXTRA_NUM_WEEKS, numWeeks)
        target.putExtra(EXTRA_LOAN_START_DATE, loanStartDateIso)
        target.putExtra(EXTRA_FIRST_REPAYMENT_DATE, firstRepaymentDateIso)
        target.putExtra(EXTRA_LAST_REPAYMENT_DATE, lastRepaymentDateIso)
        target.putExtra(EXTRA_CONTRACT_NUMBER, contractNumber)
    }

    companion object {
        const val EXTRA_LOAN_ID = "LOAN_ID"
        const val EXTRA_BORROWER_ID = "BORROWER_ID"
        const val EXTRA_BORROWER_NAME = "BORROWER_NAME"
        const val EXTRA_BORROWER_PHONE = "BORROWER_PHONE"
        const val EXTRA_BORROWER_REGION = "BORROWER_REGION"
        const val EXTRA_LOAN_AMOUNT = "LOAN_AMOUNT"
        const val EXTRA_TOTAL_REPAYMENT = "TOTAL_REPAYMENT"
        const val EXTRA_WEEKLY_INSTALLMENT = "WEEKLY_INSTALLMENT"
        const val EXTRA_NUM_WEEKS = "NUM_WEEKS"
        const val EXTRA_LOAN_START_DATE = "LOAN_START_DATE"
        const val EXTRA_FIRST_REPAYMENT_DATE = "FIRST_REPAYMENT_DATE"
        const val EXTRA_LAST_REPAYMENT_DATE = "LAST_REPAYMENT_DATE"
        const val EXTRA_CONTRACT_NUMBER = "CONTRACT_NUMBER"

        fun fromIntent(i: Intent): LoanContractExtras? {
            val loanId = i.getStringExtra(EXTRA_LOAN_ID) ?: return null
            val borrowerId = i.getStringExtra(EXTRA_BORROWER_ID) ?: return null
            val contractNumber = i.getStringExtra(EXTRA_CONTRACT_NUMBER) ?: return null
            return LoanContractExtras(
                loanId = loanId,
                borrowerId = borrowerId,
                borrowerName = i.getStringExtra(EXTRA_BORROWER_NAME).orEmpty(),
                borrowerPhone = i.getStringExtra(EXTRA_BORROWER_PHONE).orEmpty(),
                borrowerRegion = i.getStringExtra(EXTRA_BORROWER_REGION).orEmpty(),
                loanAmountTzs = i.getLongExtra(EXTRA_LOAN_AMOUNT, 0L),
                totalRepaymentTzs = i.getLongExtra(EXTRA_TOTAL_REPAYMENT, 0L),
                weeklyInstallmentTzs = i.getLongExtra(EXTRA_WEEKLY_INSTALLMENT, 0L),
                numWeeks = i.getIntExtra(EXTRA_NUM_WEEKS, 0),
                loanStartDateIso = i.getStringExtra(EXTRA_LOAN_START_DATE).orEmpty(),
                firstRepaymentDateIso = i.getStringExtra(EXTRA_FIRST_REPAYMENT_DATE).orEmpty(),
                lastRepaymentDateIso = i.getStringExtra(EXTRA_LAST_REPAYMENT_DATE).orEmpty(),
                contractNumber = contractNumber,
            )
        }
    }
}
