# Android Signing — ProxiTalk Release

## Create upload keystore (once)
```bash
keytool -genkeypair -v -keystore proxitalk-upload.jks -alias proxitalk -keyalg RSA -keysize 2048 -validity 10000
```
⚠️ **Back this up.** Losing it means you can't update the Play Store app.

## Configure Gradle
In `android/app/build.gradle`:
```gradle
signingConfigs {
    release {
        storeFile file('../proxitalk-upload.jks')
        storePassword System.getenv('KEYSTORE_PASSWORD')
        keyAlias 'proxitalk'
        keyPassword System.getenv('KEY_PASSWORD')
    }
}
buildTypes { release { signingConfig signingConfigs.release; minifyEnabled true } }
```

## Build release
```bash
export KEYSTORE_PASSWORD=... KEY_PASSWORD=...
cd android && ./gradlew bundleRelease
# AAB at: app/build/outputs/bundle/release/app-release.aab
```

## Never commit the keystore or passwords to git.
Add to `.gitignore`: `*.jks`, `*.keystore`, `local.properties`
