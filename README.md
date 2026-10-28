# Gather

Gather is a static HTML/CSS/JavaScript chat app backed entirely by Firebase. It uses Firebase Hosting, Authentication, Cloud Firestore, Cloud Storage, and callable Cloud Functions. It does not use PHP, MySQL, Apache, or XAMPP.

The app supports username/password accounts without asking for an email address, profiles and photos, private and group conversations, and browser-side end-to-end encryption for new messages. The client stores only encrypted message envelopes in Firestore. The recovery passphrase encrypts the private E2EE keys before their backup is stored in Firebase. Existing MySQL accounts and chat history are not imported; this project is configured for a fresh start.

## Firebase setup

The repository is configured for the Firebase project `gather-b3c61`. Confirm the values in `assets/js/firebase-config.js` belong to the intended project before deployment.

1. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**.
2. Create a Cloud Firestore database and a Cloud Storage bucket. Do not loosen the rules in `firestore.rules` or `storage.rules`.
3. Add the Hosting domains (`gather-b3c61.web.app`, `gather-b3c61.firebaseapp.com`, and any custom domain) to Authentication's authorized domains.
4. Cloud Functions deployment requires the project to use the Blaze billing plan. Review Firebase pricing and set budget alerts before deploying.
5. Install Node.js 22 or newer and authenticate the Firebase CLI:

   ```powershell
   npm install --prefix functions
   npx firebase-tools login
   npx firebase-tools use gather-b3c61
   ```

6. Deploy the application and its access-control rules:

   ```powershell
   npx firebase-tools deploy --only hosting,functions,firestore:rules,firestore:indexes,storage
   ```

7. Open the Hosting URL shown by the Firebase CLI and create a **new** Gather account. Create or use a second account to test direct chats, groups, profile settings, and encryption-fingerprint verification.

## Data and account behavior

- Usernames are normalized to lowercase and reserved by a trusted Cloud Function. Firebase Authentication uses an internal `@gather.invalid` alias; it is not a real email address.
- Password recovery by email is unavailable because users do not provide a real email address. A signed-in user can change their password by confirming the current password.
- Firestore and Storage rules deny direct conversation/message writes and restrict profile edits, private key-backup reads, member reads, and profile-photo uploads. Callable Functions validate message envelopes and membership, and rate-limit sends.
- Profile photos use Firebase download URLs so browsers can display them. Those URLs are bearer links: anyone who obtains a photo URL can view that photo, even though Storage's direct read rule requires sign-in.
- The app does not import the previous MySQL accounts, profiles, photos, conversations, or messages. Treat deployment as a new installation.
- Firebase configuration values in the browser are public client configuration, not service-account credentials. Do not add a service-account key to this repository. Restrict the API key to the Firebase APIs and domains this app needs.
- Firebase Hosting serves the JavaScript that performs encryption. End-to-end encryption protects message contents stored in Firestore, but users must trust the deployed website and project owners not to serve modified client code.

## Validation

Run the focused checks from the project directory:

```powershell
npm run lint --prefix functions
node --check assets/js/firebase-auth.js
node --check assets/js/firebase-data.js
node --check assets/js/app.js
node --check assets/js/crypto.js
```

Firebase Auth, Firestore, Storage, and callable Functions require a configured Firebase project; static syntax checks do not replace testing against the deployed services.
