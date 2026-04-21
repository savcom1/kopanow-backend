package com.kopanow

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Fires once ~1 hour after [ProtectionSetupTimeoutScheduler.scheduleIfNeeded] to enforce
 * incomplete checklist teardown.
 */
class ProtectionSetupTimeoutWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            KopanowPrefs.init(applicationContext)
            ProtectionSetupTeardown.run(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "doWork failed", e)
            Result.retry()
        }
    }

    companion object {
        private const val TAG = "ProtSetupTimeoutWkr"
    }
}
