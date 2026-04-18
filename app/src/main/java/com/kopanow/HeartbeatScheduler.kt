package com.kopanow

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * HeartbeatScheduler — central place to schedule / cancel [HeartbeatWorker].
 *
 * Any component that needs to (re-)start the heartbeat — [BootReceiver],
 * [MainActivity], [KopanowFCMService] — should use [schedule] rather than
 * building the WorkRequest inline, so the policy is consistent everywhere.
 */
object HeartbeatScheduler {

    private const val TAG = "HeartbeatScheduler"

    /** Repeat interval for the periodic heartbeat: 15 minutes (WorkManager minimum). */
    private const val REPEAT_INTERVAL_MINUTES = 15L

    /**
     * Schedule (or re-schedule) the periodic heartbeat.
     *
     * Uses [ExistingPeriodicWorkPolicy.UPDATE] so that:
     *  • A fresh period starts immediately after a reboot.
     *  • Any previously pending run is replaced, avoiding duplicate jobs.
     */
    fun schedule(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(
            REPEAT_INTERVAL_MINUTES, TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            HeartbeatWorker.UNIQUE_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,   // restart the period after reboot
            request
        )

        Log.i(TAG, "Heartbeat scheduled (interval=${REPEAT_INTERVAL_MINUTES}min, policy=UPDATE)")
    }

    /**
     * Schedule a one-shot, immediate heartbeat — used when the backend requests
     * an on-demand telemetry snapshot via [KopanowFCMService.TYPE_HEARTBEAT_REQUEST].
     *
     * Uses EXPEDITED priority so it runs as soon as a network slot is free,
     * even under Doze or battery-saver constraints. The unique name uses a
     * different suffix so it never collides with the periodic chain.
     */
    fun scheduleImmediate(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            "${HeartbeatWorker.UNIQUE_WORK_NAME}_immediate",
            ExistingWorkPolicy.REPLACE,   // always use the freshest request
            request
        )

        Log.i(TAG, "Immediate (expedited) heartbeat enqueued")
    }

    /** Cancel the heartbeat (call on logout or loan closure). */
    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(HeartbeatWorker.UNIQUE_WORK_NAME)
        Log.i(TAG, "Heartbeat cancelled")
    }
}
