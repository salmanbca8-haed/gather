# Firebase manual verification checklist

Run this checklist on the deployed Hosting site using two browser profiles.

## Spark project setup

- [ ] Enable Authentication Email/Password and create a Firestore database in production mode. Do not enable billing, Cloud Functions, or Firebase Storage.
- [ ] Confirm the Firebase web config in `assets/js/firebase-config.js` belongs to project `gather-b3c61`.
- [ ] Add the Hosting domain to Authentication's authorized domains.
- [ ] Deploy with `firebase deploy --only firestore,hosting`; confirm Hosting serves `index.html`.
- [ ] Confirm signed-out Firestore reads/writes are denied and authenticated users cannot read private key backups belonging to another user.

## Accounts and profiles

- [ ] Register with a username and password without entering an email address or phone number.
- [ ] Reject invalid usernames, duplicate usernames (including case-only duplicates), short passwords, mismatched confirmation, and passwords over 72 UTF-8 bytes.
- [ ] Sign in with valid credentials and show a generic failure for incorrect credentials.
- [ ] Update display name, bio, and last-seen preference; confirm username cannot be changed.
- [ ] Upload and remove JPG, PNG, and WebP profile photos; reject corrupt files, unsupported formats, files over 2 MB, and images over 4096 pixels per dimension.
- [ ] Confirm the resized avatar is stored in the user's Firestore profile and remains under the configured document-size cap.
- [ ] Change the password after reauthentication and confirm the new password works.
- [ ] Sign out and confirm protected Firestore data cannot be accessed.

## Conversations and encryption

- [ ] Create or unlock E2EE keys using a recovery passphrase; verify that a wrong passphrase is rejected.
- [ ] Compare participant fingerprints through a separate trusted channel and verify them before sending.
- [ ] Send a message and confirm the Firestore document contains only an encrypted envelope, not plaintext.
- [ ] Tamper with a ciphertext or signature in a test account and confirm decryption fails.
- [ ] Confirm messages are saved, reload correctly, paginate, and appear for both participants.
- [ ] Confirm users cannot read or write messages for a conversation they are not a member of.
- [ ] Confirm users blocked by either participant cannot start or send to a direct conversation.
- [ ] Create a group and verify group membership is admin-controlled and removed members cannot read future messages.
- [ ] Edit a sender-owned message within 15 minutes; reject edits by another user and after the edit window.
- [ ] Delete a sender-owned message and confirm its body is replaced by a deletion marker.
- [ ] Search users by username and display name; confirm the current account is excluded.

## Browser and security

- [ ] Confirm values entered in profile and search fields render as text, not HTML.
- [ ] Confirm private E2EE key backups are readable only by their owner.
- [ ] Confirm the app works without PHP, MySQL, Apache, XAMPP, Cloud Functions, or Firebase Storage.
- [ ] Test desktop/mobile layouts, message keyboard behavior, theme persistence, and browser refresh.
