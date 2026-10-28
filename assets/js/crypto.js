(() => {
    'use strict';

    const iterations = 600000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: true });

    function encodeBase64Url(value) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function decodeBase64Url(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
            throw new Error('The encrypted data is malformed.');
        }
        const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    function publicJwk(jwk) {
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
            || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
            throw new Error('An account has an invalid encryption identity.');
        }
        return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true };
    }

    async function fingerprint(encryptionKey, signingKey) {
        const identity = JSON.stringify({
            encryption: publicJwk(encryptionKey),
            signing: publicJwk(signingKey)
        });
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(identity)));
        const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        return hex.match(/.{1,4}/g).join(' ');
    }

    async function deriveBackupKey(passphrase, salt) {
        const material = await crypto.subtle.importKey(
            'raw',
            encoder.encode(passphrase),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function importedIdentity(userId, bundle, serverIdentity) {
        if (!bundle || bundle.v !== 1 || bundle.user_id !== userId
            || JSON.stringify(publicJwk(bundle.public_encryption_key))
                !== JSON.stringify(publicJwk(serverIdentity.public_encryption_key))
            || JSON.stringify(publicJwk(bundle.public_signing_key))
                !== JSON.stringify(publicJwk(serverIdentity.public_signing_key))) {
            throw new Error('The recovery passphrase or encryption backup is incorrect.');
        }
        const encryptionPrivateKey = await crypto.subtle.importKey(
            'jwk',
            bundle.encryption_private_key,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveBits']
        );
        const signingPrivateKey = await crypto.subtle.importKey(
            'jwk',
            bundle.signing_private_key,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']
        );
        const signingPublicKey = await crypto.subtle.importKey(
            'jwk',
            publicJwk(serverIdentity.public_signing_key),
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );
        const challenge = encoder.encode(`gather-e2ee-key-check-v1:${userId}`);
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, challenge);
        const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            signingPublicKey,
            signature,
            challenge
        );
        if (!valid) {
            throw new Error('The encryption keys do not match this account.');
        }
        return {
            userId,
            encryptionPrivateKey,
            signingPrivateKey,
            publicEncryptionKey: publicJwk(serverIdentity.public_encryption_key),
            publicSigningKey: publicJwk(serverIdentity.public_signing_key),
            fingerprint: await fingerprint(serverIdentity.public_encryption_key, serverIdentity.public_signing_key)
        };
    }

    async function createIdentity(userId, passphrase) {
        if (passphrase.length < 12) {
            throw new Error('Use an encryption recovery passphrase with at least 12 characters.');
        }
        const encryptionPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits']
        );
        const signingPair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
        );
        const publicEncryptionKey = publicJwk(await crypto.subtle.exportKey('jwk', encryptionPair.publicKey));
        const publicSigningKey = publicJwk(await crypto.subtle.exportKey('jwk', signingPair.publicKey));
        const bundle = {
            v: 1,
            user_id: userId,
            public_encryption_key: publicEncryptionKey,
            public_signing_key: publicSigningKey,
            encryption_private_key: await crypto.subtle.exportKey('jwk', encryptionPair.privateKey),
            signing_private_key: await crypto.subtle.exportKey('jwk', signingPair.privateKey)
        };
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const backupKey = await deriveBackupKey(passphrase, salt);
        const ciphertext = await crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv,
            additionalData: encoder.encode(`gather-e2ee-key-backup-v1:${userId}`)
        }, backupKey, encoder.encode(JSON.stringify(bundle)));
        const backup = {
            public_encryption_key: publicEncryptionKey,
            public_signing_key: publicSigningKey,
            backup_salt: encodeBase64Url(salt),
            backup_iv: encodeBase64Url(iv),
            backup_ciphertext: encodeBase64Url(ciphertext),
            kdf_iterations: iterations
        };
        const serverIdentity = {
            public_encryption_key: publicEncryptionKey,
            public_signing_key: publicSigningKey,
            backup_salt: backup.backup_salt,
            backup_iv: backup.backup_iv,
            backup_ciphertext: backup.backup_ciphertext,
            kdf_iterations: iterations
        };
        const identity = await importedIdentity(userId, bundle, serverIdentity);
        return { identity, backup };
    }

    async function unlockIdentity(userId, passphrase, serverIdentity) {
        if (!serverIdentity || serverIdentity.kdf_iterations !== iterations) {
            throw new Error('This encryption backup uses an unsupported format.');
        }
        const key = await deriveBackupKey(passphrase, decodeBase64Url(serverIdentity.backup_salt));
        let plaintext;
        try {
            plaintext = await crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: decodeBase64Url(serverIdentity.backup_iv),
                additionalData: encoder.encode(`gather-e2ee-key-backup-v1:${userId}`)
            }, key, decodeBase64Url(serverIdentity.backup_ciphertext));
        } catch (error) {
            throw new Error('That recovery passphrase is incorrect.');
        }
        let bundle;
        try {
            bundle = JSON.parse(decoder.decode(plaintext));
        } catch (error) {
            throw new Error('The encrypted key backup is damaged.');
        }
        return importedIdentity(userId, bundle, serverIdentity);
    }

    async function deriveWrappingKey(privateKey, publicKey, salt, conversationId, senderId, recipientId) {
        const peerKey = await crypto.subtle.importKey(
            'jwk',
            publicJwk(publicKey),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
        const sharedSecret = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: peerKey },
            privateKey,
            256
        );
        const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey({
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: encoder.encode(`gather-e2ee-wrap-v1:${conversationId}:${senderId}:${recipientId}`)
        }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    function signedEnvelope(envelope) {
        const keys = {};
        Object.keys(envelope.keys).sort().forEach(id => {
            keys[id] = envelope.keys[id];
        });
        return JSON.stringify({
            v: envelope.v,
            c: envelope.c,
            s: envelope.s,
            fp: envelope.fp,
            epk: envelope.epk,
            iv: envelope.iv,
            data: envelope.data,
            keys
        });
    }

    async function encryptMessage(identity, conversation, members, text) {
        const recipients = members.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (!recipients.length || recipients.some(member => !member.encryption_public_key || !member.signing_public_key)) {
            throw new Error('Every participant must set up end-to-end encryption before messaging.');
        }
        const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const contentKeyBytes = await crypto.subtle.exportKey('raw', contentKey);
        const contentIv = crypto.getRandomValues(new Uint8Array(12));
        const content = await crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv: contentIv,
            additionalData: encoder.encode(`gather-e2ee-message-v1:${conversation.id}:${identity.userId}`)
        }, contentKey, encoder.encode(text));
        const ephemeralPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits']
        );
        const ephemeralPublicKey = encodeBase64Url(await crypto.subtle.exportKey('raw', ephemeralPair.publicKey));
        const wrappedKeys = {};
        for (const recipient of recipients) {
            const recipientId = String(recipient.id);
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const wrappingKey = await deriveWrappingKey(
                ephemeralPair.privateKey,
                recipient.encryption_public_key,
                salt,
                conversation.id,
                identity.userId,
                recipientId
            );
            const wrapped = await crypto.subtle.encrypt({
                name: 'AES-GCM',
                iv,
                additionalData: encoder.encode(`gather-e2ee-key-v1:${conversation.id}:${identity.userId}:${recipientId}`)
            }, wrappingKey, contentKeyBytes);
            wrappedKeys[String(recipientId)] = {
                salt: encodeBase64Url(salt),
                iv: encodeBase64Url(iv),
                data: encodeBase64Url(wrapped)
            };
        }
        const envelope = {
            v: 1,
            c: String(conversation.id),
            s: identity.userId,
            fp: identity.fingerprint.replace(/ /g, ''),
            epk: ephemeralPublicKey,
            iv: encodeBase64Url(contentIv),
            data: encodeBase64Url(content),
            keys: wrappedKeys
        };
        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            identity.signingPrivateKey,
            encoder.encode(signedEnvelope(envelope))
        );
        envelope.sig = encodeBase64Url(signature);
        return JSON.stringify(envelope);
    }

    async function decryptMessage(identity, conversationId, message, pinnedFingerprint) {
        if (message.message_type !== 'encrypted') {
            throw new Error('This is a legacy plaintext message; it was not end-to-end encrypted.');
        }
        let envelope;
        try {
            envelope = JSON.parse(message.body);
        } catch (error) {
            throw new Error('This encrypted message is malformed.');
        }
        const senderEncryptionKey = message.sender_encryption_public_key;
        const senderSigningKey = message.sender_signing_public_key;
        if (!senderEncryptionKey || !senderSigningKey
            || envelope.v !== 1
            || envelope.c !== String(conversationId)
            || envelope.s !== String(message.sender_id)
            || typeof envelope.sig !== 'string'
            || typeof envelope.fp !== 'string'
            || await fingerprint(senderEncryptionKey, senderSigningKey) !== envelope.fp.match(/.{1,4}/g)?.join(' ')) {
            throw new Error('The sender identity or encrypted message is invalid.');
        }
        const senderFingerprint = envelope.fp.match(/.{1,4}/g)?.join(' ');
        if (pinnedFingerprint !== senderFingerprint) {
            throw new Error('Verify this sender’s encryption fingerprint before reading their message.');
        }
        const verifyingKey = await crypto.subtle.importKey(
            'jwk',
            publicJwk(senderSigningKey),
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );
        const signed = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            verifyingKey,
            decodeBase64Url(envelope.sig),
            encoder.encode(signedEnvelope(envelope))
        );
        if (!signed) {
            throw new Error('The sender signature is invalid; the message may have been changed.');
        }
        const recipientEnvelope = envelope.keys?.[String(identity.userId)];
        if (!recipientEnvelope || typeof envelope.epk !== 'string') {
            throw new Error('This encrypted message was not addressed to this account.');
        }
        const ephemeralPublicKey = await crypto.subtle.importKey(
            'raw',
            decodeBase64Url(envelope.epk),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
        const sharedSecret = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: ephemeralPublicKey },
            identity.encryptionPrivateKey,
            256
        );
        const salt = decodeBase64Url(recipientEnvelope.salt);
        const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
        const wrappingKey = await crypto.subtle.deriveKey({
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: encoder.encode(`gather-e2ee-wrap-v1:${conversationId}:${message.sender_id}:${identity.userId}`)
        }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const unwrapped = await crypto.subtle.decrypt({
            name: 'AES-GCM',
            iv: decodeBase64Url(recipientEnvelope.iv),
            additionalData: encoder.encode(`gather-e2ee-key-v1:${conversationId}:${message.sender_id}:${identity.userId}`)
        }, wrappingKey, decodeBase64Url(recipientEnvelope.data));
        const contentKey = await crypto.subtle.importKey('raw', unwrapped, { name: 'AES-GCM' }, false, ['decrypt']);
        const plaintext = await crypto.subtle.decrypt({
            name: 'AES-GCM',
            iv: decodeBase64Url(envelope.iv),
            additionalData: encoder.encode(`gather-e2ee-message-v1:${conversationId}:${message.sender_id}`)
        }, contentKey, decodeBase64Url(envelope.data));
        return decoder.decode(plaintext);
    }

    window.GatherCrypto = {
        createIdentity,
        decryptMessage,
        encryptMessage,
        fingerprint,
        unlockIdentity
    };
})();
