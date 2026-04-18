package com.kopanow

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * Unit tests for local overdue PIN deadline (no Android / network).
 */
class RepaymentOverdueCheckerTest {

    private val zone = ZoneId.of("Africa/Dar_es_Salaam")

    private fun sampleInvoice(dueDate: String, status: String = "pending") = LoanInvoiceItem(
        invoiceNumber = "INV-TEST-1",
        installmentIndex = 1,
        borrowerName = null,
        amountDue = 50_000.0,
        dueDate = dueDate,
        status = status,
        paidAt = null
    )

    @Test
    fun `enforces only at or after 08_00 local on calendar day after due`() {
        val inv = sampleInvoice("2026-04-10T12:00:00Z")
        val dueLocal = Instant.parse(inv.dueDate).atZone(zone).toLocalDate()
        val pinStart = dueLocal.plusDays(1).atTime(8, 0).atZone(zone).toInstant()

        assertFalse(
            RepaymentOverdueChecker.shouldEnforceLocalPinNow(inv, pinStart.minusSeconds(1), zone)
        )
        assertTrue(
            RepaymentOverdueChecker.shouldEnforceLocalPinNow(inv, pinStart, zone)
        )
    }

    @Test
    fun `paid invoice never enforces`() {
        val inv = sampleInvoice("2019-01-01T00:00:00Z", status = "paid")
        assertFalse(
            RepaymentOverdueChecker.shouldEnforceLocalPinNow(inv, Instant.parse("2030-01-01T00:00:00Z"), zone)
        )
    }
}
