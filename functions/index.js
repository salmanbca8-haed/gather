'use strict';

const { createHash } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();

const db = getFirestore();
const usernamePattern = /^[a-z0-9](?:[a-z0-9._]{1,22}[a-z0-9])$/;

function validateEnvelope(body, conversationId, uid, memberIds) {
    if (typeof body !== 'string' || body.length > 60000) {
        throw new HttpsError('invalid-argument', 'The encrypted message is too large or malformed.');
    }
    let envelope;
    try {
        envelope = JSON.parse(body);
    } catch {
        throw new HttpsError('invalid-argument', 'The encrypted message format is invalid.');
    }
    const recipients = envelope?.keys && typeof envelope.keys === 'object'
        ? Object.keys(envelope.keys).sort()
        : [];
    if (envelope?.v !== 1 || envelope.c !== conversationId || envelope.s !== uid
        || typeof envelope.fp !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.fp)
        || typeof envelope.epk !== 'string' || typeof envelope.iv !== 'string'
        || typeof envelope.data !== 'string' || typeof envelope.sig !== 'string'
        || JSON.stringify(recipients) !== JSON.stringify(memberIds.slice().sort())
        || recipients.some(id => {
            const key = envelope.keys[id];
            return !key || typeof key.salt !== 'string' || typeof key.iv !== 'string'
                || typeof key.data !== 'string';
        })) {
        throw new HttpsError('invalid-argument', 'The encrypted message does not match all current conversation members.');
    }
}

async function assertCanMessage(uid, conversation, transaction) {
    if (conversation.type !== 'private') return;
    const otherId = conversation.member_ids.find(memberId => memberId !== uid);
    if (!otherId) throw new HttpsError('failed-precondition', 'The conversation membership is invalid.');
    const [blockedByCaller, blockedByPeer] = await Promise.all([
        transaction.get(db.collection('blocks').doc(uid).collection('blocked').doc(otherId)),
        transaction.get(db.collection('blocks').doc(otherId).collection('blocked').doc(uid))
    ]);
    if (blockedByCaller.exists || blockedByPeer.exists) {
        throw new HttpsError('permission-denied', 'Messages are unavailable because of a block between participants.');
    }
}

function normalizeUsername(value) {
    if (typeof value !== 'string') {
        throw new HttpsError('invalid-argument', 'Enter a valid username.');
    }
    const username = value.trim().toLowerCase();
    if (!usernamePattern.test(username) || username.includes('..')) {
        throw new HttpsError('invalid-argument', 'Enter a valid username.');
    }
    return username;
}

exports.claimUsername = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in before choosing a username.');
    }

    const username = normalizeUsername(request.data?.username);
    const uid = request.auth.uid;
    const email = `${username}@gather.invalid`;
    const auth = getAuth();
    const user = await auth.getUser(uid);
    if (!user.email || user.email.toLowerCase() !== email) {
        throw new HttpsError('permission-denied', 'This account cannot claim that username.');
    }

    const claimRef = db.collection('usernameClaims').doc(username);
    await db.runTransaction(async transaction => {
        const claim = await transaction.get(claimRef);
        if (claim.exists) {
            if (claim.get('uid') !== uid) {
                throw new HttpsError('already-exists', 'That username is already taken.');
            }
            return;
        }
        transaction.create(claimRef, {
            uid,
            username,
            createdAt: FieldValue.serverTimestamp()
        });
    });

    const customClaims = {
        ...(user.customClaims || {}),
        gatherUsername: username
    };
    await auth.setCustomUserClaims(uid, customClaims);
    return { username };
});

exports.revokeOtherSessions = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in before updating session security.');
    }
    await getAuth().revokeRefreshTokens(request.auth.uid);
    return {};
});

exports.openDirectConversation = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in before starting a conversation.');
    }
    const uid = request.auth.uid;
    const peerId = request.data?.userId;
    if (typeof peerId !== 'string' || !peerId || peerId === uid) {
        throw new HttpsError('invalid-argument', 'Choose another Gather member.');
    }
    const pair = [uid, peerId].sort();
    const profiles = await db.getAll(...pair.map(id => db.collection('users').doc(id)));
    if (profiles.some(profile => !profile.exists)) {
        throw new HttpsError('not-found', 'That Gather member could not be found.');
    }
    const [blockedByCaller, blockedByPeer] = await Promise.all([
        db.collection('blocks').doc(uid).collection('blocked').doc(peerId).get(),
        db.collection('blocks').doc(peerId).collection('blocked').doc(uid).get()
    ]);
    if (blockedByCaller.exists || blockedByPeer.exists) {
        throw new HttpsError('permission-denied', 'A conversation with this person is unavailable.');
    }
    const hash = createHash('sha256').update(pair.join(':')).digest('hex');
    const conversationId = `direct_${hash}`;
    const ref = db.collection('conversations').doc(conversationId);
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
            transaction.create(ref, {
                type: 'private',
                title: '',
                member_ids: pair,
                roles: { [uid]: 'member', [peerId]: 'member' },
                created_by: uid,
                created_at: FieldValue.serverTimestamp(),
                updated_at: FieldValue.serverTimestamp(),
                latest_message: 'Start a conversation',
                latest_sender_id: ''
            });
        }
    });
    return { conversationId };
});

exports.createGroup = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in before creating a group.');
    }
    const uid = request.auth.uid;
    const title = typeof request.data?.title === 'string' ? request.data.title.trim() : '';
    const userIds = request.data?.userIds;
    if (title.length < 2 || title.length > 80 || !Array.isArray(userIds)
        || userIds.length < 1 || userIds.length > 20
        || userIds.some(id => typeof id !== 'string' || id === uid)
        || new Set(userIds).size !== userIds.length) {
        throw new HttpsError('invalid-argument', 'Choose a group name and one to twenty unique members.');
    }
    const memberIds = [uid, ...userIds];
    const memberRefs = memberIds.map(id => db.collection('users').doc(id));
    const profiles = await db.getAll(...memberRefs);
    if (profiles.some(profile => !profile.exists)) {
        throw new HttpsError('not-found', 'One or more group members could not be found.');
    }
    const roles = Object.fromEntries(memberIds.map(id => [id, id === uid ? 'admin' : 'member']));
    const ref = db.collection('conversations').doc();
    await ref.create({
        type: 'group',
        title,
        member_ids: memberIds,
        roles,
        created_by: uid,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        latest_message: 'Start a conversation',
        latest_sender_id: ''
    });
    return { conversationId: ref.id };
});

exports.changeGroupMember = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Sign in before changing group membership.');
    }
    const uid = request.auth.uid;
    const conversationId = request.data?.conversationId;
    const userId = request.data?.userId;
    const add = request.data?.add;
    if (typeof conversationId !== 'string' || typeof userId !== 'string'
        || typeof add !== 'boolean' || userId === uid) {
        throw new HttpsError('invalid-argument', 'The group member request is invalid.');
    }
    const conversationRef = db.collection('conversations').doc(conversationId);
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(conversationRef);
        if (!snapshot.exists || snapshot.get('type') !== 'group') {
            throw new HttpsError('not-found', 'Group not found.');
        }
        const memberIds = snapshot.get('member_ids') || [];
        const roles = snapshot.get('roles') || {};
        if (roles[uid] !== 'admin') {
            throw new HttpsError('permission-denied', 'Only a group administrator can change membership.');
        }
        if (add) {
            if (memberIds.includes(userId)) throw new HttpsError('already-exists', 'That person is already in the group.');
            if (memberIds.length >= 21) throw new HttpsError('resource-exhausted', 'This group has reached its member limit.');
            const profileSnapshot = await transaction.get(db.collection('users').doc(userId));
            if (!profileSnapshot.exists) throw new HttpsError('not-found', 'That Gather member could not be found.');
            memberIds.push(userId);
            roles[userId] = 'member';
        } else {
            if (!memberIds.includes(userId) || roles[userId] === 'admin') {
                throw new HttpsError('failed-precondition', 'This member cannot be removed.');
            }
            const index = memberIds.indexOf(userId);
            memberIds.splice(index, 1);
            delete roles[userId];
        }
        transaction.update(conversationRef, {
            member_ids: memberIds,
            roles,
            updated_at: FieldValue.serverTimestamp()
        });
    });
    return {};
});

exports.sendMessage = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before sending a message.');
    const uid = request.auth.uid;
    const conversationId = request.data?.conversationId;
    const body = request.data?.body;
    if (typeof conversationId !== 'string') {
        throw new HttpsError('invalid-argument', 'Choose a conversation.');
    }
    const conversationRef = db.collection('conversations').doc(conversationId);
    const rateRef = db.collection('messageRateLimits').doc(uid);
    const messageRef = conversationRef.collection('messages').doc();
    const now = Date.now();
    await db.runTransaction(async transaction => {
        const [conversationSnapshot, rateSnapshot] = await Promise.all([
            transaction.get(conversationRef),
            transaction.get(rateRef)
        ]);
        if (!conversationSnapshot.exists) throw new HttpsError('not-found', 'Conversation not found.');
        const conversation = conversationSnapshot.data();
        if (!conversation.member_ids.includes(uid)) {
            throw new HttpsError('permission-denied', 'You are not a member of this conversation.');
        }
        validateEnvelope(body, conversationId, uid, conversation.member_ids);
        const rate = rateSnapshot.exists ? rateSnapshot.data() : {};
        const sameWindow = Number.isFinite(rate.window_start)
            && now - rate.window_start < 60000;
        if (sameWindow && rate.count >= 30) {
            throw new HttpsError('resource-exhausted', 'You are sending messages too quickly. Please wait a moment.');
        }
        await assertCanMessage(uid, conversation, transaction);
        transaction.create(messageRef, {
            sender_id: uid,
            message_type: 'encrypted',
            body,
            is_deleted: false,
            created_at: FieldValue.serverTimestamp()
        });
        transaction.update(conversationRef, {
            latest_sender_id: uid,
            latest_message: 'Encrypted message',
            latest_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp()
        });
        transaction.set(rateRef, {
            window_start: sameWindow ? rate.window_start : now,
            count: sameWindow ? rate.count + 1 : 1
        });
    });
    return { messageId: messageRef.id };
});

exports.editMessage = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before editing a message.');
    const uid = request.auth.uid;
    const conversationId = request.data?.conversationId;
    const messageId = request.data?.messageId;
    const body = request.data?.body;
    if (typeof conversationId !== 'string' || typeof messageId !== 'string') {
        throw new HttpsError('invalid-argument', 'The message could not be found.');
    }
    const conversationRef = db.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    await db.runTransaction(async transaction => {
        const [conversationSnapshot, messageSnapshot] = await Promise.all([
            transaction.get(conversationRef),
            transaction.get(messageRef)
        ]);
        if (!conversationSnapshot.exists || !messageSnapshot.exists) {
            throw new HttpsError('not-found', 'Message not found.');
        }
        const conversation = conversationSnapshot.data();
        const message = messageSnapshot.data();
        if (!conversation.member_ids.includes(uid) || message.sender_id !== uid
            || message.is_deleted || Date.now() - message.created_at.toMillis() > 15 * 60 * 1000) {
            throw new HttpsError('permission-denied', 'This message cannot be edited.');
        }
        validateEnvelope(body, conversationId, uid, conversation.member_ids);
        await assertCanMessage(uid, conversation, transaction);
        transaction.update(messageRef, {
            body,
            edited_at: FieldValue.serverTimestamp()
        });
    });
    return {};
});

exports.deleteMessage = onCall({ region: 'us-central1' }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before deleting a message.');
    const uid = request.auth.uid;
    const conversationId = request.data?.conversationId;
    const messageId = request.data?.messageId;
    if (typeof conversationId !== 'string' || typeof messageId !== 'string') {
        throw new HttpsError('invalid-argument', 'The message could not be found.');
    }
    const conversationRef = db.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    await db.runTransaction(async transaction => {
        const [conversationSnapshot, messageSnapshot] = await Promise.all([
            transaction.get(conversationRef),
            transaction.get(messageRef)
        ]);
        if (!conversationSnapshot.exists || !messageSnapshot.exists
            || !conversationSnapshot.data().member_ids.includes(uid)
            || messageSnapshot.data().sender_id !== uid) {
            throw new HttpsError('permission-denied', 'You can only delete your own message.');
        }
        transaction.update(messageRef, {
            body: '',
            is_deleted: true,
            deleted_at: FieldValue.serverTimestamp()
        });
    });
    return {};
});
