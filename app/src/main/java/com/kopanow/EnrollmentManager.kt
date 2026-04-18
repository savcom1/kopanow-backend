package com.kopanow

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/**
 * EnrollmentManager — orchestrates the full 3-step device enrollment flow.
 */
object EnrollmentManager {

    private const val TAG = "EnrollmentManager"
    const val REQUEST_CODE_ENABLE_ADMIN = 1001

    data class EligibilityResult(
        val eligible: Boolean,
        val reason: String? = null
    )

    fun checkDeviceEligibility(context: Context): EligibilityResult {
        val borrowerId = KopanowPrefs.borrowerId
        val loanId     = KopanowPrefs.loanId
        
        if (borrowerId.isNullOrBlank() || loanId.isNullOrBlank()) {
            return EligibilityResult(
                eligible = false,
                reason = "Loan session not configured."
            )
        }

        if (DeviceSecurityManager.isAdminActive(context)) {
            return EligibilityResult(eligible = false, reason = "Device already enrolled.")
        }

        val rootResult = DeviceSecurityManager.checkRoot(context)
        if (rootResult.isRooted) {
            return EligibilityResult(
                eligible = false,
                reason = "Rooted devices cannot be enrolled."
            )
        }

        return EligibilityResult(eligible = true)
    }

    /**
     * Supabase-backed check: [device_id] must not already be linked to another
     * borrower/loan. Run **before** [requestDeviceAdmin] so we never prompt for admin
     * when enrollment would be rejected after the fact.
     */
    suspend fun checkServerEnrollmentEligibility(context: Context): EligibilityResult {
        val borrowerId = KopanowPrefs.borrowerId
        val loanId = KopanowPrefs.loanId
        if (borrowerId.isNullOrBlank() || loanId.isNullOrBlank()) {
            return EligibilityResult(eligible = false, reason = "Loan session not configured.")
        }
        val deviceId = DeviceSecurityManager.getDeviceId(context)
        val result = KopanowApi.checkEnrollmentEligibility(deviceId, borrowerId, loanId)
        if (!result.success || result.data == null) {
            return EligibilityResult(
                eligible = false,
                reason = result.error ?: "Could not verify device with Kopanow. Check your internet connection."
            )
        }
        val body = result.data
        if (!body.success) {
            return EligibilityResult(false, reason = "Could not verify device with Kopanow.")
        }
        if (!body.allowed) {
            return EligibilityResult(
                eligible = false,
                reason = body.reason ?: "This device cannot be enrolled."
            )
        }
        return EligibilityResult(eligible = true)
    }

    fun requestDeviceAdmin(context: Context, launcher: ActivityResultLauncher<Intent>) {
        val adminComponent = ComponentName(context, KopanowAdminReceiver::class.java)
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent)
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "Kopanow requires administrator access to protect this device."
            )
        }
        launcher.launch(intent)
    }

    /**
     * Handles post-activation tasks with retries for FCM and Network.
     */
    fun onAdminActivated(
        activity: Activity,
        scope: CoroutineScope,
        onComplete: (success: Boolean, message: String) -> Unit
    ) {
        scope.launch(Dispatchers.IO) {
            try {
                // 1. Fetch FCM token with retry
                var fcmToken: String? = null
                repeat(3) { attempt ->
                    fcmToken = fetchFcmToken()
                    if (fcmToken != null) return@repeat
                    delay(2000)
                }

                if (fcmToken == null) {
                    notifyResult(onComplete, false, "Could not reach Google services.")
                    return@launch
                }

                KopanowPrefs.fcmToken = fcmToken

                // 2. Register with Kopanow Backend
                val borrowerId  = KopanowPrefs.borrowerId!!
                val loanId      = KopanowPrefs.loanId!!
                val phone       = KopanowPrefs.phoneNumber
                val deviceId    = DeviceSecurityManager.getDeviceId(activity)

                val result = KopanowApi.registerDevice(
                    context     = activity,
                    borrowerId  = borrowerId,
                    loanId      = loanId,
                    fcmToken    = fcmToken!!,
                    deviceId    = deviceId,
                    mpesaPhone  = phone
                )

                if (!result.success) {
                    notifyResult(onComplete, false, "Server registration failed: ${result.error}")
                    return@launch
                }

                // 3. FRP Seeding — Prompt to add the admin Google account
                withContext(Dispatchers.Main) {
                    FRPManager(activity).promptAccountSignIn(activity)
                }

                // 4. Security Hardening
                DeviceSecurityManager.disableUsbDebugging(activity)
                
                KopanowPrefs.isAdmin = true
                notifyResult(onComplete, true, "Enrollment successful!")

            } catch (e: Exception) {
                Log.e(TAG, "Enrollment fatal error", e)
                notifyResult(onComplete, false, "Enrollment error: ${e.localizedMessage}")
            }
        }
    }

    private fun notifyResult(
        onComplete: (Boolean, String) -> Unit,
        success: Boolean,
        message: String
    ) {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            onComplete(success, message)
        }
    }

    private suspend fun fetchFcmToken(): String? {
        return try {
            FirebaseMessaging.getInstance().token.await()
        } catch (e: Exception) {
            null
        }
    }
}
