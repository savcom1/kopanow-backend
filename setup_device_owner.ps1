# ============================================================
# Kopanow — Device Owner Setup Script
# Run this ONCE per device before any Google accounts are added
# ============================================================

$adb = "C:\Users\casto\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$pkg = "com.kopanow"
$admin = ".KopanowAdminReceiver"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kopanow Device Owner Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check device connected
Write-Host "Step 1: Checking connected devices..." -ForegroundColor Yellow
$devices = & $adb devices | Select-String "device$"
if (-not $devices) {
    Write-Host "✗ No device connected!" -ForegroundColor Red
    Write-Host "  → Connect the phone via USB" -ForegroundColor White
    Write-Host "  → Enable USB Debugging: Settings > Developer Options > USB Debugging" -ForegroundColor White
    Write-Host "  → Accept the 'Allow USB Debugging' prompt on the phone" -ForegroundColor White
    exit 1
}
Write-Host "✓ Device found: $devices" -ForegroundColor Green

# 2. Check if app is installed
Write-Host ""
Write-Host "Step 2: Checking if Kopanow is installed..." -ForegroundColor Yellow
$installed = & $adb shell pm list packages | Select-String $pkg
if (-not $installed) {
    Write-Host "✗ Kopanow app not installed yet!" -ForegroundColor Red
    Write-Host "  → Install the APK first, then re-run this script" -ForegroundColor White
    exit 1
}
Write-Host "✓ Kopanow installed" -ForegroundColor Green

# 3. Check Google accounts (must be zero for set-device-owner to work)
Write-Host ""
Write-Host "Step 3: Checking Google accounts on device..." -ForegroundColor Yellow
$accounts = & $adb shell dumpsys account | Select-String "Account {name=" | Select-String "google"
if ($accounts) {
    Write-Host "✗ Google accounts found on device!" -ForegroundColor Red
    Write-Host "  Device Owner can only be set on a device with NO Google accounts." -ForegroundColor White
    Write-Host "  Options:" -ForegroundColor White
    Write-Host "  a) Factory reset the device (wipes all data)" -ForegroundColor White
    Write-Host "  b) Remove all Google accounts: Settings > Accounts > Google > Remove" -ForegroundColor White
    Write-Host "  Then re-run this script." -ForegroundColor White
    Write-Host ""
    Write-Host "  Accounts found:" -ForegroundColor Yellow
    $accounts | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    exit 1
}
Write-Host "✓ No Google accounts — safe to set Device Owner" -ForegroundColor Green

# 4. Check current Device Owner
Write-Host ""
Write-Host "Step 4: Checking current Device Owner..." -ForegroundColor Yellow
$currentOwner = & $adb shell dpm list-owners 2>&1
Write-Host "  Current owner status: $currentOwner" -ForegroundColor Gray
if ($currentOwner -like "*$pkg*") {
    Write-Host "✓ Kopanow is ALREADY the Device Owner! Nothing to do." -ForegroundColor Green
    Write-Host ""
    Write-Host "System PIN is ready. Send SET_SYSTEM_PIN from the admin panel." -ForegroundColor Cyan
    exit 0
}

# 5. Set Device Owner
Write-Host ""
Write-Host "Step 5: Setting Kopanow as Device Owner..." -ForegroundColor Yellow
$result = & $adb shell dpm set-device-owner "$pkg/$admin" 2>&1
if ($result -like "*Success*") {
    Write-Host "✓ Device Owner set successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  SETUP COMPLETE" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Unlock the device screen once (activates the DPM reset token)" -ForegroundColor White
    Write-Host "  2. Send SET_SYSTEM_PIN from the admin panel" -ForegroundColor White
    Write-Host "  3. Check Logcat for: 'Reset token active ✓'" -ForegroundColor White
} else {
    Write-Host "✗ Failed to set Device Owner!" -ForegroundColor Red
    Write-Host "  Error: $result" -ForegroundColor Red
    Write-Host ""
    Write-Host "Common fixes:" -ForegroundColor Yellow
    Write-Host "  - Remove all Google accounts from the device first" -ForegroundColor White
    Write-Host "  - Factory reset if accounts can't be removed" -ForegroundColor White
    Write-Host "  - Make sure USB Debugging is enabled" -ForegroundColor White
}
