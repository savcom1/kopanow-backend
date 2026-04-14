# ============================================================
# Kopanow — Device Owner Setup Script
# Run this ONCE per device BEFORE giving it to the borrower
# ============================================================

$adb   = "C:\Users\casto\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$pkg   = "com.kopanow"
$admin = "com.kopanow/.KopanowAdminReceiver"
$apk   = "$PSScriptRoot\app\build\outputs\apk\debug\app-debug.apk"

Write-Host ""
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "  Kopanow Device Owner Setup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check device connected ───────────────────────────────────────────
Write-Host "Step 1: Checking connected devices..." -ForegroundColor Yellow
$deviceList = & $adb devices 2>&1
$connected  = $deviceList | Select-String "device$"
if (-not $connected) {
    Write-Host "  [FAIL] No device connected!" -ForegroundColor Red
    Write-Host "  -> Plug the phone in via USB" -ForegroundColor White
    Write-Host "  -> Go to Settings > Developer Options > USB Debugging > ON" -ForegroundColor White
    Write-Host "  -> Tap 'Allow' on the phone when prompted" -ForegroundColor White
    exit 1
}
Write-Host "  [OK] Device connected" -ForegroundColor Green

# ── Step 2: Install APK ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "Step 2: Installing Kopanow APK..." -ForegroundColor Yellow
if (-not (Test-Path $apk)) {
    Write-Host "  [FAIL] APK not found at: $apk" -ForegroundColor Red
    Write-Host "  -> Build the APK first in Android Studio (Build > Build APK)" -ForegroundColor White
    exit 1
}
$installResult = & $adb install -r $apk 2>&1
if ($installResult -match "Success") {
    Write-Host "  [OK] APK installed" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Install may have failed: $installResult" -ForegroundColor Yellow
    Write-Host "  -> Continuing anyway (app might already be installed)" -ForegroundColor White
}

# ── Step 3: Check existing Device Owner ───────────────────────────────────────
Write-Host ""
Write-Host "Step 3: Checking Device Owner status..." -ForegroundColor Yellow
$ownerResult = & $adb shell dpm list-owners 2>&1
if ($ownerResult -match $pkg) {
    Write-Host "  [OK] Kopanow is ALREADY Device Owner!" -ForegroundColor Green
    Write-Host ""
    Write-Host "====================================" -ForegroundColor Green
    Write-Host "  ALREADY SET UP — NOTHING TO DO" -ForegroundColor Green
    Write-Host "====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "System PIN is ready. Use the admin panel to lock this device." -ForegroundColor Cyan
    exit 0
}

# ── Step 4: Check Google accounts ─────────────────────────────────────────────
Write-Host ""
Write-Host "Step 4: Checking Google accounts..." -ForegroundColor Yellow
$accountsRaw = & $adb shell dumpsys account 2>&1
$googleAccounts = $accountsRaw | Select-String "google.com"
if ($googleAccounts) {
    Write-Host "  [FAIL] Google account detected on device!" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Device Owner can only be set BEFORE Google accounts are added." -ForegroundColor White
    Write-Host "  You have two options:" -ForegroundColor White
    Write-Host ""
    Write-Host "  OPTION A (Recommended): Factory reset the device" -ForegroundColor Yellow
    Write-Host "    Settings > General Management > Reset > Factory Data Reset" -ForegroundColor White
    Write-Host "    Then re-run this script after reset completes." -ForegroundColor White
    Write-Host ""
    Write-Host "  OPTION B: Remove Google account" -ForegroundColor Yellow
    Write-Host "    Settings > Accounts and Backup > Manage Accounts > Google > Remove" -ForegroundColor White
    Write-Host "    Then re-run this script." -ForegroundColor White
    exit 1
}
Write-Host "  [OK] No Google accounts — safe to set Device Owner" -ForegroundColor Green

# ── Step 5: Set Device Owner ──────────────────────────────────────────────────
Write-Host ""
Write-Host "Step 5: Setting Kopanow as Device Owner..." -ForegroundColor Yellow
$doResult = & $adb shell dpm set-device-owner $admin 2>&1
if ($doResult -match "Success") {
    Write-Host "  [OK] Device Owner set!" -ForegroundColor Green
    Write-Host ""
    Write-Host "====================================" -ForegroundColor Green
    Write-Host "  SETUP COMPLETE" -ForegroundColor Green
    Write-Host "====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next:" -ForegroundColor Cyan
    Write-Host "  1. Register the borrower in the app (open Kopanow app)" -ForegroundColor White
    Write-Host "  2. Unlock the phone screen once (activates DPM token)" -ForegroundColor White
    Write-Host "  3. Hand phone to borrower" -ForegroundColor White
    Write-Host "  4. Lock remotely via admin panel anytime" -ForegroundColor White
} else {
    Write-Host "  [FAIL] Could not set Device Owner" -ForegroundColor Red
    Write-Host "  Error: $doResult" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Most common fix: Factory reset the device first" -ForegroundColor White
    Write-Host "  Settings > General Management > Reset > Factory Data Reset" -ForegroundColor White
    exit 1
}
