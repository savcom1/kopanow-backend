package com.kopanow

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText

/**
 * RegistrationActivity — handles initial user identity collection.
 */
class RegistrationActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_registration)

        val etBorrowerId = findViewById<TextInputEditText>(R.id.et_borrower_id)
        val etLoanId     = findViewById<TextInputEditText>(R.id.et_loan_id)
        val etPhone      = findViewById<TextInputEditText>(R.id.et_phone)
        val btnContinue  = findViewById<MaterialButton>(R.id.btn_continue)

        btnContinue.setOnClickListener {
            val borrowerId = etBorrowerId.text.toString().trim()
            val loanId     = etLoanId.text.toString().trim()
            val phone      = etPhone.text.toString().trim()

            if (borrowerId.isEmpty() || loanId.isEmpty() || phone.isEmpty()) {
                Toast.makeText(this, "Please fill in all fields", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            
            // Tanzania M-Pesa format: 255XXXXXXXXX (12 digits)
            if (!phone.startsWith("255") || phone.length != 12) {
                Toast.makeText(this, "Phone must start with 255 and be 12 digits (e.g. 255712345678)", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            // Persist the session data
            KopanowPrefs.borrowerId  = borrowerId
            KopanowPrefs.loanId      = loanId
            KopanowPrefs.phoneNumber = phone

            // Proceed to MainActivity for enrollment flow
            startActivity(Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            })
            finish()
        }
    }
}
