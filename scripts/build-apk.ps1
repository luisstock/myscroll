# Builds the signed MyScroll .apk on this PC (same result as the GitHub workflow).
# Uses the Android SDK and JDK in E:\Android and the signing key in .signing\ (never committed).
# Usage (from the project folder):  .\scripts\build-apk.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$env:JAVA_HOME = "E:\Android\jdk-21.0.12.1+1"
$env:ANDROID_HOME = "E:\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:ANDROID_KEYSTORE_FILE = Join-Path $root ".signing\myscroll.p12"
$env:ANDROID_KEYSTORE_PASSWORD = (Get-Content (Join-Path $root ".signing\password.txt") -Raw).Trim()

Set-Content -Path (Join-Path $root "android\local.properties") -Value "sdk.dir=E\:\\Android\\Sdk" -Encoding ascii

Push-Location $root
try {
  node scripts/build-app.mjs
  npx cap sync android
  Push-Location android
  .\gradlew.bat assembleRelease --no-daemon
  Pop-Location
  $out = Join-Path $root "MyScroll.apk"
  Copy-Item "android\app\build\outputs\apk\release\app-release.apk" $out -Force
  Write-Host "APK ready: $out"
} finally {
  Pop-Location
}
