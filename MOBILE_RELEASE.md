# SafeRoute AI Mobile Release

This repo now includes an Android wrapper generated with Capacitor in [frontend/android](/Users/ao0028/Desktop/Saferoute_AI/frontend/android).

## Current State

- Web app remains the source of truth in [frontend/src](/Users/ao0028/Desktop/Saferoute_AI/frontend/src)
- Android shell is ready in [frontend/android](/Users/ao0028/Desktop/Saferoute_AI/frontend/android)
- Camera and location permissions are declared in [AndroidManifest.xml](/Users/ao0028/Desktop/Saferoute_AI/frontend/android/app/src/main/AndroidManifest.xml)

## Useful Commands

From the repo root:

```bash
npm run mobile:sync
npm run mobile:open:android
```

From `frontend` directly:

```bash
npm run cap:sync
npm run cap:open:android
```

## Android Build Flow

1. Run `npm run mobile:sync`
2. Run `npm run mobile:open:android`
3. In Android Studio, let Gradle finish syncing
4. Connect a real Android phone and test:
   - camera access
   - location permission
   - audio alerts
   - network calls to the backend
5. Create a signed release build in Android Studio:
   - `Build`
   - `Generate Signed Bundle / APK`
   - choose `Android App Bundle (AAB)`

## Before Google Play Submission

You still need:

- A Google Play Console developer account
- App signing keystore
- Privacy policy URL
- App icon, feature graphic, screenshots, and short/long store descriptions
- Clear permission explanations for camera and location
- Testing on multiple Android versions and devices

## What I Can Prepare vs What Requires You

I can prepare:

- the Android project
- native permissions
- build commands
- release notes and submission checklist

You must provide or approve:

- Google Play Console access
- signing credentials/keystore
- store listing content and screenshots
- final release submission in Play Console

## Important Note

I cannot directly submit to Google Play from this environment because that requires your Play Console account, signing setup, and release approvals. The repo is now scaffolded so that submission is the next operational step rather than a coding step.
