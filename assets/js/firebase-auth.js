(() => {
    'use strict';

    const config = window.GATHER_FIREBASE_CONFIG;
    if (!config || !window.firebase) {
        throw new Error('Firebase could not be initialized. Check the Firebase SDK and configuration.');
    }

    const app = firebase.initializeApp(config);
    const auth = app.auth();
    const functions = app.functions('us-central1');
    const claimUsername = functions.httpsCallable('claimUsername');
    const revokeOtherSessions = functions.httpsCallable('revokeOtherSessions');
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
        if (error.code === 'auth/user-not-found'
            || error.code === 'auth/wrong-password'
            || error.code === 'auth/invalid-credential') {
            return new Error('The username or password is incorrect.');
        }
        if (error.code === 'auth/email-already-in-use' || error.code === 'functions/already-exists') {
            return new Error('That username is already taken.');
        }
        if (error.code === 'functions/unauthenticated') {
            return new Error('Your sign-in expired. Please sign in again.');
        }
        if (error.code === 'auth/network-request-failed' || error.code === 'functions/unavailable') {
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
        try {
            await claimUsername({ username: normalizeUsername(username) });
            await user.getIdToken(true);
            return user;
        } catch (error) {
            throw authError(error);
        }
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
            await revokeOtherSessions();
        } catch (error) {
            if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                throw new Error('Your current password is incorrect.');
            }
            if (error.code && error.code.startsWith('functions/')) {
                throw new Error('Your password changed, but Firebase could not revoke other sessions. Sign out of all devices and try again.');
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
