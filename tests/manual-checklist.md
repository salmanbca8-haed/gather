# Firebase manual verification checklist

Run this checklist against the deployed Firebase Hosting site using two browser profiles.

## Project setup

- [ ] Enable Firebase Authentication Email/Password; create Firestore and Storage.
- [ ] Confirm Authentication authorized domains include the Hosting domain.
- [ ] Deploy Cloud Functions, Firestore rules/indexes, Storage rules, and Hosting from `firebase.json`.
- [ ] Confirm signed-out Firestore and Storage reads/writes are denied.

## Accounts and profiles

- [ ] Register with a username and password without entering an email address or phone number.
- [ ] Reject invalid usernames, duplicate usernames (including case-only duplicates), short passwords, mismatched confirmation, and passwords over 72 UTF-8 bytes.
- [ ] Sign in with valid credentials and show a generic failure for incorrect credentials.
- [ ] Update display name, bio, and last-seen preference; confirm username cannot be changed.
- [ ] Upload and remove JPG, PNG, and WebP profile photos; reject corrupt files, unsupported formats, files over 2 MB, and images over 4096 pixels per dimension.
- [ ] Change the password after reauthentication and confirm the new password works.
- [ ] Sign out and confirm protected Firebase data cannot be accessed.

## Conversations and encryption

- [ ] Create or unlock E2EE keys using a recovery passphrase; verify that a wrong passphrase is rejected.
- [ ] Compare participant fingerprints through a separate trusted channel and verify them before sending.
- [ ] Send a message and confirm the Firestore document contains only an encrypted envelope, not plaintext.
- [ ] Tamper with a ciphertext or signature in a test account and confirm decryption fails.
- [ ] Confirm messages are saved, reload correctly, paginate, and appear for both participants.
- [ ] Confirm users cannot read or write messages for a conversation they are not a member of.
- [ ] Create a group and verify group membership is admin-controlled and removed members cannot read future messages.
- [ ] Edit a sender-owned message within 15 minutes; reject edits by another user and after the edit window.
- [ ] Delete a sender-owned message and confirm its body is replaced by a deletion marker.
- [ ] Search users by username and display name; confirm the current account is excluded.

## Browser and security

- [ ] Confirm values entered in profile and search fields render as text, not HTML.
- [ ] Confirm private E2EE key backups are readable only by their owner.
- [ ] Confirm Storage permits only the owner's bounded profile image upload and delete.
- [ ] Confirm Firebase Hosting serves `index.html` and the app works without PHP, MySQL, Apache, or XAMPP.
- [ ] Test desktop/mobile layouts, message keyboard behavior, theme persistence, and browser refresh.
