(() => {
    'use strict';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const state = {
        user: null,
        authBusy: false,
        conversations: [],
        activeId: null,
        activeConversation: null,
        messages: [],
        seenMessageIds: new Set(),
        oldestId: null,
        hasMore: false,
        selectedMembers: new Map(),
        searchTimers: new Map(),
        pollers: [],
        loadingMessages: false
    };

    const ui = {
        landing: $('#landing'),
        auth: $('#auth-section'),
        chat: $('#chat-app'),
        loginForm: $('#login-form'),
        registerForm: $('#register-form'),
        toastRegion: $('#toast-region'),
        conversationList: $('#conversation-list'),
        searchInput: $('#user-search'),
        searchResults: $('#search-results'),
        messageList: $('#message-list'),
        messageArea: $('#message-area'),
        messageInput: $('#message-input'),
        messageForm: $('#message-form'),
        charCount: $('#char-count'),
        profileModal: $('#profile-modal'),
        groupModal: $('#group-modal'),
        detailsModal: $('#details-modal')
    };

    function toast(message, type = 'info') {
        const existing = Array.from(ui.toastRegion.children)
            .find(element => element.textContent === message);
        if (existing) {
            window.clearTimeout(existing.dismissTimer);
            existing.dismissTimer = window.setTimeout(() => existing.remove(), 4000);
            return;
        }
        const element = document.createElement('div');
        element.className = `toast ${type}`;
        element.textContent = message;
        ui.toastRegion.append(element);
        element.dismissTimer = window.setTimeout(() => element.remove(), 4000);
    }

    async function api(action, options = {}) {
        return window.GatherData.request(action, options);
    }

    function showLanding() {
        stopPolling();
        state.conversations = [];
        state.activeId = null;
        state.activeConversation = null;
        state.messages = [];
        state.seenMessageIds.clear();
        state.oldestId = null;
        state.hasMore = false;
        ui.messageList.replaceChildren();
        ui.messageInput.value = '';
        $('#conversation-view').classList.add('is-hidden');
        $('#chat-empty').classList.remove('is-hidden');
        ui.chat.classList.remove('mobile-open');
        ui.conversationList.replaceChildren();
        ui.searchResults.replaceChildren();
        ui.searchResults.classList.add('is-hidden');
        ui.searchInput.value = '';
        ui.chat.classList.add('is-hidden');
        ui.landing.classList.remove('is-hidden');
        $('#about').classList.remove('is-hidden');
        $('#auth-section').classList.add('is-hidden');
        $('.site-footer').classList.remove('is-hidden');
        $('.nav-signin').classList.remove('is-hidden');
        $('.nav-register').classList.remove('is-hidden');
        $('.site-nav > a').classList.remove('is-hidden');
        document.body.classList.remove('in-chat');
    }

    function showAuth(mode = 'login') {
        ui.landing.classList.add('is-hidden');
        $('#about').classList.add('is-hidden');
        ui.auth.classList.remove('is-hidden');
        ui.chat.classList.add('is-hidden');
        $('.site-footer').classList.remove('is-hidden');
        setAuthMode(mode);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function setAuthMode(mode) {
        const registering = mode === 'register';
        ui.loginForm.classList.toggle('is-hidden', registering);
        ui.registerForm.classList.toggle('is-hidden', !registering);
        $('#auth-kicker').textContent = registering ? 'A GOOD PLACE TO BEGIN' : 'WELCOME BACK';
        $('#auth-title').textContent = registering ? 'Make yourself at home.' : 'Sign in to your space.';
        $('#auth-subtitle').textContent = registering
            ? 'A username, a name, and you’re in.'
            : 'Pick up right where the conversation left off.';
        $('#auth-switch').innerHTML = registering
            ? 'Already have an account? <button type="button" data-open-auth="login">Sign in</button>'
            : 'New to Gather? <button type="button" data-open-auth="register">Create an account</button>';
    }

    function showChat(user) {
        state.user = user;
        ui.landing.classList.add('is-hidden');
        $('#about').classList.add('is-hidden');
        ui.auth.classList.add('is-hidden');
        ui.chat.classList.remove('is-hidden');
        $('.site-footer').classList.add('is-hidden');
        $('.nav-signin').classList.add('is-hidden');
        $('.nav-register').classList.add('is-hidden');
        $('.site-nav > a').classList.add('is-hidden');
        $('#my-display-name').textContent = user.display_name;
        $('#my-username').textContent = `@${user.username}`;
        setAvatar($('#my-avatar'), user.avatar_url, initials(user.display_name));
        ui.messageInput.disabled = false;
        updateMessageNotice();
        document.body.classList.add('in-chat');
        api('presence.update').catch(err => console.warn('Presence update error:', err));
        refreshConversations().catch(showError);
        startPolling();
    }

    function showError(error) {
        toast(error.message || 'Something went wrong. Please try again.', 'error');
    }

    function initials(value) {
        const parts = String(value || '?').trim().split(/\s+/).filter(Boolean);
        return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
    }

    function setAvatar(element, url, fallback) {
        element.replaceChildren();
        element.classList.toggle('has-image', Boolean(url));
        if (!url) {
            element.textContent = fallback;
            return;
        }
        const image = new Image();
        image.alt = '';
        image.decoding = 'async';
        image.addEventListener('error', () => {
            element.classList.remove('has-image');
            image.remove();
            element.textContent = fallback;
        }, { once: true });
        image.src = url;
        element.append(image);
    }

    function safeTime(value) {
        if (!value) return '';
        const date = new Date(String(value).replace(' ', 'T'));
        if (Number.isNaN(date.getTime())) return '';
        const today = new Date();
        if (date.toDateString() === today.toDateString()) {
            return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function updateTheme() {
        const isDark = document.documentElement.dataset.theme === 'dark';
        document.querySelectorAll('.theme-toggle').forEach(button => {
            button.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
            button.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
            button.textContent = isDark ? '☼' : '◐';
        });
        document.querySelector('meta[name="theme-color"]').content = isDark ? '#1c211e' : '#f5f4f0';
    }

    function toggleTheme() {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        if (next === 'dark') document.documentElement.dataset.theme = 'dark';
        else delete document.documentElement.dataset.theme;
        try {
            localStorage.setItem('gather-theme', next);
        } catch (error) {
            toast('Your browser did not allow saving the theme preference.', 'error');
        }
        updateTheme();
    }

    function renderConversations() {
        ui.conversationList.replaceChildren();
        if (!state.conversations.length) {
            const empty = document.createElement('div');
            empty.className = 'list-empty';
            empty.textContent = 'Your inbox is a blank page. Search for someone to say hello.';
            ui.conversationList.append(empty);
            return;
        }
        state.conversations.forEach(conversation => {
            const button = document.createElement('button');
            button.className = `conversation-row${conversation.id === state.activeId ? ' active' : ''}`;
            button.type = 'button';
            button.addEventListener('click', () => openConversation(conversation.id));
            const avatar = document.createElement('span');
            avatar.className = 'avatar';
            setAvatar(avatar, conversation.avatar_url, initials(conversation.title || 'G'));
            const meta = document.createElement('span');
            meta.className = 'conversation-meta';
            const top = document.createElement('span');
            top.className = 'conversation-meta-top';
            const name = document.createElement('b');
            name.textContent = conversation.title || 'Conversation';
            const time = document.createElement('time');
            time.textContent = safeTime(conversation.latest_at);
            top.append(name, time);
            const bottom = document.createElement('span');
            bottom.className = 'conversation-meta-bottom';
            const preview = document.createElement('span');
            preview.className = 'conversation-preview';
            preview.textContent = conversation.latest_sender_id === state.user.id ? 'You: ' : '';
            preview.textContent += conversation.latest_message || 'Start a conversation';
            bottom.append(preview);
            if (conversation.unread_count > 0) {
                const badge = document.createElement('span');
                badge.className = 'unread-badge';
                badge.textContent = conversation.unread_count > 99 ? '99+' : String(conversation.unread_count);
                bottom.append(badge);
            }
            meta.append(top, bottom);
            button.append(avatar, meta);
            ui.conversationList.append(button);
        });
    }

    async function refreshConversations() {
        const result = await api('conversations');
        state.conversations = result.conversations || [];
        renderConversations();
    }

    function displayStatus(conversation) {
        if (conversation.type === 'group') {
            const count = state.activeConversation?.members?.length || 0;
            return count ? `${count} people` : 'Group conversation';
        }
        if (conversation.online) return 'Online now';
        if (conversation.last_seen_at) return `Last seen ${safeTime(conversation.last_seen_at)}`;
        return `@${conversation.username || ''}`;
    }

    async function openConversation(id) {
        state.activeId = String(id);
        state.activeConversation = state.conversations.find(item => item.id === state.activeId) || null;
        state.messages = [];
        state.seenMessageIds.clear();
        state.oldestId = null;
        state.hasMore = false;
        ui.messageList.replaceChildren();
        $('#chat-empty').classList.add('is-hidden');
        $('#conversation-view').classList.remove('is-hidden');
        ui.chat.classList.add('mobile-open');
        renderConversations();
        ui.messageInput.focus({ preventScroll: true });
        if (state.activeConversation) {
            $('#conversation-title').textContent = state.activeConversation.title || 'Conversation';
            $('#conversation-subtitle').textContent = state.activeConversation.type === 'private'
                ? `@${state.activeConversation.username || ''}`
                : 'Group conversation';
            setAvatar($('#peer-avatar'), state.activeConversation.avatar_url, initials(state.activeConversation.title || 'G'));
        }
        try {
            const [details, result] = await Promise.all([
                api('conversations.details', { query: { id: state.activeId } }),
                api('messages', { query: { conversation_id: state.activeId } })
            ]);
            if (state.activeId !== String(id)) return;
            state.activeConversation = { ...state.activeConversation, ...details.conversation };
            const peer = state.activeConversation.type === 'private'
                ? details.conversation.members.find(member => member.id !== state.user.id)
                : null;
            if (peer) {
                state.activeConversation.title = peer.display_name;
                state.activeConversation.username = peer.username;
                state.activeConversation.other_user_id = peer.id;
                state.activeConversation.online = peer.online;
                state.activeConversation.last_seen_at = peer.last_seen_at;
                state.activeConversation.avatar_url = peer.avatar_url;
            }
            $('#conversation-title').textContent = state.activeConversation.title || 'Conversation';
            $('#conversation-subtitle').textContent = displayStatus(state.activeConversation);
            setAvatar($('#peer-avatar'), state.activeConversation.avatar_url, initials(state.activeConversation.title || 'G'));
            updateMessageNotice();
            state.messages = result.messages || [];
            state.messages.forEach(message => state.seenMessageIds.add(message.id));
            state.oldestId = result.oldest_id;
            state.hasMore = Boolean(result.has_more);
            $('#load-older').classList.toggle('is-hidden', !state.hasMore);
            renderMessages();
            if (result.messages.length) await markRead(result.messages[result.messages.length - 1].id);
            if (window.matchMedia('(max-width: 620px)').matches) {
                ui.chat.classList.add('mobile-open');
            }
        } catch (error) {
            showError(error);
        }
    }

    function renderMessages(keepScroll = false) {
        const previousHeight = ui.messageArea.scrollHeight;
        const previousTop = ui.messageArea.scrollTop;
        ui.messageList.replaceChildren();
        let dayKey = '';
        state.messages.forEach(message => {
            const date = new Date(String(message.created_at).replace(' ', 'T'));
            const newDayKey = Number.isNaN(date.getTime()) ? '' : date.toDateString();
            if (newDayKey && newDayKey !== dayKey) {
                const day = document.createElement('div');
                day.className = 'message-day';
                day.textContent = date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
                ui.messageList.append(day);
                dayKey = newDayKey;
            }
            const row = document.createElement('article');
            const mine = message.sender_id === state.user.id;
            row.className = `message-row${mine ? ' mine' : ''}`;
            if (!mine && state.activeConversation?.type === 'group') {
                const author = document.createElement('span');
                author.className = 'message-author';
                author.textContent = message.sender_name;
                row.append(author);
            }
            const bubble = document.createElement('div');
            bubble.className = `message-bubble${message.is_deleted ? ' deleted' : ''}`;
            if (message.is_deleted) {
                bubble.textContent = 'Message deleted';
            } else if (message.message_type === 'encrypted') {
                bubble.textContent = 'This message was sent before encryption was removed and cannot be displayed in regular chat.';
                bubble.classList.add('is-legacy');
            } else {
                bubble.textContent = message.body;
            }
            row.append(bubble);
            const details = document.createElement('div');
            details.className = 'message-details';
            details.textContent = `${safeTime(message.created_at)}${message.edited_at ? ' · edited' : ''}${mine ? (message.is_read ? ' · read' : ' · sent') : ''}`;
            if (mine && !message.is_deleted) {
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'message-action';
                edit.textContent = 'Edit';
                edit.setAttribute('aria-label', 'Edit message');
                edit.addEventListener('click', () => editMessage(message));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'message-action';
                remove.textContent = 'Delete';
                remove.setAttribute('aria-label', 'Delete message for everyone');
                remove.addEventListener('click', () => deleteMessage(message));
                details.append(edit, remove);
            }
            row.append(details);
            ui.messageList.append(row);
        });
        if (keepScroll) {
            ui.messageArea.scrollTop = ui.messageArea.scrollHeight - previousHeight + previousTop;
        } else {
            ui.messageArea.scrollTop = ui.messageArea.scrollHeight;
        }
    }

    async function markRead(throughId) {
        if (!isConversationVisible()) return;
        try {
            await api('messages.read', {
                method: 'POST',
                body: { conversation_id: state.activeId, through_id: throughId }
            });
        } catch (error) {
            console.warn('markRead failed:', error);
        }
    }

    async function pollMessages() {
        if (!isConversationVisible() || state.loadingMessages) return;
        state.loadingMessages = true;
        const conversationId = state.activeId;
        try {
            const lastId = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
            const result = await api('messages', {
                query: { conversation_id: conversationId, after_id: lastId }
            });
            if (state.activeId !== conversationId) return;
            let added = false;
            (result.messages || []).forEach(message => {
                if (!state.seenMessageIds.has(message.id)) {
                    state.seenMessageIds.add(message.id);
                    state.messages.push(message);
                    added = true;
                }
            });
            if (added) {
                renderMessages();
                await markRead(state.messages[state.messages.length - 1].id);
                refreshConversations().catch(() => {});
            }
        } catch (error) {
            console.warn('pollMessages failed:', error);
        } finally {
            state.loadingMessages = false;
        }
    }

    async function loadOlder() {
        if (!state.activeId || !state.oldestId || !state.hasMore) return;
        const button = $('#load-older');
        button.disabled = true;
        try {
            const result = await api('messages', {
                query: { conversation_id: state.activeId, before_id: state.oldestId }
            });
            if (result.messages.length) {
                const newMessages = result.messages.filter(message => !state.seenMessageIds.has(message.id));
                newMessages.forEach(message => state.seenMessageIds.add(message.id));
                state.messages = [...newMessages, ...state.messages];
                state.oldestId = result.oldest_id;
                state.hasMore = result.has_more;
                renderMessages(true);
            } else {
                state.hasMore = false;
            }
            button.classList.toggle('is-hidden', !state.hasMore);
        } catch (error) {
            showError(error);
        } finally {
            button.disabled = false;
        }
    }

    async function sendMessage(event) {
        event.preventDefault();
        const body = ui.messageInput.value.trim();
        if (!body || !state.activeId) return;
        const submit = $('button[type="submit"]', ui.messageForm);
        submit.disabled = true;
        try {
            const result = await api('messages.send', {
                method: 'POST',
                body: {
                    conversation_id: state.activeId,
                    body
                }
            });
            if (state.activeId === result.message.conversation_id && !state.seenMessageIds.has(result.message.id)) {
                state.seenMessageIds.add(result.message.id);
                state.messages.push(result.message);
                renderMessages();
            }
            ui.messageInput.value = '';
            updateCharCount();
            await refreshConversations();
        } catch (error) {
            showError(error);
        } finally {
            submit.disabled = false;
            ui.messageInput.focus();
        }
    }

    async function editMessage(message) {
        if (message.message_type === 'encrypted') {
            toast('Older encrypted messages cannot be edited in regular chat.', 'error');
            return;
        }
        const body = window.prompt('Edit your message (available for 15 minutes):', message.body);
        if (body === null || !body.trim()) return;
        try {
            const result = await api('messages.edit', {
                method: 'POST',
                body: {
                    conversation_id: state.activeId,
                    message_id: message.id,
                    body: body.trim()
                }
            });
            state.messages = state.messages.map(item => item.id === message.id ? result.message : item);
            renderMessages(true);
        } catch (error) {
            showError(error);
        }
    }

    async function deleteMessage(message) {
        if (!window.confirm('Delete this message for everyone in the conversation? The message will be replaced with a deletion notice.')) return;
        try {
            await api('messages.delete', {
                method: 'POST',
                body: { conversation_id: state.activeId, message_id: message.id }
            });
            state.messages = state.messages.map(item => item.id === message.id
                ? { ...item, body: '', is_deleted: true }
                : item);
            renderMessages(true);
            refreshConversations().catch(() => {});
        } catch (error) {
            showError(error);
        }
    }

    function updateCharCount() {
        const length = ui.messageInput.value.length;
        ui.charCount.textContent = length ? `${length}/5000` : '';
        ui.messageInput.style.height = 'auto';
        ui.messageInput.style.height = `${Math.min(ui.messageInput.scrollHeight, 100)}px`;
    }

    function startPolling() {
        stopPolling();
        state.pollers.push(window.setInterval(() => {
            if (!document.hidden) pollMessages();
        }, 2500));
        state.pollers.push(window.setInterval(() => {
            if (!document.hidden && state.user) refreshConversations().catch(() => {});
        }, 15000));
        state.pollers.push(window.setInterval(() => {
            if (!document.hidden && state.user) api('presence.update').catch(err => console.warn('Presence update error:', err));
        }, 60000));
    }

    function isConversationVisible() {
        return Boolean(state.activeId && !document.hidden
            && !$('#conversation-view').classList.contains('is-hidden')
            && (!window.matchMedia('(max-width: 620px)').matches || ui.chat.classList.contains('mobile-open')));
    }

    function stopPolling() {
        state.pollers.forEach(window.clearInterval);
        state.pollers = [];
    }

    async function searchUsers(term, target, onPick) {
        if (term.trim().length < 2) {
            target.replaceChildren();
            return;
        }
        try {
            const result = await api('users.search', { query: { q: term.trim() } });
            target.replaceChildren();
            if (!result.users.length) {
                const empty = document.createElement('div');
                empty.className = 'search-result-empty';
                empty.textContent = 'No people found. Try another name.';
                target.append(empty);
                return;
            }
            result.users.forEach(user => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'search-result';
                const avatar = document.createElement('span');
                avatar.className = 'avatar';
                setAvatar(avatar, user.avatar_url, initials(user.display_name));
                const copy = document.createElement('span');
                const name = document.createElement('b');
                name.textContent = user.display_name;
                const username = document.createElement('small');
                username.textContent = `@${user.username}`;
                copy.append(name, username);
                button.append(avatar, copy);
                button.addEventListener('click', () => onPick(user));
                target.append(button);
            });
        } catch (error) {
            showError(error);
        }
    }

    function debounceSearch(input, target, onPick, key) {
        input.addEventListener('input', () => {
            window.clearTimeout(state.searchTimers.get(key));
            const term = input.value;
            if (key === 'main') ui.searchResults.classList.toggle('is-hidden', term.trim().length < 2);
            const timer = window.setTimeout(() => searchUsers(term, target, onPick), 280);
            state.searchTimers.set(key, timer);
        });
    }

    async function startDirect(user) {
        try {
            const result = await api('conversations.direct', {
                method: 'POST',
                body: { user_id: user.id }
            });
            ui.searchResults.classList.add('is-hidden');
            ui.searchInput.value = '';
            await refreshConversations();
            await openConversation(result.conversation_id);
        } catch (error) {
            showError(error);
        }
    }

    function updateMessageNotice() {
        const notice = $('#message-notice');
        const submit = $('button[type="submit"]', ui.messageForm);
        const canSend = Boolean(state.activeId && state.activeConversation);
        notice.textContent = canSend
            ? 'Messages are stored as regular text in Firebase.'
            : 'Select a conversation to send a message.';
        notice.classList.toggle('is-blocked', !canSend);
        submit.disabled = !canSend;
    }

    function showProfile() {
        $('#profile-username').value = state.user.username;
        $('#profile-display-name').value = state.user.display_name;
        $('#profile-bio').value = state.user.bio || '';
        $('#profile-last-seen').checked = Boolean(state.user.show_last_seen);
        setAvatar($('#profile-avatar-preview'), state.user.avatar_url, initials(state.user.display_name));
        $('#avatar-file').value = '';
        $('#avatar-remove').classList.toggle('is-hidden', !state.user.avatar_url);
        ui.profileModal.showModal();
    }

    function updateOwnAvatar() {
        setAvatar($('#my-avatar'), state.user.avatar_url, initials(state.user.display_name));
        setAvatar($('#profile-avatar-preview'), state.user.avatar_url, initials(state.user.display_name));
        $('#avatar-remove').classList.toggle('is-hidden', !state.user.avatar_url);
    }

    async function uploadAvatar() {
        const input = $('#avatar-file');
        if (!input.files || !input.files.length) {
            toast('Choose a photo first.', 'error');
            return;
        }
        const formData = new FormData();
        formData.append('avatar', input.files[0]);
        try {
            const result = await api('profile.avatar-upload', { method: 'POST', body: formData });
            state.user = result.user;
            updateOwnAvatar();
            input.value = '';
            await refreshConversations();
            toast('Your profile photo has been updated.', 'success');
        } catch (error) {
            showError(error);
        }
    }

    async function removeAvatar() {
        try {
            const result = await api('profile.avatar-remove', { method: 'POST' });
            state.user = result.user;
            updateOwnAvatar();
            await refreshConversations();
            toast('Your profile photo has been removed.', 'success');
        } catch (error) {
            showError(error);
        }
    }

    async function saveProfile(event) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
            const result = await api('profile.update', {
                method: 'POST',
                body: {
                    display_name: form.get('display_name'),
                    bio: form.get('bio'),
                    show_last_seen: form.has('show_last_seen')
                }
            });
            state.user = result.user;
            $('#my-display-name').textContent = state.user.display_name;
            updateOwnAvatar();
            ui.profileModal.close();
            toast('Your profile is up to date.', 'success');
            await refreshConversations();
        } catch (error) {
            showError(error);
        }
    }

    async function changePassword(event) {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        try {
            await window.GatherFirebaseAuth.changePassword(
                state.user.username,
                form.get('current_password'),
                form.get('new_password')
            );
            await window.GatherFirebaseAuth.signOut();
            formElement.reset();
            state.user = null;
            state.activeId = null;
            stopPolling();
            showLanding();
            toast('Password updated. Sign in again with your new password.', 'success');
        } catch (error) {
            showError(error);
        }
    }

    async function createGroup(event) {
        event.preventDefault();
        if (!state.selectedMembers.size) {
            toast('Choose at least one person for your group.', 'error');
            return;
        }
        try {
            const result = await api('conversations.create-group', {
                method: 'POST',
                body: {
                    title: $('#group-title').value.trim(),
                    user_ids: Array.from(state.selectedMembers.keys())
                }
            });
            ui.groupModal.close();
            $('#group-form').reset();
            state.selectedMembers.clear();
            $('#group-selected').replaceChildren();
            $('#group-search-results').replaceChildren();
            await refreshConversations();
            await openConversation(result.conversation_id);
        } catch (error) {
            showError(error);
        }
    }

    function renderSelectedMembers() {
        const selected = $('#group-selected');
        selected.replaceChildren();
        state.selectedMembers.forEach(user => {
            const chip = document.createElement('span');
            chip.className = 'selected-chip';
            chip.append(document.createTextNode(user.display_name));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Remove ${user.display_name}`);
            remove.addEventListener('click', () => {
                state.selectedMembers.delete(user.id);
                renderSelectedMembers();
            });
            chip.append(remove);
            selected.append(chip);
        });
    }

    async function showDetails() {
        if (!state.activeId) return;
        try {
            const result = await api('conversations.details', { query: { id: state.activeId } });
            const conversation = result.conversation;
            $('#details-title').textContent = conversation.type === 'group' ? conversation.title : 'People here.';
            const list = $('#details-members');
            list.replaceChildren();
            state.activeConversation = { ...state.activeConversation, members: conversation.members };
            for (const member of conversation.members) {
                const row = document.createElement('div');
                row.className = 'detail-member';
                const avatar = document.createElement('span');
                avatar.className = 'avatar';
                setAvatar(avatar, member.avatar_url, initials(member.display_name));
                const copy = document.createElement('span');
                copy.className = 'detail-member-copy';
                const name = document.createElement('b');
                name.textContent = member.display_name;
                const username = document.createElement('small');
                username.textContent = `@${member.username}`;
                copy.append(name, username);
                const role = document.createElement('span');
                role.textContent = member.id === state.user.id ? 'You' : member.role;
                row.append(avatar, copy, role);
                if (conversation.type === 'group' && conversation.role === 'admin'
                    && member.id !== state.user.id && member.role !== 'admin') {
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'message-action';
                    remove.textContent = 'Remove';
                    remove.addEventListener('click', async () => {
                        if (!window.confirm(`Remove ${member.display_name} from this group?`)) return;
                        try {
                            await api('groups.remove-member', {
                                method: 'POST',
                                body: { conversation_id: state.activeId, user_id: member.id }
                            });
                            await showDetails();
                        } catch (error) {
                            showError(error);
                        }
                    });
                    row.append(remove);
                }
                list.append(row);
            }
            const groupAdd = $('#group-add-area');
            const block = $('#block-user');
            groupAdd.classList.toggle('is-hidden', conversation.type !== 'group' || conversation.role !== 'admin');
            block.classList.toggle('is-hidden', conversation.type !== 'private');
            updateMessageNotice();
            if (!ui.detailsModal.open) ui.detailsModal.showModal();
        } catch (error) {
            showError(error);
        }
    }

    async function addGroupMember(user) {
        try {
            await api('groups.add-member', {
                method: 'POST',
                body: { conversation_id: state.activeId, user_id: user.id }
            });
            $('#member-search').value = '';
            $('#member-search-results').replaceChildren();
            toast(`${user.display_name} joined the group.`, 'success');
            await showDetails();
        } catch (error) {
            showError(error);
        }
    }

    async function blockCurrentUser() {
        const userId = state.activeConversation?.other_user_id;
        if (!userId || !window.confirm('Block this person? You will no longer be able to send messages in this conversation.')) return;
        try {
            await api('blocks.add', { method: 'POST', body: { user_id: userId } });
            ui.detailsModal.close();
            toast('This person is blocked.', 'success');
        } catch (error) {
            showError(error);
        }
    }

    async function logout() {
        let failure = null;
        try {
            await api('presence.update');
        } catch (error) {
            failure = error;
        }
        try {
            await window.GatherFirebaseAuth.signOut();
        } catch (error) {
            if (!failure) failure = error;
        }
        try {
        } catch (error) {
            if (!failure) failure = error;
        }
        state.user = null;
        state.activeId = null;
        stopPolling();
        showLanding();
        if (failure) return showError(failure);
        toast('You have signed out.', 'success');
    }

    function bindEvents() {
        document.addEventListener('click', event => {
            const authButton = event.target.closest('[data-open-auth]');
            if (authButton) showAuth(authButton.dataset.openAuth);
            const privacyLink = event.target.closest('a[href="#privacy"]');
            if (privacyLink) {
                event.preventDefault();
                showLanding();
                $('#privacy').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
        $$('.theme-toggle').forEach(button => button.addEventListener('click', toggleTheme));
        $('#auth-back').addEventListener('click', showLanding);
        $('#login-form').addEventListener('submit', async event => {
            event.preventDefault();
            if (state.authBusy) return;
            state.authBusy = true;
            const formElement = event.currentTarget;
            const submit = $('button[type="submit"]', formElement);
            submit.disabled = true;
            const form = new FormData(formElement);
            try {
                await window.GatherFirebaseAuth.signIn(form.get('username'), form.get('password'));
                const result = await api('bootstrap');
                if (!result.user) {
                    throw new Error('No Gather profile exists for this account. Create a new account or check that you used the correct username.');
                }
                formElement.reset();
                showChat(result.user);
            } catch (error) {
                showError(error);
            } finally {
                state.authBusy = false;
                submit.disabled = false;
            }
        });
        $('#register-form').addEventListener('submit', async event => {
            event.preventDefault();
            if (state.authBusy) return;
            state.authBusy = true;
            const formElement = event.currentTarget;
            const submit = $('button[type="submit"]', formElement);
            submit.disabled = true;
            const form = new FormData(formElement);
            try {
                if (form.get('password') !== form.get('confirm_password')) {
                    throw new Error('The passwords do not match.');
                }
                await window.GatherFirebaseAuth.register(form.get('username'), form.get('password'));
                const result = await api('register', {
                    method: 'POST',
                    body: {
                        username: form.get('username'),
                        display_name: form.get('display_name')
                    }
                });
                formElement.reset();
                showChat(result.user);
            } catch (error) {
                showError(error);
            } finally {
                state.authBusy = false;
                submit.disabled = false;
            }
        });
        $('#profile-open').addEventListener('click', showProfile);
        $('#settings-open').addEventListener('click', showProfile);
        $('#avatar-upload').addEventListener('click', uploadAvatar);
        $('#avatar-remove').addEventListener('click', removeAvatar);
        $('#logout-button').addEventListener('click', logout);
        $('#profile-form').addEventListener('submit', saveProfile);
        $('#password-form').addEventListener('submit', changePassword);
        $('#group-form').addEventListener('submit', createGroup);
        $('#new-group-open').addEventListener('click', () => {
            state.selectedMembers.clear();
            renderSelectedMembers();
            $('#group-modal').showModal();
            $('#group-title').focus();
        });
        $('#message-form').addEventListener('submit', sendMessage);
        ui.messageInput.addEventListener('input', updateCharCount);
        ui.messageInput.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                ui.messageForm.requestSubmit();
            }
        });
        $('#load-older').addEventListener('click', loadOlder);
        $('#mobile-back').addEventListener('click', () => ui.chat.classList.remove('mobile-open'));
        $('#conversation-info').addEventListener('click', showDetails);
        $('#block-user').addEventListener('click', blockCurrentUser);
        $('#empty-search-focus').addEventListener('click', () => {
            ui.searchInput.focus();
            ui.searchInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        debounceSearch(ui.searchInput, ui.searchResults, startDirect, 'main');
        debounceSearch($('#group-search'), $('#group-search-results'), user => {
            if (state.selectedMembers.has(user.id)) return;
            state.selectedMembers.set(user.id, user);
            renderSelectedMembers();
            $('#group-search-results').replaceChildren();
            $('#group-search').value = '';
        }, 'group');
        debounceSearch($('#member-search'), $('#member-search-results'), addGroupMember, 'member');
        $('#user-search').addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                ui.searchResults.classList.add('is-hidden');
                ui.searchInput.value = '';
            }
        });
        document.addEventListener('keydown', event => {
            if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
                && state.user && !ui.chat.classList.contains('is-hidden')) {
                event.preventDefault();
                ui.searchInput.focus();
            }
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.user) {
                api('presence.update').catch(err => console.warn('Presence update error:', err));
                refreshConversations().catch(() => {});
                if (isConversationVisible() && state.messages.length) {
                    markRead(state.messages[state.messages.length - 1].id);
                }
                pollMessages();
            }
        });
        window.addEventListener('beforeunload', stopPolling);
    }

    async function initialize() {
        bindEvents();
        updateTheme();
        try {
            await window.GatherFirebaseAuth.ready;
            const result = await api('bootstrap');
            if (result.user) {
                showChat(result.user);
            } else if (window.GatherFirebaseAuth.currentUser()) {
                toast('No Gather profile exists for this Firebase account. Sign in with the correct username or create a new account.', 'error');
            }
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    initialize();
})();
