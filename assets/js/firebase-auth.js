(() => {
    'use strict';

    const config = window.GATHER_FIREBASE_CONFIG;
    if (!config || !window.firebase) {
        throw new Error('Firebase could not be initialized. Check the Firebase SDK and configuration.');
    }

    const app = firebase.initializeApp(config);
    const auth = app.auth();
    let resolveReady;
    const ready = new Promise(resolve => {
        resolveReady = resolve;
    });

    auth.onAuthStateChanged(user => resolveReady(user));

    function normalizeUsername(username) {
        return username.trim().toLowerCase();
    }

    function usernameEmail(username) {
        return `${normalizeUsername(username)}@gather.invalid`;
    }

    function validatePassword(password) {
        const bytes = new TextEncoder().encode(password).length;
        if (password.length < 10 || bytes > 72) {
            throw new Error('Use a password of at least 10 characters and no more than 72 bytes.');
        }
    }

    function authError(error) {
        if (error.code === 'auth/configuration-not-found'
            || error.code === 'auth/operation-not-allowed') {
            return new Error('Firebase Authentication is not ready for this project. In Firebase Console, open Authentication → Sign-in method, enable Email/Password, and save. Also confirm the app is using project gather-b3c61.');
        }
        if (error.code === 'auth/invalid-api-key') {
            return new Error('Firebase rejected this project’s API key. Check that assets/js/firebase-config.js uses the Web app config from project gather-b3c61.');
        }
        if (error.code === 'auth/user-not-found'
            || error.code === 'auth/wrong-password'
            || error.code === 'auth/invalid-credential') {
            return new Error('The username or password is incorrect.');
        }
        if (error.code === 'auth/email-already-in-use') {
            return new Error('That username is already taken.');
        }
        if (error.code === 'auth/network-request-failed') {
            return new Error('Could not reach Firebase. Check your connection and try again.');
        }
        if (error.code === 'auth/too-many-requests') {
            return new Error('Too many attempts. Please wait a few minutes and try again.');
        }
        return error;
    }

    async function register(username, password) {
        validatePassword(password);
        const email = usernameEmail(username);
        let user = auth.currentUser;
        if (user && user.email?.toLowerCase() === email) {
            try {
                await user.reauthenticateWithCredential(
                    firebase.auth.EmailAuthProvider.credential(email, password)
                );
            } catch (error) {
                throw authError(error);
            }
        } else {
            try {
                const credential = await auth.createUserWithEmailAndPassword(email, password);
                user = credential.user;
            } catch (error) {
                throw authError(error);
            }
        }
        return user;
    }

    async function signIn(username, password) {
        try {
            const credential = await auth.signInWithEmailAndPassword(usernameEmail(username), password);
            return credential.user;
        } catch (error) {
            throw authError(error);
        }
    }

    async function changePassword(username, currentPassword, newPassword) {
        validatePassword(newPassword);
        const user = auth.currentUser;
        if (!user) {
            throw new Error('Please sign in again before changing your password.');
        }
        try {
            const credential = firebase.auth.EmailAuthProvider.credential(
                usernameEmail(username),
                currentPassword
            );
            await user.reauthenticateWithCredential(credential);
            await user.updatePassword(newPassword);
        } catch (error) {
            if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                throw new Error('Your current password is incorrect.');
            }
            throw authError(error);
        }
    }

    window.GatherFirebaseAuth = Object.freeze({
        ready,
        currentUser: () => auth.currentUser,
        register,
        signIn,
        signOut: () => auth.signOut(),
        changePassword
    });
})();
