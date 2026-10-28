# Gather

Gather is a browser-based messaging app built with Firebase Authentication, Cloud Firestore, and Firebase Hosting. It does not use PHP, MySQL, Cloud Functions, Firebase Storage, or require a paid billing plan.

## Firebase setup (Spark/no-cost plan)

1. In the [Firebase Console](https://console.firebase.google.com/), open project `gather-b3c61`.
2. Under **Authentication → Sign-in method**, enable **Email/Password**.
3. Under **Firestore Database**, create a database. Choose a location and **Start in production mode**. Creating Firestore is a required one-time setup; it does not require upgrading to Blaze. Firestore is subject to Spark plan quotas and limits.
4. In **Project settings → General**, register a Web app if one is not already registered. Copy its Firebase web configuration into `assets/js/firebase-config.js`.
5. Add the Hosting domain (for example `gather-b3c61.web.app`) to **Authentication → Settings → Authorized domains** if it is not already listed.
6. Install the Firebase CLI if needed, sign in, and select the project:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use gather-b3c61
   ```

7. From the project folder, deploy Firestore rules/indexes and the static site:

   ```powershell
   firebase deploy --only firestore,hosting
   ```

   Do not deploy Functions or Storage; Gather does not use them.

## Running locally

Serve this folder with any static web server, or deploy it to Firebase Hosting. Opening `index.html` directly as a `file://` URL may prevent Firebase authentication from working. No XAMPP, Apache, PHP, or MySQL setup is needed.

## Accounts and privacy

- Accounts use Firebase Email/Password behind the scenes. The app turns each username into an internal `@gather.invalid` email alias, so users do not enter a real email address.
- New accounts and conversations are stored in Firestore. Existing MySQL data is not migrated.
- Profile photos are resized and stored in the user's Firestore profile document rather than Firebase Storage. The app caps the resulting image data at 700,000 characters; this uses Firestore document storage and read/write quota.
- New message content is encrypted in the browser before it is sent to Firestore. Private key backups are encrypted using the user's recovery passphrase. Losing that passphrase can make the backup unrecoverable.
- Encryption does not protect against a compromised device or malicious site code. Verify contact fingerprints through a separate trusted channel.
- Firebase Spark is no-cost within its quotas, not unlimited. Review Firebase's current [pricing and quotas](https://firebase.google.com/pricing) before public use. No billing upgrade is required for this setup.

## Validation

Use [tests/manual-checklist.md](tests/manual-checklist.md) to verify setup and app behavior with two browser profiles. Firestore must be created and the rules deployed before account creation, conversations, or messages can work.
