# MPT
Masjid Prayer Timings

## Web App
This project includes a simple static web app for managing prayer timings for multiple masjids.

- Shows 3 masjids with prayer times for `Fajr`, `Dhuhr`, `Asr`, `Maghrib`, and `Isha`.
- Lets you edit masjid names and prayer times directly in the UI.
- Saves locally and can sync to Firebase Firestore for cross-device persistence.
- Includes a `Sync Now` button for manual cloud sync when auto-sync is delayed.

Open `index.html` in your browser to use the app.

## Cloud Sync Setup (GitHub Pages Compatible)
This app can run on GitHub Pages and still use server-side storage by calling Firestore directly from the browser via the Firebase SDK (loaded from a CDN, no build step required).

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com), then enable **Firestore Database** (Native mode, any region).
2. In **Firestore Database > Rules**, publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /prayerTimings/{docId} {
      allow read, write: if true;
    }
  }
}
```

3. In **Project settings > General > Your apps**, add a Web app and copy its config object.
4. Open `config.js` and set `firebaseConfig` to that object:

```js
window.MPT_CONFIG = {
  firebaseConfig: {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "..."
  },
  firestoreCollection: "prayerTimings",
  firestoreDocId: "main"
};
```

5. Commit and push `config.js`, then wait for GitHub Pages deploy.

When config is set, the app loads/saves prayer timings to Firestore document `prayerTimings/main`. If cloud sync fails, it falls back to local browser storage.

Note: the `firebaseConfig` values (including `apiKey`) are not secrets — they identify the project, and access is controlled entirely by the Firestore security rules above. The open `allow read, write: if true` rule means anyone with the config can read/write this one document; that's an intentional tradeoff for a no-auth, GitHub-Pages-only setup.
