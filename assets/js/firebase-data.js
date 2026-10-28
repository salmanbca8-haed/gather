(() => {
    'use strict';

    if (!window.firebase?.firestore) {
        throw new Error('Firebase Firestore could not be initialized.');
    }

    const db = firebase.firestore();
    const timestamp = () => firebase.firestore.FieldValue.serverTimestamp();
    const currentUid = () => {
        const user = firebase.auth().currentUser;
        if (!user) throw new Error('Please sign in to continue.');
        return user.uid;
    };

    function dateValue(value) {
        if (!value) return null;
        const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function userSummary(uid, data) {
        return {
            id: uid,
            username: data.username,
            display_name: data.display_name || data.username,
            bio: data.bio || '',
            avatar_url: data.avatar_data || null,
            show_last_seen: data.show_last_seen !== false,
            last_seen_at: dateValue(data.last_seen_at)
        };
    }

    function parseEnvelope(body) {
        if (typeof body !== 'string' || body.length > 60000) {
            throw new Error('The encrypted message is too large or malformed.');
        }
        let envelope;
        try {
            envelope = JSON.parse(body);
        } catch {
            throw new Error('The encrypted message format is invalid.');
        }
        if (!envelope || envelope.v !== 1 || typeof envelope.c !== 'string'
            || typeof envelope.s !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.fp || '')
            || !envelope.keys || typeof envelope.keys !== 'object') {
            throw new Error('The encrypted message format is invalid.');
        }
        return envelope;
    }

    async function profile(uid = currentUid()) {
        const snapshot = await db.collection('users').doc(uid).get();
        if (!snapshot.exists) return null;
        const data = snapshot.data();
        const presence = data.show_last_seen || uid === currentUid()
            ? await db.collection('presence').doc(uid).get()
            : null;
        return userSummary(uid, {
            ...data,
            last_seen_at: presence?.exists ? presence.data().last_seen_at : null
        });
    }

    async function identity(uid) {
        const [publicSnapshot, backupSnapshot] = await Promise.all([
            db.collection('identities').doc(uid).get(),
            uid === currentUid() ? db.collection('keyBackups').doc(uid).get() : Promise.resolve(null)
        ]);
        if (!publicSnapshot.exists) return null;
        const publicData = publicSnapshot.data();
        const backup = backupSnapshot?.exists ? backupSnapshot.data() : {};
        return {
            public_encryption_key: publicData.public_encryption_key,
            public_signing_key: publicData.public_signing_key,
            backup_salt: backup.backup_salt,
            backup_iv: backup.backup_iv,
            backup_ciphertext: backup.backup_ciphertext,
            kdf_iterations: backup.kdf_iterations
        };
    }

    async function memberSummary(uid, role) {
        const [user, keys] = await Promise.all([profile(uid), identity(uid)]);
        if (!user) throw new Error('A conversation participant profile is unavailable.');
        return {
            ...user,
            role: role || 'member',
            last_seen_at: user.show_last_seen ? user.last_seen_at : null,
            online: Boolean(user.show_last_seen && user.last_seen_at
                && Date.now() - new Date(user.last_seen_at).getTime() < 120000),
            encryption_public_key: keys?.public_encryption_key || null,
            signing_public_key: keys?.public_signing_key || null
        };
    }

    function conversationLabel(data, members, uid) {
        if (data.type === 'group') {
            return { title: data.title, username: '', avatar_url: null };
        }
        const peer = members.find(member => member.id !== uid);
        return {
            title: peer?.display_name || 'Conversation',
            username: peer?.username || '',
            avatar_url: peer?.avatar_url || null
        };
    }

    async function conversationDetails(id) {
        const snapshot = await db.collection('conversations').doc(String(id)).get();
        if (!snapshot.exists) throw new Error('Conversation not found.');
        const data = snapshot.data();
        const uid = currentUid();
        if (!data.member_ids?.includes(uid)) throw new Error('You are not a member of this conversation.');
        const members = await Promise.all(data.member_ids.map(memberUid =>
            memberSummary(memberUid, data.roles?.[memberUid])
        ));
        return {
            id: snapshot.id,
            type: data.type,
            title: data.title || '',
            role: data.roles?.[uid] || 'member',
            members,
            ...conversationLabel(data, members, uid)
        };
    }

    async function conversations() {
        const uid = currentUid();
        const snapshot = await db.collection('conversations')
            .where('member_ids', 'array-contains', uid).get();
        const items = await Promise.all(snapshot.docs.map(async doc => {
            const data = doc.data();
            const members = await Promise.all(data.member_ids.map(memberUid => profile(memberUid)));
            const label = conversationLabel(data, members.filter(Boolean), uid);
            return {
                id: doc.id,
                type: data.type,
                title: label.title,
                username: label.username,
                avatar_url: label.avatar_url,
                latest_at: dateValue(data.latest_at || data.created_at),
                latest_sender_id: data.latest_sender_id || '',
                latest_message: data.latest_message || 'Start a conversation',
                unread_count: 0
            };
        }));
        items.sort((a, b) => new Date(b.latest_at || 0) - new Date(a.latest_at || 0));
        return { conversations: items };
    }

    async function messageRecord(doc, conversationId) {
        const data = doc.data();
        const [sender, senderIdentity] = await Promise.all([
            profile(data.sender_id),
            db.collection('identities').doc(data.sender_id).get()
        ]);
        const senderKeys = senderIdentity.exists ? senderIdentity.data() : {};
        return {
            id: doc.id,
            conversation_id: conversationId,
            sender_id: data.sender_id,
            sender_name: sender?.display_name || 'Gather member',
            sender_username: sender?.username || '',
            sender_encryption_public_key: senderKeys.public_encryption_key || null,
            sender_signing_public_key: senderKeys.public_signing_key || null,
            message_type: data.message_type,
            body: data.is_deleted ? '' : JSON.stringify(data.body),
            is_deleted: Boolean(data.is_deleted),
            created_at: dateValue(data.created_at),
            edited_at: dateValue(data.edited_at)
        };
    }

    async function messages(query = {}) {
        const conversationId = String(query.conversation_id || '');
        const collection = db.collection('conversations').doc(conversationId).collection('messages');
        let request;
        if (query.before_id) {
            const cursor = await collection.doc(String(query.before_id)).get();
            request = collection.orderBy('created_at', 'desc').endBefore(cursor).limit(31);
        } else if (query.after_id) {
            const cursor = await collection.doc(String(query.after_id)).get();
            request = collection.orderBy('created_at', 'asc').startAfter(cursor).limit(30);
        } else {
            request = collection.orderBy('created_at', 'desc').limit(31);
        }
        const snapshot = await request.get();
        const docs = query.after_id ? snapshot.docs : snapshot.docs.slice(0, 30).reverse();
        const result = await Promise.all(docs.map(doc => messageRecord(doc, conversationId)));
        return {
            messages: result,
            oldest_id: result[0]?.id || null,
            has_more: !query.after_id && snapshot.docs.length > 30
        };
    }

    async function searchUsers(term) {
        const query = term.trim().toLowerCase();
        if (query.length < 2) return { users: [] };
        const upper = `${query}\uf8ff`;
        const [usernameResults, nameResults] = await Promise.all([
            db.collection('users').orderBy('username').startAt(query).endAt(upper).limit(12).get(),
            db.collection('users').orderBy('display_name').startAt(term.trim()).endAt(`${term.trim()}\uf8ff`).limit(12).get()
        ]);
        const unique = new Map();
        [...usernameResults.docs, ...nameResults.docs].forEach(doc => {
            if (doc.id !== currentUid()) unique.set(doc.id, doc.data());
        });
        return {
            users: [...unique].slice(0, 12).map(([uid, data]) => userSummary(uid, data))
        };
    }

    async function resizeAvatar(file) {
        if (!(file instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
            || file.size < 1 || file.size > 2 * 1024 * 1024) {
            throw new Error('Choose a JPG, PNG, or WebP photo up to 2 MB.');
        }
        let image;
        try {
            image = await createImageBitmap(file);
        } catch {
            throw new Error('This image file could not be decoded.');
        }
        if (!image.width || !image.height || image.width > 4096 || image.height > 4096) {
            image.close();
            throw new Error('The image dimensions must be 4096 × 4096 pixels or smaller.');
        }
        const scale = Math.min(1, 512 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) {
            image.close();
            throw new Error('Your browser could not process this photo.');
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        for (const quality of [0.82, 0.68, 0.52, 0.38]) {
            const result = canvas.toDataURL('image/jpeg', quality);
            if (result.length <= 700000) return result;
        }
        throw new Error('This photo could not be compressed enough to save. Choose a smaller image.');
    }

    function directConversationId(uid, peerId) {
        return `direct_${[uid, peerId].sort().join('_')}`;
    }

    async function request(action, options = {}) {
        const body = options.body || {};
        const query = options.query || {};
        const uid = firebase.auth().currentUser?.uid || null;

        if (action === 'bootstrap') return { user: uid ? await profile(uid) : null };
        if (action === 'register') {
            if (!uid) throw new Error('Sign in before creating your profile.');
            const username = String(body.username || '').trim().toLowerCase();
            const email = firebase.auth().currentUser?.email?.toLowerCase();
            if (email !== `${username}@gather.invalid`) {
                throw new Error('The Firebase username does not match this account. Sign in with the username you registered.');
            }
            const displayName = String(body.display_name || '').trim();
            if (displayName.length < 2 || displayName.length > 60) {
                throw new Error('Display name must be 2–60 characters.');
            }
            const claimRef = db.collection('usernameClaims').doc(username);
            const userRef = db.collection('users').doc(uid);
            await db.runTransaction(async transaction => {
                const [claim, existingUser] = await Promise.all([
                    transaction.get(claimRef),
                    transaction.get(userRef)
                ]);
                if (claim.exists) {
                    if (claim.data().uid !== uid) throw new Error('That username is already taken.');
                    if (existingUser.exists) throw new Error('This Gather profile already exists. Sign in instead.');
                } else {
                    transaction.set(claimRef, {
                        uid,
                        username,
                        created_at: timestamp()
                    });
                }
                transaction.set(userRef, {
                    username,
                    display_name: displayName,
                    bio: '',
                    avatar_data: null,
                    show_last_seen: true,
                    created_at: timestamp(),
                    updated_at: timestamp()
                });
            });
            return { user: await profile(uid) };
        }
        if (!uid) throw new Error('Please sign in to continue.');
        if (action === 'logout') return {};
        if (action === 'conversations') return conversations();
        if (action === 'conversations.details') return { conversation: await conversationDetails(query.id) };
        if (action === 'users.search') return searchUsers(String(query.q || ''));
        if (action === 'conversations.direct') {
            const peerId = String(body.user_id || '');
            if (!peerId || peerId === uid) throw new Error('Choose another Gather member.');
            const peer = await profile(peerId);
            if (!peer) throw new Error('That Gather member could not be found.');
            const id = directConversationId(uid, peerId);
            const ref = db.collection('conversations').doc(id);
            await db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists) {
                    const members = [uid, peerId].sort();
                    transaction.set(ref, {
                        type: 'private',
                        title: '',
                        member_ids: members,
                        roles: { [uid]: 'member', [peerId]: 'member' },
                        created_by: uid,
                        created_at: timestamp(),
                        latest_message: 'Start a conversation',
                        latest_sender_id: ''
                    });
                }
            });
            return { conversation_id: id };
        }
        if (action === 'conversations.create-group') {
            const title = String(body.title || '').trim();
            const userIds = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.map(String))] : [];
            if (title.length < 2 || title.length > 80 || !userIds.length || userIds.length > 20
                || userIds.includes(uid)) {
                throw new Error('Choose a group name and one to twenty other members.');
            }
            const members = [uid, ...userIds];
            const userRefs = members.map(id => db.collection('users').doc(id));
            const conversationRef = db.collection('conversations').doc();
            await db.runTransaction(async transaction => {
                const snapshots = await Promise.all(userRefs.map(ref => transaction.get(ref)));
                if (snapshots.some(snapshot => !snapshot.exists)) throw new Error('A selected member could not be found.');
                const roles = Object.fromEntries(members.map(id => [id, id === uid ? 'admin' : 'member']));
                transaction.set(conversationRef, {
                    type: 'group',
                    title,
                    member_ids: members,
                    roles,
                    created_by: uid,
                    created_at: timestamp(),
                    latest_message: 'Start a conversation',
                    latest_sender_id: ''
                });
            });
            return { conversation_id: conversationRef.id };
        }
        if (action === 'groups.add-member' || action === 'groups.remove-member') {
            const conversationRef = db.collection('conversations').doc(String(body.conversation_id));
            const memberRef = db.collection('users').doc(String(body.user_id));
            await db.runTransaction(async transaction => {
                const conversation = await transaction.get(conversationRef);
                if (!conversation.exists || conversation.data().type !== 'group') throw new Error('Group not found.');
                const data = conversation.data();
                if (data.roles?.[uid] !== 'admin') throw new Error('Only a group administrator can change membership.');
                const memberIds = data.member_ids.slice();
                const roles = { ...data.roles };
                const targetId = String(body.user_id);
                if (targetId === uid) throw new Error('Choose another member.');
                if (action === 'groups.add-member') {
                    const target = await transaction.get(memberRef);
                    if (!target.exists) throw new Error('That Gather member could not be found.');
                    if (memberIds.includes(targetId)) throw new Error('That person is already in this group.');
                    if (memberIds.length >= 21) throw new Error('This group has reached its 21-member limit.');
                    memberIds.push(targetId);
                    roles[targetId] = 'member';
                } else {
                    if (!memberIds.includes(targetId) || roles[targetId] === 'admin') {
                        throw new Error('This member cannot be removed.');
                    }
                    memberIds.splice(memberIds.indexOf(targetId), 1);
                    delete roles[targetId];
                }
                transaction.update(conversationRef, {
                    member_ids: memberIds,
                    roles,
                    updated_at: timestamp()
                });
            });
            return {};
        }
        if (action === 'messages') return messages(query);
        if (action === 'messages.send') {
            const conversationId = String(body.conversation_id || '');
            const envelope = parseEnvelope(body.body);
            if (envelope.c !== conversationId || envelope.s !== uid) {
                throw new Error('The encrypted message does not match this conversation.');
            }
            const conversationRef = db.collection('conversations').doc(conversationId);
            const rateRef = db.collection('messageRateLimits').doc(uid);
            const messageRef = conversationRef.collection('messages').doc();
            await db.runTransaction(async transaction => {
                const [conversation, rate] = await Promise.all([
                    transaction.get(conversationRef),
                    transaction.get(rateRef)
                ]);
                if (!conversation.exists || !conversation.data().member_ids.includes(uid)) {
                    throw new Error('You are not a member of this conversation.');
                }
                const memberIds = conversation.data().member_ids.slice().sort();
                if (JSON.stringify(Object.keys(envelope.keys).sort()) !== JSON.stringify(memberIds)) {
                    throw new Error('The encrypted message must include all current conversation members.');
                }
                const rateData = rate.exists ? rate.data() : null;
                const sameWindow = rateData && Date.now() - rateData.window_start.toMillis() < 60000;
                if (sameWindow && rateData.count >= 30) {
                    throw new Error('You are sending messages too quickly. Please wait a moment.');
                }
                transaction.set(rateRef, {
                    window_start: sameWindow ? rateData.window_start : timestamp(),
                    count: sameWindow ? rateData.count + 1 : 1
                });
                transaction.set(messageRef, {
                    sender_id: uid,
                    message_type: 'encrypted',
                    body: JSON.parse(body.body),
                    is_deleted: false,
                    created_at: timestamp()
                });
                transaction.update(conversationRef, {
                    latest_sender_id: uid,
                    latest_message: 'Encrypted message',
                    latest_message_id: messageRef.id,
                    latest_at: timestamp()
                });
            });
            return { message: await messageRecord(await messageRef.get(), conversationId) };
        }
        if (action === 'messages.edit') {
            const conversationId = String(body.conversation_id || '');
            const messageRef = db.collection('conversations').doc(conversationId)
                .collection('messages').doc(String(body.message_id));
            const envelope = parseEnvelope(body.body);
            if (envelope.c !== conversationId || envelope.s !== uid) {
                throw new Error('The encrypted message does not match this conversation.');
            }
            await db.runTransaction(async transaction => {
                const [conversation, message] = await Promise.all([
                    transaction.get(db.collection('conversations').doc(conversationId)),
                    transaction.get(messageRef)
                ]);
                if (!conversation.exists || !message.exists
                    || !conversation.data().member_ids.includes(uid)
                    || message.data().sender_id !== uid || message.data().is_deleted
                    || Date.now() - message.data().created_at.toMillis() > 15 * 60 * 1000) {
                    throw new Error('This message cannot be edited.');
                }
                transaction.update(messageRef, { body: envelope, edited_at: timestamp() });
            });
            return { message: await messageRecord(await messageRef.get(), conversationId) };
        }
        if (action === 'messages.delete') {
            const conversationId = String(body.conversation_id || '');
            const conversationRef = db.collection('conversations').doc(conversationId);
            const messageRef = conversationRef.collection('messages').doc(String(body.message_id));
            await db.runTransaction(async transaction => {
                const [conversation, message] = await Promise.all([
                    transaction.get(conversationRef),
                    transaction.get(messageRef)
                ]);
                if (!conversation.exists || !message.exists
                    || !conversation.data().member_ids.includes(uid)
                    || message.data().sender_id !== uid) {
                    throw new Error('You can only delete your own message.');
                }
                transaction.update(messageRef, {
                    body: {},
                    is_deleted: true,
                    deleted_at: timestamp()
                });
                if (conversation.data().latest_message_id === message.id) {
                    transaction.update(conversationRef, {
                        latest_message: 'Message deleted',
                        latest_message_id: message.id,
                        latest_at: timestamp()
                    });
                }
            });
            return { message_id: String(body.message_id), deleted_for_everyone: true };
        }
        if (action === 'messages.read') {
            const ref = db.collection('conversations').doc(String(body.conversation_id))
                .collection('members').doc(uid);
            await ref.set({
                last_read_message_id: String(body.through_id),
                last_read_at: timestamp()
            }, { merge: true });
            return {};
        }
        if (action === 'crypto.account') return { identity: await identity(uid) };
        if (action === 'crypto.identity-register') {
            const backup = body;
            const batch = db.batch();
            batch.set(db.collection('identities').doc(uid), {
                public_encryption_key: backup.public_encryption_key,
                public_signing_key: backup.public_signing_key,
                updated_at: timestamp()
            });
            batch.set(db.collection('keyBackups').doc(uid), {
                backup_salt: backup.backup_salt,
                backup_iv: backup.backup_iv,
                backup_ciphertext: backup.backup_ciphertext,
                kdf_iterations: backup.kdf_iterations,
                updated_at: timestamp()
            });
            await batch.commit();
            return {};
        }
        if (action === 'profile.avatar-upload') {
            const file = body instanceof FormData ? body.get('avatar') : null;
            const avatarData = await resizeAvatar(file);
            await db.collection('users').doc(uid).update({
                avatar_data: avatarData,
                updated_at: timestamp()
            });
            return { user: await profile(uid) };
        }
        if (action === 'profile.avatar-remove') {
            await db.collection('users').doc(uid).update({
                avatar_data: null,
                updated_at: timestamp()
            });
            return { user: await profile(uid) };
        }
        if (action === 'profile.update') {
            const displayName = String(body.display_name || '').trim();
            const bio = String(body.bio || '').trim();
            if (displayName.length < 2 || displayName.length > 60 || bio.length > 280) {
                throw new Error('Check the display name and bio lengths.');
            }
            await db.collection('users').doc(uid).update({
                display_name: displayName,
                bio,
                show_last_seen: Boolean(body.show_last_seen),
                updated_at: timestamp()
            });
            return { user: await profile(uid) };
        }
        if (action === 'presence.update') {
            await db.collection('presence').doc(uid).set({ last_seen_at: timestamp() });
            return {};
        }
        if (action === 'blocks.add') {
            await db.collection('blocks').doc(uid).collection('blocked').doc(String(body.user_id))
                .set({ created_at: timestamp() });
            return {};
        }
        throw new Error(`Unsupported Firebase operation: ${action}`);
    }

    window.GatherData = Object.freeze({ request });
})();
