package com.kopanow

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object ProtectionSetupTimeoutScheduler {

    private const val TAG = "ProtSetupTimeoutSch"
    const val UNIQUE_WORK = "kopanow_protection_setup_timeout"
    private const val DELAY_HOURS = 1L

    /**
     * Schedule a one-shot worker 1 hour from now if not already scheduled and onboarding is incomplete.
     */
    fun scheduleIfNeeded(context: Context) {
        val ctx = context.applicationContext
        KopanowPrefs.init(ctx)
        if (KopanowPrefs.onboardingCompleted) return
        if (KopanowPrefs.protectionSetupTimedOut) return
        if (KopanowPrefs.protectionSetupDeadlineMs != 0L) return

        val deadline = System.currentTimeMillis() + TimeUnit.HOURS.toMillis(DELAY_HOURS)
        KopanowPrefs.protectionSetupDeadlineMs = deadline

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
            .build()

        val request = OneTimeWorkRequestBuilder<ProtectionSetupTimeoutWorker>()
            .setConstraints(constraints)
            .setInitialDelay(DELAY_HOURS, TimeUnit.HOURS)
            .build()

        WorkManager.getInstance(ctx).enqueueUniqueWork(
            UNIQUE_WORK,
            ExistingWorkPolicy.KEEP,
            request,
        )
        Log.i(TAG, "Scheduled protection setup timeout (${DELAY_HOURS}h)")
    }

    fun cancel(context: Context) {
        val ctx = context.applicationContext
        WorkManager.getInstance(ctx).cancelUniqueWork(UNIQUE_WORK)
        KopanowPrefs.protectionSetupDeadlineMs = 0L
        Log.i(TAG, "Cancelled protection setup timeout work")
    }
}
