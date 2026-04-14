package com.kopanow

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * TamperReportWorker — Expedited WorkManager worker.
 *
 * • Enqueued by [KopanowAdminReceiver] with EXPEDITED priority so it bypasses
 *   Doze / battery-saver and runs even during app shutdown.
 * • Retries up to MAX_RETRIES (5) times on network failure using exponential
 *   back-off configured by the caller; on the 6th attempt it gives up and
 *   calls Result.failure() so the job is not retried indefinitely.
 * • On Android < 12 the EXPEDITED requirement also promotes the worker to a
 *   foreground service, so getForegroundInfo() must be implemented.
 */
class TamperReportWorker(
    private val context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "TamperReportWorker"

        /** Maximum number of network-failure retries before giving up. */
        const val MAX_RETRIES = 5

        // Input data keys (set by KopanowAdminReceiver)
        const val KEY_BORROWER_ID = "borrower_id"
        const val KEY_LOAN_ID     = "loan_id"
        const val KEY_EVENT       = "event"

        // Notification channel for foreground service requirement (EXPEDITED)
        private const val CHANNEL_ID      = "kopanow_tamper_channel"
        private const val NOTIFICATION_ID = 9001
    }

    // ── Foreground promotion (required for EXPEDITED on Android < 12) ─────

    override suspend fun getForegroundInfo(): ForegroundInfo {
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Kopanow Security")
            .setContentText("Verifying device protection…")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    // ── Main work ─────────────────────────────────────────────────────────

    override suspend fun doWork(): Result {
        // runAttemptCount is 0-based: 0 = first attempt, 1 = first retry, …
        val attempt = runAttemptCount          // provided by WorkManager
        Log.w(TAG, "doWork: attempt ${attempt + 1}/${ MAX_RETRIES + 1}")

        // Hard cap — give up after MAX_RETRIES network failures
        if (attempt > MAX_RETRIES) {
            Log.e(TAG, "Exceeded $MAX_RETRIES retries — dropping tamper report")
            return Result.failure()
        }

        val borrowerId = inputData.getString(KEY_BORROWER_ID)
        val loanId     = inputData.getString(KEY_LOAN_ID)
        val event      = inputData.getString(KEY_EVENT) ?: "unknown_tamper"

        if (borrowerId == null || loanId == null) {
            Log.e(TAG, "Missing borrowerId or loanId — aborting without retry")
            return Result.failure()
        }

        Log.w(TAG, "Reporting tamper event='$event' for borrower=$borrowerId (attempt ${attempt + 1})")

        // 1. Report tamper event to backend
        val tamperResult = KopanowApi.reportTamper(borrowerId, loanId, event)
        if (!tamperResult.success) {
            Log.e(TAG, "reportTamper failed: ${tamperResult.error} — scheduling retry ${attempt + 1}/$MAX_RETRIES")
            return Result.retry()   // WorkManager applies exponential back-off set by the caller
        }
        Log.i(TAG, "Tamper reported successfully — event=$event")

        // 2. If device was locked, tell the backend that protection has been bypassed
        if (KopanowPrefs.isLocked) {
            val statusResult = KopanowApi.updateStatus(borrowerId, loanId, "suspended")
            if (!statusResult.success) {
                Log.e(TAG, "updateStatus failed: ${statusResult.error} (non-critical, not retrying)")
                // Non-critical path — don't retry the whole job for this alone
            }
        }

        return Result.success()
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Kopanow Security",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Device protection status updates" }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
