# Atelier Assist (Android)

A small companion app for the Samsung side button, like Gemini's or ChatGPT's overlay. Press and hold the button and a
small card appears over whatever you're doing. Atelier's "A" hovers and pulses while you talk, your words appear as you
say them, and a chip shows the mode they suggest: **Ask, Code, Image, Video, Ideas or Build**. When you stop, the
installed Atelier app opens in that mode with your request.

It is sideloaded and for the owner only. It isn't published anywhere and has no analytics, ads or trackers.

- **Package:** `ai.ciprari.atelier.assist`. **Label:** "Atelier Assist", so it's easy to tell apart from the installed
  PWA, "Atelier".
- **Version:** 1.1.0 (versionCode 3). 1.0.x showed the whole Atelier site in a WebView sheet; 1.1 replaces that with
  the native card.
- **How it opens:**
  - `android.intent.action.ASSIST`, which the system sends to the default digital assistant. On Samsung that is
    Side button › Press and hold, plus the corner swipe.
  - `MAIN`/`LAUNCHER`, so the app icon and Side button › Double press › Open app give the same card.

## The card

| State | What you see | What you can do |
|---|---|---|
| Listening | "LISTENING". The A bobs slowly and its glow and ring swell with your voice. Partial words appear as you speak. The mode chip appears as soon as the words suggest one, and the glow takes that mode's colour. | Talk. Tap the A to finish early (before any words: it stops and waits). **Type** switches to the keyboard. Tap the chip to pick a mode yourself. |
| Thinking | "THINKING". The A breathes. | Wait a moment. |
| Opening in … | "OPENING IN IMAGE" and a thin bar fills for 1.2 s. | Any touch on the card holds it ("READY — TAP OPEN"). Then tap the chip to change the mode, **Edit** to fix the words, or **Open**. |
| Typing | A text field with Send. The chip follows what you type. | Send (or the keyboard's Send) opens Atelier at once. **Talk** goes back to the mic. |
| Error | A short title and one line of help: didn't catch that, no connection, mic busy, microphone off, language not available, no speech service. | **Try again**, **Type**, **Allow** or **Settings** (when Android won't ask for the mic again). Nothing crashes. |

- **Close it:** tap outside, press Back, or tap ×. It also closes when it goes out of sight (home, screen off), except
  on the setup page and during system screens it opened itself (unlock, Settings).
- **Press the side button again:** while it listens, that ends the request (before any words, it closes). Otherwise it
  listens again.
- **With TalkBack:** it never opens by itself after the 1.2 s. It waits on "Ready" for you to choose Open, and the
  status line isn't read aloud while the mic is open.
- **Reduced motion:** with Settings › Accessibility › Remove animations on (animator duration scale 0), the A stays
  still: no bob, no pulse and no frame loop. Its glow switches to the new mode colour at once instead of fading.
- **Look:** warm black `#0e0d0b`, a hairline border and a soft shadow, 28 dp corners. Width is about 92% of the screen
  (at most 420 dp), centred at the bottom above the nav bar or the keyboard. The chip and buttons use Atelier's dark
  accent for each mode (`app.css` `--c-ask` … `--c-build`).

## Modes: `ModeClassifier`

`ModeClassifier` is a pure Kotlin object, unit-tested on the JVM. It returns `{mode, prompt, confidence, explicit}`.
The first rule that matches wins:

1. **A mode named outright:** `image: …`, `code - …`, `video mode …`, `/img …`, `ask …`.
2. **A command at the start**, after filler words ("hey Atelier", "please", "can you", "I want", "let's", "can I get"):
   - Make an image, picture or photo of…; draw…; imagine…; design a logo/poster/icon….
   - Make a video or clip of…; animate….
   - Build/make/code an app, website, landing page, game, dashboard, tool….
   - Write a function/regex/query/script that…; fix/debug/explain my code….
   - Brainstorm…; ideas for…; N names for…; suggest….
3. **A question or a writing task** (what, why, how, can, explain…; write, draft, rewrite…) → Ask.
4. **A mode named at the end:** "… as an image", "… in build mode", "… make it a video".
5. **Strong keywords anywhere**, weighted (watercolor, photorealistic; drone shot, slow motion; regex, stack trace,
   Python; landing page, dashboard; ideas, brainstorm). A close call is marked "contested" (lower confidence).
6. Otherwise **Ask**.

How the prompt is trimmed:

- A command that only names the medium is dropped: "make an image of a red fox" → Image, "a red fox".
- Words that carry meaning stay: "a realistic photo of…", "a minimalist logo for my bakery", "a pomodoro timer app",
  "write a Python function that…".
- If you pick a different mode on the chip, the whole request goes (only "hey Atelier" is removed).
- "Make an image" with nothing after it waits on "What should it be?" instead of opening.

The chip shows its mode colour when the classifier is sure (confidence ≥ 0.5) or you picked it. Otherwise it is a
neutral "ASK". The classifier is English-only: other languages fall through to Ask with the full text.

## Opening Atelier, and pairing

The request goes to the installed app as a link that `public/launch.js` reads:

```
https://atelier.ciprari.ai/?start=<mode>&via=assist#k=<key>&send=1&q=<prompt>   (paired)
https://atelier.ciprari.ai/?start=<mode>&via=assist#q=<prompt>                  (not paired: prefill only)
https://atelier.ciprari.ai/?start=<mode>&via=assist                             (no words: just that mode)
```

- **`start`:** one of `ask code image video ideas build`, exactly as `launch.js` `LAUNCH_MODES` spells them.
  `ModeParityTest` checks the spellings against `launch.js` and the accent colours against `app.css`.
- **`q`:** always last. `launch.js` takes everything after `q=` as is, so the prompt is percent-encoded byte by byte
  (spaces as `%20`, never `+`). `tools/check-launch-vectors.mjs` feeds 180 links built by the app to the real
  `readLaunch()`. It checks that the mode, text, key, `send` and `via` come back exactly as sent.
- **The key** goes only in the fragment, never to the server, and only to a target that is really Atelier:
  1. A Chrome WebAPK (`org.chromium.webapk.*`) that handles the site's links *and* was installed by Google Play or
     by a trusted Chrome. This is the installed Atelier app.
  2. Otherwise Chrome itself, when it is a system app or came from Play. The key lives in Chrome's storage for the
     site, which the installed app shares.
  3. Otherwise Android picks the handler, and the link goes **without** the key: prefill only.

  Trusting the WebAPK needs Google Play to be visible to this app (`<package android:name="com.android.vending"/>` in
  `<queries>`). Without it, Android 11+ reports a null installer for every Play-minted WebAPK and every request would
  open in a Chrome tab. To confirm on the phone: a request should open the installed Atelier app, not a Chrome tab.
- **What Atelier does with it:** a keyed link sends after Atelier's own visible, cancellable hold. It needs the key to
  match the one that browser made, a one-time confirmation in Atelier, and its usual gates (signed in, idle, empty
  composer, at most one keyed send per 15 s). A link without a key, or one Atelier doesn't accept, only fills the box
  and Send pulses.
- **Who may open it by itself:** the 1.2 s auto-open runs only when the card was started by the system (`android`,
  System UI: the assistant gesture), the default home app, this app, or another system-image app (an OEM side-key
  handler). The caller is the system's own record (`getReferrer()` after the extras are cleared, so a caller can't
  claim another name). Any other app that starts the card gets the card and the mic, but it waits on "Ready" for
  **Open**, so an app can't turn played-back speech into a keyed send. A touch on the card that no other window covers
  also counts as the owner. If One UI's side-key handler isn't visible to this app, the card waits for **Open** there
  too.
- **Today's site** (v55/v56) sends keyed links in **Ask only**. Other modes open with the words in the box. The web
  patch in `web-integration/assist-launch-web-patch.md` extends keyed sends to all six modes: a longer hold and a cost
  line for Video, and the label "From Atelier Assist". The same patch adds the Android **Copy Assist link** button
  that pairing needs. Today Atelier gives Android only the keyless link. An Allow given before that patch (under the
  Ask-only dialog) no longer counts: the first keyed send afterwards asks again and names its mode (and Video's
  price).

### Pairing (one time)

The setup page shows on first run. Afterwards, open it with ⋯ on the card or a long press on the A.

1. In Atelier: Settings → General → Quick launch → Android → Atelier Assist. *(This needs the web patch above.)*
2. Turn on **Send without a tap**, then tap **Copy Assist link**.
3. Back in Atelier Assist, tap **Paste link**.

- **Paste link** reads the clipboard only on that tap.
- It accepts an `https://atelier.ciprari.ai` link whose fragment carries `k=` plus 22 base64url characters before
  `q=`. The iPhone Shortcut link has the same format.
- It keeps only the key, in this app's private SharedPreferences. Backup and device transfer are off. It then clears
  the clipboard, because the link can send without a tap.
- **Clipboard history:** clearing the clipboard doesn't touch a keyboard's clipboard history. Samsung Keyboard keeps
  copied links in its Clipboard panel and Gboard keeps them for about an hour; Link to Windows may have synced it to a
  PC. The app says so after pairing: delete the Atelier link there.
- **Unpair** deletes the key on this phone only. The key keeps working (in the browser, and in any keyed link Chrome
  History recorded) until it is retired in Atelier: Settings → General → Quick launch → Atelier Assist → **New link**.
- Neither the link, the key nor anything you say is logged. The app has no `Log` calls and no network access.

The setup page also shows whether Atelier Assist is the digital assistant, with an **Open settings** button.

## Speech

- `android.speech.SpeechRecognizer`, with partial results and the phone's current locale.
- **Which recognizer:** the on-device recognizer on Android 12+, when the phone has one. If it can't serve the
  language or fails before hearing anything, the app switches quietly to the phone's default recognizer (usually
  Google's) for the rest of the process.
- **Network:** the default recognizer may use the network through the speech app's own connection, so this app needs
  no INTERNET permission. Your voice may then go to Google's (or the phone maker's) servers before the words reach
  Atelier; the setup page's privacy note says so.
- **Cleanup:** every recognizer is destroyed after its result or error, including when the card cancels straight after
  an error (a posted destroy is never dropped with the session's timers), and any still pending when the card closes.
- **Microphone:** `RECORD_AUDIO` is asked the first time the card listens. "Blocked" (the **Settings** button)
  appears only when Android won't show the dialog again. A dismissed dialog keeps **Allow**.
- **Mic level:** comes from `onRmsChanged` (about −2…10 dB, mapped to 0…1). The A smooths it: quick to rise, slow to
  fall.
- **Limits:** a request ends after 45 s at most. If the service doesn't answer within 6 s, the card shows an error
  instead of hanging.

## Behaviour and security

| Topic | Behaviour |
|---|---|
| Permissions | `RECORD_AUDIO` only, plus AndroidX's signature-only `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. No INTERNET: the app never connects anywhere. `<queries>`: VIEW/BROWSABLE `https://atelier.ciprari.ai` (to find the WebAPK and Chrome), the package `com.android.vending` (to read the WebAPK's installer), MAIN/HOME (to recognise the default home app as a caller) and `android.speech.RecognitionService` (Android 11+ package visibility for SpeechRecognizer). |
| Lock screen | Never shown over the lock screen (no `showWhenLocked`). A locked phone asks to unlock first, and the card closes if that is cancelled. If unlocking takes more than 5 s, the card waits for a tap instead of opening the mic. |
| Callers | Exported (ASSIST, MAIN/LAUNCHER), not BROWSABLE, so web pages can't start it. Only the system, the home app, this app and system-image apps get the automatic open; others must tap **Open**. |
| Assist data | `ACTION_ASSIST` can carry the previous app's screen context. The app reads only the keyboard hint, which opens the card in typing mode, and deletes the rest without reading it. |
| Storage | `SharedPreferences` "assist": the pairing key, "setup seen" and a one-time cleanup flag. Backup and device transfer are off (`allowBackup=false`, `data_extraction_rules.xml`). |
| 1.0.x leftovers | 1.0.x's WebView kept its own Atelier sign-in (cookies, localStorage) in this app's private storage. On first start, 1.1 deletes `app_webview`, `app_textures` and the WebView caches once, off the main thread, along with 1.0's preferences. The installed Atelier app keeps its own sign-in. |
| Configuration | Rotation, size, keyboard and dark mode are handled in place, so listening isn't cut off. Display size and font size recreate the activity, which then waits for a tap. |

## Tests

```powershell
$env:JAVA_HOME   = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd C:\Users\cole\OneDrive\Desktop\Assistant\android
.\gradlew.bat --console=plain --project-cache-dir "$env:LOCALAPPDATA\atelier-assist-build\project-cache" :app:testDebugUnitTest
cd ..
node android/tools/check-launch-vectors.mjs
```

- **Which task:** AGP 9 creates unit-test tasks for the debug build type only, so the task is `testDebugUnitTest`.
  The classes under test are the same code that ships.
- **The suites (34 tests):**
  - `ModeClassifierTest` (23 tests): about 170 phrasings across the six modes, partial transcripts, and medium words
    inside other things ("video game", "image generator app", "video ideas", "photo editing app", "a website with
    photos", "movie recommendations", "a short story"). Also: "for my app" doesn't make Code or Ideas a Build, everyday
    "test"/"class" words aren't Code, film/movie lead words are Video, "can you make…" partials aren't a sure Ask, and
    "ask Atelier to …" is classified by what follows.
  - `LaunchLinkTest`: the link format, encoding, the clean-up and cut-off, and pairing accept/refuse cases (userinfo
    tricks, other hosts and ports, a key in the query or after `q=`, malformed keys).
  - `ModeParityTest`: the mode spellings and colours against `public/launch.js` and `public/app.css`.
- **Launch vectors:** `LaunchLinkTest` also writes `launch-vectors.json` to the build directory.
  `check-launch-vectors.mjs` runs those links through the real `public/launch.js`.

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
.\gradlew.bat --console=plain --project-cache-dir "$env:LOCALAPPDATA\atelier-assist-build\project-cache" :app:assembleRelease :app:lintRelease
```

- **Output:** `%LOCALAPPDATA%\atelier-assist-build\app\outputs\apk\release\app-release.apk`. All build output goes to
  `%LOCALAPPDATA%\atelier-assist-build` rather than OneDrive (sync locks, MAX_PATH). `ATELIER_ASSIST_BUILD_DIR`
  overrides that location.
- **Copies for installing:** `android\dist\Atelier-Assist-<version>.apk` and `Desktop\Atelier-Assist-<version>.apk`.
  `*.apk` is git-ignored.
- **Lint:** the report is in `...\atelier-assist-build\app\reports\`. Expect 0 errors and 4 warnings, all deliberate
  version pins (targetSdk/compileSdk 37, core-ktx 1.19, Gradle 9.8).
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
  - Tests only: `junit:junit:4.13.2`.
  - No WebKit, AppCompat, Material, Compose or analytics.
- `vcsInfo` is off and no dependency metadata block is written, so the same sources, toolchain and key give a
  byte-identical APK (checked with `clean :app:assembleRelease`).
- **Icons:**
  - `node android/tools/make-icons.mjs [previewDir]` regenerates the launcher icon layers from
    `public/icons/atelier-v2-master.png`.
  - `node android/tools/make-mark.mjs` regenerates the card's "A" (`drawable-*/atelier_mark.png`, 48 dp) from
    `brand/atelier-mark-transparent-512.png`.
  - Run both from the repo root; they use the repo's own `sharp`.

### Release key (outside the repo)

The key lives in `%USERPROFILE%\.atelier-assist\`, with an ACL that gives only your Windows account access:

- `release.jks`: PKCS12, alias `atelier-assist`, RSA 4096, valid 10,000 days.
- `keystore.properties`: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

`app/build.gradle.kts` reads it from there, or from `ATELIER_ASSIST_KEYSTORE_PROPERTIES`. Without it,
`assembleRelease` produces an unsigned APK.

**Back up both files somewhere safe** (a password manager or an encrypted drive). If the key is lost, updates can't be
installed over the old app: you would have to uninstall it, which also deletes the pairing.

To create a key on a new machine (only if the old one is really gone), run:

```powershell
keytool -genkeypair -keystore "$env:USERPROFILE\.atelier-assist\release.jks" -storetype PKCS12 -alias atelier-assist -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Atelier Assist"
```

Then write `keystore.properties` next to it.

`android/.gitignore` keeps build output, APKs and all key material (`*.jks`, `*.keystore`, `keystore.properties`,
and so on) out of git.

### Versioning

Raise `versionCode` (and `versionName`) in `app/build.gradle.kts` for every APK that will be installed over an
earlier one. The current build is `versionCode 3`, `1.1.0`.

## Install on the phone

1. Temporarily turn off Auto Blocker (Settings › Security and privacy › Auto Blocker). While it is on, it blocks
   sideloads and USB commands.
2. Install, either:
   - with USB debugging on: `adb install -r Atelier-Assist-1.1.0.apk`; or
   - by opening the APK in My Files.

   1.1.0 installs over 1.0.x, with the same key.
3. Open Atelier Assist once. The setup page appears. Pair it if the web patch is live, or tap **Done** to use it
   unpaired (prefill only). Allow the microphone when it first listens.
4. Pick it as the assistant: Settings › Apps › Choose default apps › Digital assistant app › Digital assistant app ›
   **Atelier Assist**.
5. Set the side button: Settings › Advanced features › Side button › Press and hold › **Digital assistant**. To keep
   Gemini on press and hold, use Double press › Open app › **Atelier Assist** instead.
6. Turn Auto Blocker back on.

### Checks on the device

```sh
adb shell am start -n ai.ciprari.atelier.assist/.AssistActivity -a android.intent.action.ASSIST
adb shell cmd role get-role-holders android.app.role.ASSISTANT    # → ai.ciprari.atelier.assist
adb shell settings get secure assistant                           # → ai.ciprari.atelier.assist/.AssistActivity
adb shell dumpsys package ai.ciprari.atelier.assist | findstr versionName   # → 1.1.0
```

## Fallback if One UI ignores an activity-only assistant

AOSP launches an `ACTION_ASSIST` activity for the power-key long press. If Samsung's side key does nothing with
Atelier Assist as the default assistant, but the corner swipe or `am start -a android.intent.action.ASSIST` still
works, add a minimal VoiceInteractionService shim:

1. An exported `VoiceInteractionService`, protected by `android.permission.BIND_VOICE_INTERACTION`, with
   `meta-data android.voice_interaction` pointing to `xml/voice_interaction_service.xml`. That file sets
   `sessionService`, `recognitionService` and `supportsAssist="true"`.
2. A `VoiceInteractionSessionService` whose session's `onShow()` calls
   `startAssistantActivity(Intent(context, AssistActivity::class.java))`, then `hide()`.
3. A `RecognitionService`, which is required.

The cost: the system keeps that service bound, and while Atelier Assist is the assistant its RecognitionService
becomes the phone's default speech recognizer. It should forward to Google's recognizer, not fail. Atelier Assist's own
listening would then also go through it.

## Web integration notes

- `web-integration/assist-launch-web-patch.md` is **for 1.1**: keyed sends for all six modes, and Android pairing.
- `web-integration/assist-panel-integration.md` and its `assist*.js` files are **for 1.0.x's WebView panel**.
  1.1 doesn't use them.
- **Still needed from the panel patch:** §5h, `FORBID_TAGS: ['form']` in `md()`. It is a security fix for every
  browser and should ship on its own.
