package com.kopanow

import android.util.Log
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit

// ─────────────────────────────────────────────
// Response / request data classes
// ─────────────────────────────────────────────

data class ApiResult<T>(
    val success: Boolean,
    val data: T? = null,
    val error: String? = null
)

data class HeartbeatRequest(
    @SerializedName("borrower_id")  val borrowerId: String,
    @SerializedName("loan_id")      val loanId: String,
    @SerializedName("device_id")    val deviceId: String,
    @SerializedName("dpc_active")   val dpcActive: Boolean,
    @SerializedName("is_safe_mode") val isSafeMode: Boolean,
    @SerializedName("battery_pct")  val batteryPct: Int,
    @SerializedName("frp_seeded")   val frpSeeded: Boolean,
    @SerializedName("timestamp")    val timestamp: Long
)

data class HeartbeatResponse(
    @SerializedName("action")      val action: String?,
    @SerializedName("locked")      val locked: Boolean,
    @SerializedName("lock_type")   val lockType: String?,
    @SerializedName("lock_reason") val lockReason: String?,
    @SerializedName("amount_due")  val amountDue: String?,
    @SerializedName("message")     val message: String?
)

data class RegisterDeviceRequest(
    @SerializedName("borrower_id")    val borrowerId: String,
    @SerializedName("loan_id")        val loanId: String,
    @SerializedName("fcm_token")      val fcmToken: String,
    @SerializedName("device_model")   val deviceModel: String,
    @SerializedName("device_id")      val deviceId: String,
    @SerializedName("mpesa_phone")    val mpesaPhone: String? = null,
    @SerializedName("manufacturer")   val manufacturer: String,
    @SerializedName("brand")          val brand: String,
    @SerializedName("android_version")val androidVersion: String,
    @SerializedName("sdk_version")    val sdkVersion: Int,
    @SerializedName("screen_density") val screenDensity: Int,
    @SerializedName("screen_width_dp")val screenWidthDp: Int,
    @SerializedName("screen_height_dp")val screenHeightDp: Int,
    @SerializedName("battery_pct")    val batteryPct: Int,
    @SerializedName("is_rooted")      val isRooted: Boolean,
    @SerializedName("enrolled_at")    val enrolledAt: Long = System.currentTimeMillis()
)

data class RegisterDeviceResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("message") val message: String?
)

data class EnrollmentCheckRequest(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("loan_id") val loanId: String
)

data class EnrollmentCheckResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("allowed") val allowed: Boolean,
    @SerializedName("reason") val reason: String? = null
)

data class TamperReportRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("loan_id") val loanId: String,
    @SerializedName("event") val event: String,
    @SerializedName("timestamp") val timestamp: Long
)

data class StatusUpdateRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("loan_id") val loanId: String,
    @SerializedName("status") val status: String
)

data class FcmTokenUpdateRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("fcm_token") val fcmToken: String
)

data class StkPushRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("loan_id")     val loanId: String,
    @SerializedName("amount")      val amount: Long,
    @SerializedName("timestamp")   val timestamp: Long
)

data class StkPushResponse(
    @SerializedName("success")          val success: Boolean,
    @SerializedName("checkout_request_id") val checkoutRequestId: String?,
    @SerializedName("message")          val message: String?
)

data class PaymentRefRequest(
    @SerializedName("borrower_id")    val borrowerId: String,
    @SerializedName("loan_id")        val loanId: String,
    @SerializedName("mpesa_ref")      val mpesaRef: String,
    @SerializedName("amount_claimed") val amountClaimed: Double?,
    @SerializedName("notes")          val notes: String?
)

data class PaymentRefResponse(
    @SerializedName("success")   val success: Boolean,
    @SerializedName("message")   val message: String?,
    @SerializedName("mpesa_ref") val mpesaRef: String?,
    @SerializedName("error")     val error: String?,
    @SerializedName("status")    val status: String?
)

data class PaymentStatusResponse(
    @SerializedName("success")     val success: Boolean,
    @SerializedName("submissions") val submissions: List<PaymentSubmission>?
)

data class PaymentSubmission(
    @SerializedName("mpesa_ref")      val mpesaRef: String,
    @SerializedName("amount_claimed") val amountClaimed: Double?,
    @SerializedName("status")         val status: String,
    @SerializedName("submitted_at")   val submittedAt: String,
    @SerializedName("reviewer_note")  val reviewerNote: String?
)

data class LoanRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("phone") val phone: String,
    @SerializedName("full_name") val fullName: String,
    @SerializedName("national_id") val nationalId: String,
    @SerializedName("region") val region: String,
    @SerializedName("address") val address: String,
    @SerializedName("amount_tzs") val amountTzs: Long,
    @SerializedName("tenor_days") val tenorDays: Int,
    @SerializedName("purpose") val purpose: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis()
)

data class LoanRequestResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("message") val message: String?,
    @SerializedName("borrower_id") val borrowerId: String?,
    @SerializedName("loan_id") val loanId: String?
)

data class SystemPinReportRequest(
    @SerializedName("borrower_id") val borrowerId: String,
    @SerializedName("loan_id")     val loanId: String,
    @SerializedName("pin")         val pin: String,
    @SerializedName("timestamp")   val timestamp: Long
)

data class SystemPinReportResponse(
    @SerializedName("success")     val success: Boolean,
    @SerializedName("message")     val message: String?,
    @SerializedName("error")       val error: String?
)


data class LoanDetailsResponse(
    @SerializedName("success")       val success: Boolean,
    @SerializedName("loan_status")   val loanStatus: String?,
    @SerializedName("balance")       val balance: String?,
    @SerializedName("next_due_date") val nextDueDate: String?,
    @SerializedName("message")       val message: String?
)

data class FrpTokenResponse(
    @SerializedName("ok")         val ok: Boolean,
    @SerializedName("frp_token")  val frpToken: String?,
    @SerializedName("expires_in") val expiresIn: Int?,
    @SerializedName("error")      val error: String?
)

// ─────────────────────────────────────────────
// HTTP Client Singleton
// ─────────────────────────────────────────────

object KopanowApi {

    private const val TAG = "KopanowApi"
    
    // ── Backend URL ──────────────────────────────────────────────────────────
    // Always use the production Render URL for real devices.
    // For emulator testing, override BASE_URL_OVERRIDE in local.properties → BuildConfig.
    private const val PRODUCTION_URL = "https://kopanow-backend.onrender.com/api"
    private const val EMULATOR_URL   = "http://10.0.2.2:3000/api"

    private val BASE_URL: String
        get() {
            val isEmulator = android.os.Build.FINGERPRINT.startsWith("generic")
                || android.os.Build.FINGERPRINT.startsWith("unknown")
                || android.os.Build.MODEL.contains("google_sdk")
                || android.os.Build.MODEL.contains("Emulator")
                || android.os.Build.MODEL.contains("Android SDK built for x86")
                || android.os.Build.MANUFACTURER.contains("Genymotion")
                || (android.os.Build.BRAND.startsWith("generic") && android.os.Build.DEVICE.startsWith("generic"))
                || android.os.Build.PRODUCT == "google_sdk"
            return if (isEmulator) EMULATOR_URL else PRODUCTION_URL
        }

    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val gson = Gson()

    private val client: OkHttpClient by lazy {
        val logging = HttpLoggingInterceptor { Log.d(TAG, it) }.apply {
            level = HttpLoggingInterceptor.Level.BODY
        }
        OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(logging)
            .build()
    }

    private suspend fun <T> post(path: String, payload: Any, responseType: Class<T>): ApiResult<T> = withContext(Dispatchers.IO) {
        val url = "$BASE_URL$path"
        Log.d(TAG, "POST $url")
        try {
            val body = gson.toJson(payload).toRequestBody(JSON)
            val request = Request.Builder().url(url).post(body).build()
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""
            Log.d(TAG, "POST $url → ${response.code}: $responseBody")
            if (response.isSuccessful) {
                ApiResult(success = true, data = gson.fromJson(responseBody, responseType))
            } else {
                // Try to parse {message} or {error} from body for a friendlier message
                val errMsg = try {
                    val obj = gson.fromJson(responseBody, Map::class.java)
                    (obj["message"] ?: obj["error"])?.toString() ?: "HTTP ${response.code}"
                } catch (_: Exception) { "HTTP ${response.code}" }
                ApiResult(success = false, error = errMsg)
            }
        } catch (e: java.net.ConnectException) {
            Log.e(TAG, "POST $url — cannot connect", e)
            ApiResult(success = false, error = "Cannot reach server. Check your internet connection.")
        } catch (e: java.net.SocketTimeoutException) {
            Log.e(TAG, "POST $url — timeout", e)
            ApiResult(success = false, error = "Request timed out. Server may be waking up — please try again.")
        } catch (e: Exception) {
            Log.e(TAG, "POST $url failed", e)
            ApiResult(success = false, error = e.message ?: "Unknown error")
        }
    }

    private suspend fun <T> get(path: String, params: Map<String, String>, responseType: Class<T>): ApiResult<T> = withContext(Dispatchers.IO) {
        try {
            val urlBuilder = "$BASE_URL$path".toHttpUrlOrNull()?.newBuilder()
            if (urlBuilder == null) return@withContext ApiResult(success = false, error = "Invalid URL")
            params.forEach { (key, value) -> urlBuilder.addQueryParameter(key, value) }
            
            val request = Request.Builder().url(urlBuilder.build()).get().build()
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""
            if (response.isSuccessful) {
                ApiResult(success = true, data = gson.fromJson(responseBody, responseType))
            } else {
                ApiResult(success = false, error = "HTTP ${response.code}: $responseBody")
            }
        } catch (e: Exception) {
            Log.e(TAG, "GET $path failed", e)
            ApiResult(success = false, error = e.message)
        }
    }

    suspend fun heartbeat(request: HeartbeatRequest): ApiResult<HeartbeatResponse> =
        post("/device/heartbeat", request, HeartbeatResponse::class.java)

    suspend fun registerDevice(
        context: android.content.Context,
        borrowerId: String,
        loanId: String,
        fcmToken: String,
        deviceId: String,
        mpesaPhone: String? = null
    ): ApiResult<RegisterDeviceResponse> {
        val dm = context.resources.displayMetrics
        val bm = context.getSystemService(android.content.Context.BATTERY_SERVICE) as android.os.BatteryManager
        val battery = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val isRooted = DeviceSecurityManager.checkRoot(context).isRooted

        val request = RegisterDeviceRequest(
            borrowerId    = borrowerId,
            loanId        = loanId,
            fcmToken      = fcmToken,
            deviceModel   = android.os.Build.MODEL,
            deviceId      = deviceId,
            mpesaPhone    = mpesaPhone,
            manufacturer  = android.os.Build.MANUFACTURER,
            brand         = android.os.Build.BRAND,
            androidVersion= android.os.Build.VERSION.RELEASE,
            sdkVersion    = android.os.Build.VERSION.SDK_INT,
            screenDensity = dm.densityDpi,
            screenWidthDp = (dm.widthPixels / dm.density).toInt(),
            screenHeightDp= (dm.heightPixels / dm.density).toInt(),
            batteryPct    = battery,
            isRooted      = isRooted
        )
        return post("/device/register", request, RegisterDeviceResponse::class.java)
    }

    /**
     * Ask the backend whether this [deviceId] is already linked to another loan in Supabase.
     * Call before showing the device-admin enrollment flow.
     */
    suspend fun checkEnrollmentEligibility(
        deviceId: String,
        borrowerId: String,
        loanId: String
    ): ApiResult<EnrollmentCheckResponse> =
        post(
            "/device/enrollment-check",
            EnrollmentCheckRequest(deviceId, borrowerId, loanId),
            EnrollmentCheckResponse::class.java
        )

    suspend fun reportTamper(borrowerId: String, loanId: String, event: String): ApiResult<RegisterDeviceResponse> =
        post("/device/tamper", TamperReportRequest(borrowerId, loanId, event, System.currentTimeMillis()), RegisterDeviceResponse::class.java)

    suspend fun updateStatus(borrowerId: String, loanId: String, status: String): ApiResult<RegisterDeviceResponse> =
        post("/device/status", StatusUpdateRequest(borrowerId, loanId, status), RegisterDeviceResponse::class.java)

    suspend fun updateFcmToken(borrowerId: String, fcmToken: String): ApiResult<RegisterDeviceResponse> =
        post("/device/fcm-token", FcmTokenUpdateRequest(borrowerId, fcmToken), RegisterDeviceResponse::class.java)

    suspend fun initiateStkPush(borrowerId: String, loanId: String, amount: Long): ApiResult<StkPushResponse> =
        post("/mpesa/stk-push", StkPushRequest(borrowerId, loanId, amount, System.currentTimeMillis()), StkPushResponse::class.java)

    suspend fun submitPaymentReference(
        borrowerId: String,
        loanId: String,
        mpesaRef: String,
        amountClaimed: Double? = null,
        notes: String? = null
    ): ApiResult<PaymentRefResponse> =
        post(
            "/payment/submit",
            PaymentRefRequest(borrowerId, loanId, mpesaRef, amountClaimed, notes),
            PaymentRefResponse::class.java
        )

    /**
     * Submit a loan request before activation/enrollment is allowed.
     * Backend should create/return a loan reference (loan_id) if approved/created.
     */
    suspend fun requestLoan(request: LoanRequest): ApiResult<LoanRequestResponse> =
        post("/loan/request", request, LoanRequestResponse::class.java)

    suspend fun pollPaymentStatus(
        borrowerId: String,
        loanId: String
    ): ApiResult<PaymentStatusResponse> =
        get(
            "/payment/status",
            mapOf("borrower_id" to borrowerId, "loan_id" to loanId),
            PaymentStatusResponse::class.java
        )

    /**
     * Report the device-generated system PIN to the backend.
     * The backend stores it (AES-encrypted) so admin can read it to the borrower.
     */
    suspend fun reportSystemPin(
        borrowerId: String,
        loanId:     String,
        pin:        String
    ): ApiResult<SystemPinReportResponse> =
        post(
            "/pin/report",
            SystemPinReportRequest(borrowerId, loanId, pin, System.currentTimeMillis()),
            SystemPinReportResponse::class.java
        )

    suspend fun getLoanDetails(borrowerId: String, loanId: String): ApiResult<LoanDetailsResponse> =
        get("/device/details", mapOf("borrower_id" to borrowerId, "loan_id" to loanId), LoanDetailsResponse::class.java)

    suspend fun getFrpToken(borrowerId: String): String? {
        val result = get(
            "/device/frp-token",
            mapOf("borrower_id" to borrowerId),
            FrpTokenResponse::class.java
        )
        return if (result.success && result.data?.ok == true) result.data.frpToken else null
    }
}
