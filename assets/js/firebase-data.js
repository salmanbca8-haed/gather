(() => {
    'use strict';

    if (!window.firebase?.firestore || !window.firebase?.storage) {
        throw new Error('Firebase data services could not be initialized.');
    }

    const db = firebase.firestore();
    const storage = firebase.storage();
    const functions = firebase.app().functions('us-central1');
    const avatarUrls = new Map();
    const openDirectConversation = functions.httpsCallable('openDirectConversation');
    const createGroup = functions.httpsCallable('createGroup');
    const changeGroupMember = functions.httpsCallable('changeGroupMember');
    const sendMessage = functions.httpsCallable('sendMessage');
    const editMessage = functions.httpsCallable('editMessage');
    const deleteMessage = functions.httpsCallable('deleteMessage');
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

    function userSummary(uid, data, avatarUrl = null) {
        return {
            id: uid,
            username: data.username,
            display_name: data.display_name || data.username,
            bio: data.bio || '',
            avatar_url: avatarUrl,
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
        let avatarUrl = null;
        if (typeof data.avatar_path === 'string') {
            avatarUrl = avatarUrls.get(data.avatar_path) || null;
            if (!avatarUrl) {
                avatarUrl = await storage.ref(data.avatar_path).getDownloadURL();
                avatarUrls.set(data.avatar_path, avatarUrl);
            }
        }
        return userSummary(uid, data, avatarUrl);
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
            const compactMembers = members.filter(Boolean);
            const label = conversationLabel(data, compactMembers, uid);
            return {
                id: doc.id,
                type: data.type,
                title: label.title,
                username: label.username,
                avatar_url: label.avatar_url,
                latest_at: dateValue(data.latest_at || data.updated_at || data.created_at),
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
            body: data.is_deleted ? '' : data.body,
            is_deleted: Boolean(data.is_deleted),
            created_at: dateValue(data.created_at),
            edited_at: dateValue(data.edited_at)
        };
    }

    async function messages(query = {}) {
        const conversationId = String(query.conversation_id || '');
        const collection = db.collection('conversations').doc(conversationId).collection('messages');
        const base = collection
            .orderBy('created_at', 'desc');
        let request;
        if (query.before_id) {
            const cursor = await db.collection('conversations').doc(conversationId)
                .collection('messages').doc(String(query.before_id)).get();
            request = base.endBefore(cursor).limit(31);
        } else if (query.after_id) {
            const cursor = await collection.doc(String(query.after_id)).get();
            request = collection.orderBy('created_at', 'asc').startAfter(cursor).limit(30);
        } else {
            request = base.limit(31);
        }
        const snapshot = await request.get();
        const docs = query.after_id
            ? snapshot.docs.slice(0, 30)
            : snapshot.docs.slice(0, 30).reverse();
        const result = await Promise.all(docs.map(doc => messageRecord(doc, conversationId)));
        return {
            messages: result,
            oldest_id: result[0]?.id || null,
            has_more: snapshot.docs.length > 30
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
            if (doc.id !== currentUid()) unique.set(doc.id, doc.id);
        });
        const users = await Promise.all([...unique.values()].slice(0, 12).map(profile));
        return { users: users.filter(Boolean) };
    }

    async function getMessage(id, conversationId) {
        const ref = db.collection('conversations').doc(String(conversationId))
            .collection('messages').doc(String(id));
        const snapshot = await ref.get();
        if (!snapshot.exists) throw new Error('Message not found.');
        return { ref, conversationId: String(conversationId) };
    }

    async function request(action, options = {}) {
        const body = options.body || {};
        const query = options.query || {};
        const uid = firebase.auth().currentUser?.uid || null;

        if (action === 'bootstrap') {
            const user = uid ? await profile(uid) : null;
            return { user };
        }
        if (action === 'register') {
            if (!uid) throw new Error('Sign in before creating your profile.');
            const username = String(body.username || '').trim().toLowerCase();
            const claimed = firebase.auth().currentUser?.getIdTokenResult
                ? (await firebase.auth().currentUser.getIdTokenResult(true)).claims.gatherUsername
                : null;
            if (claimed !== username) throw new Error('The Firebase username does not match this account.');
            const displayName = String(body.display_name || '').trim();
            if (displayName.length < 2 || displayName.length > 60) throw new Error('Display name must be 2–60 characters.');
            const user = {
                username,
                display_name: displayName,
                bio: '',
                avatar_path: null,
                show_last_seen: true,
                last_seen_at: null,
                created_at: timestamp(),
                updated_at: timestamp()
            };
            const ref = db.collection('users').doc(uid);
            const existing = await ref.get();
            if (!existing.exists) await ref.set(user);
            return { user: userSummary(uid, existing.exists ? existing.data() : user) };
        }
        if (!uid && action !== 'logout') throw new Error('Please sign in to continue.');
        if (action === 'conversations') return conversations();
        if (action === 'conversations.details') return { conversation: await conversationDetails(query.id) };
        if (action === 'users.search') return searchUsers(String(query.q || ''));
        if (action === 'conversations.direct') {
            const peerId = String(body.user_id || '');
            if (!peerId || peerId === uid) throw new Error('Choose another Gather member.');
            const response = await openDirectConversation({ userId: peerId });
            return { conversation_id: response.data.conversationId };
        }
        if (action === 'conversations.create-group') {
            const response = await createGroup({
                title: String(body.title || '').trim(),
                userIds: Array.isArray(body.user_ids) ? body.user_ids.map(String) : []
            });
            return { conversation_id: response.data.conversationId };
        }
        if (action === 'groups.add-member' || action === 'groups.remove-member') {
            const response = await changeGroupMember({
                conversationId: String(body.conversation_id),
                userId: String(body.user_id),
                add: action === 'groups.add-member'
            });
            return response.data;
        }
        if (action === 'messages') return messages(query);
        if (action === 'messages.send') {
            const conversationId = String(body.conversation_id || '');
            const envelope = parseEnvelope(body.body);
            if (envelope.c !== conversationId || envelope.s !== uid) {
                throw new Error('The encrypted message does not match this conversation.');
            }
            const response = await sendMessage({ conversationId, body: body.body });
            const messageRef = db.collection('conversations').doc(conversationId)
                .collection('messages').doc(response.data.messageId);
            return { message: await messageRecord(await messageRef.get(), conversationId) };
        }
        if (action === 'messages.edit') {
            const found = await getMessage(body.message_id, body.conversation_id);
            parseEnvelope(body.body);
            await editMessage({
                conversationId: found.conversationId,
                messageId: String(body.message_id),
                body: body.body
            });
            return { message: await messageRecord(await found.ref.get(), found.conversationId) };
        }
        if (action === 'messages.delete') {
            const found = await getMessage(body.message_id, body.conversation_id);
            await deleteMessage({
                conversationId: found.conversationId,
                messageId: String(body.message_id)
            });
            return { message_id: String(body.message_id), deleted_for_everyone: true };
        }
        if (action === 'messages.read') {
            const ref = db.collection('conversations').doc(String(body.conversation_id))
                .collection('members').doc(uid);
            await ref.set({ last_read_message_id: String(body.through_id), last_read_at: timestamp() }, { merge: true });
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
            const validDimensions = image.width > 0 && image.height > 0
                && image.width <= 4096 && image.height <= 4096;
            image.close();
            if (!validDimensions) throw new Error('The image dimensions must be 4096 × 4096 pixels or smaller.');
            const path = `avatars/${uid}/profile`;
            const ref = storage.ref(path);
            await ref.put(file, { contentType: file.type });
            avatarUrls.delete(path);
            await db.collection('users').doc(uid).update({ avatar_path: path, updated_at: timestamp() });
            return { user: await profile(uid) };
        }
        if (action === 'profile.avatar-remove') {
            const user = await profile(uid);
            const path = `avatars/${uid}/profile`;
            if (user?.avatar_url) {
                await storage.ref(path).delete();
                avatarUrls.delete(path);
            }
            await db.collection('users').doc(uid).update({ avatar_path: null, updated_at: timestamp() });
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
            await db.collection('users').doc(uid).update({ last_seen_at: timestamp() });
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
