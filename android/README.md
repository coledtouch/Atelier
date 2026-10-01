# Atelier Assist (Android)

A small companion app that opens Atelier as a pop-up when you press and hold the side button on a Samsung phone, the
way Gemini or ChatGPT do. It is sideloaded and for the owner only: it is not published anywhere and has no analytics,
ads or trackers.

- **Package:** `ai.ciprari.atelier.assist`. **Label:** "Atelier Assist" (so it is easy to tell apart from the
  installed PWA, "Atelier").
- **What it is:** one translucent activity (`AssistActivity`). It slides up a bottom sheet in Atelier's colours
  (rounded top, drag handle) that shows https://atelier.ciprari.ai in a WebView.
- **How it opens:**
  - `android.intent.action.ASSIST`, which the system sends to the default digital assistant. On Samsung that is
    Side button › Press and hold, plus the corner swipe.
  - `MAIN`/`LAUNCHER`, so the app icon and Side button › Double press › Open app give the same pop-up.
- **Sheet:** about 70% of the screen. Tap the handle to switch between that and full height (a quick double-tap counts
  as one tap), drag it up, or open the keyboard for full height. Tap outside, swipe the handle down, or press Back to
  close it.
- **Open in Atelier:** the ↗ button in the sheet's header opens the installed PWA at `https://atelier.ciprari.ai/`
  and closes the sheet. The VIEW intent names Chrome's WebAPK only when the package is a real one:
  `org.chromium.webapk.*` *and* installed by Google Play or by Chrome. Otherwise the intent stays implicit and
  Android resolves the link itself.

## Behaviour and security

| Topic | Behaviour |
|---|---|
| Start page | `https://atelier.ciprari.ai/?start=voice&via=assist&panel=assist`. It uses `?start=ask` when the system asks for the keyboard or when unlocking took more than 5 s. `via`/`panel` are layout hints only. The page can trust only `window.AtelierAssist`, which the WebView injects for this origin's top frame. |
| Navigation | The main frame is locked to `https://atelier.ciprari.ai` (port 443, no user info). Other http(s), `mailto:`, `tel:` and `sms:` links (GET) open in their own apps. Everything else (`intent:`, `file:`, `content:`, `javascript:`, `data:`) is dropped. `shouldOverrideUrlLoading` never sees POST navigations, so two more checks cover them. `shouldInterceptRequest` answers any main-frame request for another site with an empty 204 before it reaches the network; Atelier stays on screen and the target is not opened anywhere. Then `onPageStarted` stops anything foreign that still commits and goes back to Atelier. Popups (`window.open`, `target=_blank`) never show in the panel and make no requests of their own: a GET destination opens outside, and a POST target is dropped. |
| Microphone | Grants `RESOURCE_AUDIO_CAPTURE` only, and only to Atelier's origin. Android's microphone permission is asked the first time the page needs it. The camera and location are always denied. A photo can only come in through the system file picker. The "microphone is off" banner and `hello.mic:'denied'` appear only when Android won't ask again: the rationale flag went from true to false, or the answer came back with no dialog. A dismissed dialog stays `'prompt'`. |
| Configuration | Rotation, size, keyboard and dark mode are handled in place, so the page survives them. On a dark-mode switch, even in the background, the sheet, handle, buttons, banner and error screen re-read the theme's colours, or keep the page's own colour if it sent one. The nav-bar icons follow the sheet. A view added after androidx's edge-to-edge view re-applies them, and the nav-bar contrast scrim stays off. Display size and font size recreate the activity, with a fresh page in "ask" mode. |
| Renderer loss | Out of sight, a reclaimed renderer is dropped with no reload and no message; the next time the panel shows, it starts a fresh page. In sight, the page is replaced at once. Only crashes count, and three within a minute close the panel with a message. |
| Lock screen | Never shown over the lock screen (no `showWhenLocked`). A locked phone asks to unlock, and the panel closes if that is cancelled. |
| Assist data | `ACTION_ASSIST` can carry the previous app's screen context. The app reads only the keyboard hint and deletes the rest without reading it. |
| Storage | The WebView keeps its own sign-in, separate from Chrome and the PWA, so you sign in once in the panel with the passcode. Backup and device transfer are off (`allowBackup=false`, `data_extraction_rules.xml`). |
| Privacy | `android.webkit.WebView.MetricsOptOut` is set. There are no third-party cookies and no file or content access. Safe Browsing is on. Console output stays out of logcat in release builds. |
| Downloads | WebView's download listener can't tell which frame asked. A generated app in a Build preview (sandboxed, `allow-downloads`) could download in a loop, so a download is taken only when all of these hold: Atelier is the main frame; it comes within 10 s of a real tap on the page, and each tap pays for one download; no other save is under way; and none was taken in the last 2 s. Anything else is dropped. `data:` and `blob:` (Atelier's own origin) downloads are saved to `Downloads/Atelier` through MediaStore, which needs no storage permission. Decoding and writing happen off the main thread, one file at a time. Only media, text, JSON, PDF and ZIP are saved. `https` downloads open in the browser, under the same rules. The page's own saves over the bridge (`save-begin`) come only from Atelier's top frame, so they need no tap, but at most 4 can be waiting. |

### Page bridge (`window.AtelierAssist`)

`window.AtelierAssist` is an androidx.webkit `addWebMessageListener` object. It exists only in Atelier's top frame;
Build previews (sandboxed iframes) never get it. Every message is a JSON string.

Page to app:

- `ready`: the app replies with `hello`.
- `close`
- `open-app {path}`, where `path` is a same-site path that starts with a single `/`.
- `expand` and `collapse`
- `theme {bg:'#rrggbb'}`
- `mic-settings`
- `save-begin {name, mime, size}`, followed by one `ArrayBuffer` message.

App to page:

- `hello {v, app, version, invocation:'assist'|'launcher', start, mic:'granted'|'prompt'|'denied', expanded, save}`
- `listen {invocation, keyboard}`: the button was pressed again while the panel was open.
- `sheet {expanded}`

The web side of this, a compact panel layout, isn't in `public/` yet. Without it the panel shows the normal phone
layout and the mic starts at the first tap. The patch, a proposed `public/assist.js` with its test, and a
`public/assist-boot.js` are in `web-integration/`. Read `web-integration/assist-panel-integration.md` first.

## Build (Windows, exact commands)

You need:

- JDK 17. This PC has `C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot`, a Windows-on-ARM64 build.
- The Android SDK at `%LOCALAPPDATA%\Android\Sdk`, with `platforms;android-36`, `build-tools;36.1.0` and
  `platform-tools`. The SDK's tools (aapt2, adb) are x64 and run under emulation on ARM64.
- Network access to Google Maven, Maven Central and services.gradle.org on the first build.

The toolchain is AGP 9.4.1 with built-in Kotlin, Gradle 9.6.1 (wrapper), compileSdk/targetSdk 36 and minSdk 29.

```powershell
$env:JAVA_HOME   = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd C:\Users\cole\OneDrive\Desktop\Assistant\android
.\gradlew.bat --console=plain --project-cache-dir "$env:LOCALAPPDATA\atelier-assist-build\project-cache" :app:assembleRelease
```

- **Output:** `%LOCALAPPDATA%\atelier-assist-build\app\outputs\apk\release\app-release.apk`. All build output goes to
  `%LOCALAPPDATA%\atelier-assist-build` rather than OneDrive (sync locks, MAX_PATH). `ATELIER_ASSIST_BUILD_DIR`
  overrides that location.
- **Lint:** run `:app:lintRelease`. The report is in `...\atelier-assist-build\app\reports\`.
- **Check the signature and hashes:**

  ```powershell
  & "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.1.0\apksigner.bat" verify --print-certs "$env:LOCALAPPDATA\atelier-assist-build\app\outputs\apk\release\app-release.apk"
  Get-FileHash -Algorithm SHA256 "$env:LOCALAPPDATA\atelier-assist-build\app\outputs\apk\release\app-release.apk"
  ```

  The signing certificate SHA-256 must be
  `26a38ab7336289d88858af964534b0fd6350b1661d572f2083bf9716c56aacce` (CN=Atelier Assist, RSA 4096). An APK
  signed with any other key won't install over the owner's copy.

### Reproducibility

- The wrapper pins Gradle 9.6.1 by SHA-256 (`distributionSha256Sum`). `gradle-wrapper.jar` matches Gradle's
  published checksum, `497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7`.
- The plugin and library versions are fixed:
  - AGP 9.4.1.
  - `androidx.core:core-ktx:1.18.0`. Don't move to 1.19.x until compileSdk 37 is installed.
  - `androidx.activity:activity:1.13.0`.
  - `androidx.webkit:webkit:1.17.1`.
- `vcsInfo` is off and no dependency metadata block is written, so the same sources, toolchain and key give a
  byte-identical APK.
- Icons: `node android/tools/make-icons.mjs [previewDir]`, run from the repo root with the repo's own `sharp`,
  regenerates every `mipmap-*/ic_launcher_{foreground,monochrome}.png` from `public/icons/atelier-v2-master.png`.

### Release key (outside the repo)

The key lives in `%USERPROFILE%\.atelier-assist\`, with an ACL that gives only your Windows account access:

- `release.jks`: PKCS12, alias `atelier-assist`, RSA 4096, valid 10,000 days.
- `keystore.properties`: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

`app/build.gradle.kts` reads it from there, or from `ATELIER_ASSIST_KEYSTORE_PROPERTIES`. Without it,
`assembleRelease` produces an unsigned APK.

**Back up both files somewhere safe** (a password manager or an encrypted drive). If the key is lost, updates can't be
installed over the old app: you would have to uninstall it, which also clears the panel's sign-in.

To create a key on a new machine (only if the old one is really gone), run:

```powershell
keytool -genkeypair -keystore "$env:USERPROFILE\.atelier-assist\release.jks" -storetype PKCS12 -alias atelier-assist -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Atelier Assist"
```

Then write `keystore.properties` next to it.

`android/.gitignore` keeps build output, APKs and all key material (`*.jks`, `*.keystore`, `keystore.properties`,
and so on) out of git.

### Versioning

Raise `versionCode` (and `versionName`) in `app/build.gradle.kts` for every APK that will be installed over an
earlier one. The current build is `versionCode 2`, `1.0.1`.

## Install on the phone

1. Temporarily turn off Auto Blocker (Settings › Security and privacy › Auto Blocker). While it is on, it blocks
   sideloads and USB commands.
2. Turn on USB debugging (Developer options), connect the phone, then run
   `adb install -r app-release.apk`.
3. Pick it as the assistant: Settings › Apps › Choose default apps › Digital assistant app › Digital assistant app ›
   **Atelier Assist**.
4. Set the side button: Settings › Advanced features › Side button › Press and hold › **Digital assistant**. Or, to
   keep Gemini on press and hold, use Double press › Open app › **Atelier Assist**.
5. Turn Auto Blocker back on.

### Checks on the device

```sh
adb shell am start -n ai.ciprari.atelier.assist/.AssistActivity -a android.intent.action.ASSIST
adb shell cmd role get-role-holders android.app.role.ASSISTANT    # → ai.ciprari.atelier.assist
adb shell settings get secure assistant                           # → ai.ciprari.atelier.assist/.AssistActivity
```

## Fallback if One UI ignores an activity-only assistant

AOSP launches an `ACTION_ASSIST` activity for the power-key long press. If Samsung's side key does nothing with
Atelier Assist as the default assistant (while the corner swipe or `am start -a android.intent.action.ASSIST` still
works), add a minimal VoiceInteractionService shim:

1. An exported `VoiceInteractionService`, protected by `android.permission.BIND_VOICE_INTERACTION`, with
   `meta-data android.voice_interaction` pointing to `xml/voice_interaction_service.xml`. That file sets
   `sessionService`, `recognitionService` and `supportsAssist="true"`.
2. A `VoiceInteractionSessionService` whose session's `onShow()` calls
   `startAssistantActivity(Intent(context, AssistActivity::class.java))`, then `hide()`.
3. A `RecognitionService`, which is required.

The cost: the system keeps that service bound, and while Atelier Assist is the assistant its RecognitionService
becomes the phone's default speech recognizer. So it should forward to Google's recognizer, not fail.
