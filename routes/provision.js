'use strict';
const router = require('express').Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/provision/info
//
// Returns the Android DPC (Device Policy Controller) provisioning payload.
// The admin panel uses this to render a QR code.
//
// How QR provisioning works (no USB cable needed):
//  1. Factory reset the borrower's phone
//  2. On the "Welcome / Hi there" screen, tap the screen 6 TIMES quickly
//     → this opens Android's QR code provisioner
//  3. Scan the QR code shown on /admin/provision page
//  4. The phone auto-downloads the Kopanow APK and installs it as Device Owner
//  5. Done — all future locking is remote via FCM
// ─────────────────────────────────────────────────────────────────────────────
router.get('/info', (req, res) => {
  const apkUrl      = process.env.APK_DOWNLOAD_URL || 'https://kopanow-backend.onrender.com/kopanow.apk';
  const apkChecksum = process.env.APK_SHA256_BASE64URL || '';

  const provisioningPayload = {
    // Required: the Device Admin component to set as Device Owner
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME':
      'com.kopanow/.KopanowAdminReceiver',

    // Required: publicly accessible URL where the phone downloads the APK
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': apkUrl,

    // Required: SHA-256 of the APK in base64url format (no padding)
    // Generate with: certutil -hashfile kopanow.apk SHA256 then convert to base64url
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': apkChecksum,

    // Skip storage encryption prompt (optional, speeds up provisioning)
    'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': false,

    // Leave Wi-Fi blank — phone uses whatever network it's on
    // To pre-configure Wi-Fi add these:
    // 'android.app.extra.PROVISIONING_WIFI_SSID': 'YourNetwork',
    // 'android.app.extra.PROVISIONING_WIFI_PASSWORD': 'YourPassword',
    // 'android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE': 'WPA',
  };

  return res.json({
    success:  true,
    payload:  provisioningPayload,
    apk_url:  apkUrl,
    checksum: apkChecksum || '(not configured — set APK_SHA256_BASE64URL in .env)',
    instructions: [
      '1. Factory reset the borrower phone',
      '2. On Welcome screen, tap screen 6 times quickly',
      '3. Phone opens QR scanner — scan the QR code on /admin/provision',
      '4. Phone downloads Kopanow APK and sets it as Device Owner automatically',
      '5. Open Kopanow app, register borrower, done',
    ]
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /kopanow.apk  (served from server.js static route)
//
// The APK file itself can be placed in the /public folder on the server
// or hosted via GitHub Releases. Update APK_DOWNLOAD_URL in .env accordingly.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;
