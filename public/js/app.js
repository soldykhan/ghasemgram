'use strict';

/* ═══════════════ ماژول اصلی برنامه قاسم‌گرام (Main Application Entry Point) ═══════════════ */

/* ═══════════════ صفحه ورود / ثبت‌نام ═══════════════ */

function showAuthError(msg) {
  const el = $('#auth-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
const hideAuthError = () => $('#auth-error')?.classList.add('hidden');

function switchTab(which) {
  $('#tab-login')?.classList.toggle('active', which === 'login');
  $('#tab-register')?.classList.toggle('active', which === 'register');
  $('#login-form')?.classList.toggle('hidden', which !== 'login');
  $('#register-form')?.classList.toggle('hidden', which !== 'register');
  hideAuthError();
}

function bindAvatarPicker(wrapEl, inputEl, previewEl, onFile) {
  wrapEl.addEventListener('click', () => inputEl.click());
  inputEl.addEventListener('change', () => {
    const f = inputEl.files[0];
    if (!f) return;
    previewEl.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
    onFile(f);
    inputEl.value = '';
  });
}

function bindAuth() {
  $('#tab-login')?.addEventListener('click', () => switchTab('login'));
  $('#tab-register')?.addEventListener('click', () => switchTab('register'));

  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();
    const btn = e.target.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: {
          username: $('#login-username').value.trim(),
          password: $('#login-password').value,
        },
      });
      state.token = r.token;
      localStorage.setItem('gg_token', r.token);
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  let regAvatar = null;
  const regWrap = $('#reg-avatar-wrap');
  const regInp = $('#reg-avatar-input');
  const regPrev = $('#reg-avatar-preview');
  if (regWrap && regInp && regPrev) {
    bindAvatarPicker(regWrap, regInp, regPrev, (f) => (regAvatar = f));
  }

  $('#register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();
    const btn = e.target.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const fd = new FormData();
      fd.set('username', $('#reg-username').value.trim());
      fd.set('password', $('#reg-password').value);
      fd.set('display_name', $('#reg-display').value.trim());
      if (regAvatar) fd.set('avatar', regAvatar);

      const r = await api('/auth/register', { method: 'POST', formData: fd });
      state.token = r.token;
      localStorage.setItem('gg_token', r.token);
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

/* ═══════════════ ورود به اپلیکیشن ═══════════════ */

async function enterApp() {
  $('#auth-screen')?.classList.add('hidden');
  $('#app-screen')?.classList.remove('hidden');
  state.me = await api('/me');
  applyTheme(state.theme);
  applyWallpaper(state.wallpaper);
  renderProfileChip();
  renderSettingsDrawer();
  updateApprovalState();
  connectSocket();
  await loadChats();
}

function renderProfileChip() {
  const chip = $('#profile-chip');
  if (!chip || !state.me) return;
  chip.innerHTML = `
    ${avatarHTML(state.me, 'small')}
    <div class="pc-main">
      <div class="pc-name">${esc(state.me.display_name)}</div>
      <div class="pc-uname">@${esc(state.me.username)}</div>
    </div>`;
  chip.onclick = (e) => {
    e.stopPropagation();
    openSettingsDrawer();
  };
}

/* ═══════════════ سوکت و رویدادهای زنده (WebSocket) ═══════════════ */

function connectSocket() {
  if (state.socket) {
    state.socket.io.opts.auth = { token: state.token };
    state.socket.connect();
    if (typeof window.initCallSignaling === 'function') {
      window.initCallSignaling(state.socket);
    }
    return;
  }
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  if (typeof window.initCallSignaling === 'function') {
    window.initCallSignaling(socket);
  }

  socket.on('message', onIncomingMessage);

  socket.on('user-status-changed', async (data) => {
    if (state.me) {
      if (data.status) state.me.status = data.status;
      if (data.category_id) state.me.category_id = data.category_id;
      if (data.is_special !== undefined) state.me.is_special = data.is_special;
    }
    updateApprovalState();
    if (data.status === 'approved') {
      showToast('🎉 حساب کاربری شما توسط ادمین تایید شد! هم‌اکنون می‌توانید شروع به گفتگو کنید.');
      await loadChats();
    }
  });

  socket.on('user-category-changed', async ({ category_id }) => {
    if (state.me) state.me.category_id = category_id;
    await loadChats();
    if (state.activeChatId) {
      const c = state.chats.get(state.activeChatId);
      if (c) {
        updateComposerForChat(c);
        renderChatHeader(c);
      } else {
        closeChatView();
      }
    }
    showToast('دسته‌بندی شما توسط مدیر تغییر یافت.');
  });

  socket.on('session-terminated', ({ reason }) => {
    state.token = null;
    localStorage.removeItem('gg_token');
    alert(reason || 'نشست شما پایان یافته است.');
    window.location.reload();
  });

  socket.on('message-edited', ({ chat_id, message }) => {
    const store = state.messagesByChat.get(chat_id);
    if (store) {
      const i = store.findIndex((m) => m.id === message.id);
      if (i >= 0) store[i] = message;
    }
    const c = state.chats.get(chat_id);
    if (c && c.last_message && c.last_message.id === message.id) {
      c.last_message.text = message.text;
      renderSidebar();
    }
    if (Number(state.activeChatId) === Number(chat_id)) {
      const el = $('#messages');
      renderMessages(chat_id, { preserveScroll: el ? el.scrollTop : null });
    }
  });

  socket.on('chat-pin-message', ({ chat_id, pinned_message }) => {
    const c = state.chats.get(chat_id);
    if (c) {
      c.pinned_message = pinned_message;
    }
    if (Number(state.activeChatId) === Number(chat_id)) {
      renderPinnedBar(c);
    }
  });

  socket.on('poll-updated', ({ poll }) => {
    updatePollInStore(poll);
  });

  socket.on('topic-created', ({ chat_id, topic }) => {
    if (Number(state.activeChatId) === Number(chat_id)) {
      loadTopics(chat_id);
    }
  });

  socket.on('chat', (chat) => {
    if (!chat) return;
    state.chats.set(chat.id, chat);
    const peerR = Math.max(
      Number(chat.max_peer_read_id || 0),
      Number(chat.peer ? chat.peer.last_read_id : 0)
    );
    state.peerReads.set(chat.id, Math.max(state.peerReads.get(chat.id) || 0, peerR));
    if (!chat.last_message && state.messagesByChat.has(chat.id)) {
      state.messagesByChat.delete(chat.id);
      if (Number(state.activeChatId) === Number(chat.id)) renderMessages(chat.id);
    }
    renderSidebar();
  });

  socket.on('chat-removed', ({ chat_id }) => {
    state.chats.delete(chat_id);
    state.messagesByChat.delete(chat_id);
    if (Number(state.activeChatId) === Number(chat_id)) closeChatView();
    if (Number(state.infoChatId) === Number(chat_id)) closeInfoPane();
    renderSidebar();
  });

  socket.on('message-deleted', ({ chat_id, message_id }) => {
    const store = state.messagesByChat.get(chat_id);
    if (store) {
      const i = store.findIndex((m) => m.id === message_id);
      if (i >= 0) store.splice(i, 1);
    }
    if (Number(state.activeChatId) === Number(chat_id)) {
      const el = $('#messages');
      renderMessages(chat_id, { preserveScroll: el ? el.scrollTop : null });
    }
  });

  socket.on('read', ({ chat_id, user_id, last_read_id }) => {
    const cid = Number(chat_id);
    const uid = Number(user_id);
    const lrid = Number(last_read_id);
    if (uid === Number(state.me?.id)) return;

    const currentRead = state.peerReads.get(cid) || 0;
    const newRead = Math.max(currentRead, lrid);
    state.peerReads.set(cid, newRead);

    const c = state.chats.get(cid);
    if (c) {
      if (c.peer && Number(c.peer.id) === uid) {
        c.peer.last_read_id = Math.max(Number(c.peer.last_read_id || 0), lrid);
      }
      c.max_peer_read_id = newRead;
    }

    if (Number(state.activeChatId) === Number(cid)) {
      updateReadTicksInDOM(cid, newRead);
    }
  });

  socket.on('presence', ({ user_id, online, last_seen_at }) => {
    if (online) state.online.add(user_id);
    else state.online.delete(user_id);
    const c = state.chats.get(state.activeChatId);
    if (c && c.type === 'private' && c.peer && c.peer.id === user_id) {
      c.peer.online = online;
      if (last_seen_at) c.peer.last_seen_at = last_seen_at;
      if (!state.typingShown) renderChatHeaderSub(c);
    }
  });

  socket.on('message-reactions', ({ message_id, reactions }) => {
    for (const [cid, msgs] of state.messagesByChat.entries()) {
      const target = msgs.find((m) => m.id === message_id);
      if (target) {
        target.reactions = reactions;
        if (Number(state.activeChatId) === Number(cid)) {
          updateMessageReactionsDOM(message_id, reactions);
        }
        break;
      }
    }
  });

  socket.on('typing', ({ chat_id, user, is_typing }) => {
    if (Number(chat_id) !== Number(state.activeChatId)) return;
    clearTimeout(state.typingTimer);
    if (is_typing) {
      const c = state.chats.get(chat_id);
      const who = c && c.type === 'group' ? `${user.display_name} ` : '';
      setHeaderSub(`<span class="typing">${esc(who)}در حال نوشتن<span class="typing-dots"><span></span><span></span><span></span></span></span>`);
      state.typingShown = true;
      state.typingTimer = setTimeout(() => {
        state.typingShown = false;
        if (Number(state.activeChatId) === Number(chat_id)) renderChatHeaderSub(state.chats.get(chat_id));
      }, 3000);
    } else {
      state.typingShown = false;
      renderChatHeaderSub(state.chats.get(chat_id));
    }
  });

  socket.on('connect', () => {
    loadChats();
    if (state.activeChatId) {
      const activeId = Number(state.activeChatId);
      loadMessages(activeId).then(() => {
        if (Number(state.activeChatId) === activeId) renderMessages(activeId);
      });
    }
  });
}

/* ═══════════════ کامپوزر و ارسال پیام (Composer) ═══════════════ */

let typingSent = false;
let typingStopTimer = null;
function typingPing(forceStop) {
  if (!state.socket || !state.activeChatId) return;
  if (forceStop) {
    if (typingSent) state.socket.emit('typing', { chat_id: state.activeChatId, is_typing: false });
    typingSent = false;
    clearTimeout(typingStopTimer);
    return;
  }
  if (!typingSent) {
    state.socket.emit('typing', { chat_id: state.activeChatId, is_typing: true });
    typingSent = true;
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    typingSent = false;
    state.socket.emit('typing', { chat_id: state.activeChatId, is_typing: false });
  }, 2500);
}

const STICKER_PACK = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷',
  '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇',
  '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜',
  '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳',
  '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏'
];

const POPULAR_GIFS = [
  'https://media.giphy.com/media/26AHONQ79FdWZhAI0/giphy.gif',
  'https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif',
  'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
  'https://media.giphy.com/media/3o7TKMt1VVNkHV2PaE/giphy.gif',
  'https://media.giphy.com/media/bcKmIWkUMCjVm/giphy.gif',
  'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif'
];

function toggleMediaDrawer() {
  const drawer = $('#media-drawer');
  if (!drawer) return;
  if (!drawer.classList.contains('hidden')) {
    drawer.classList.add('hidden');
    return;
  }
  renderMediaDrawer('emojis');
  drawer.classList.remove('hidden');
}

function renderMediaDrawer(tab) {
  const drawer = $('#media-drawer');
  if (!drawer) return;
  let content = '';

  if (tab === 'emojis') {
    const emojis = [
      '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚',
      '😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣',
      '😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔',
      '🫣','🤫','🤐','🫡','🥱','😴','🤤','😪','😮','😵','🤐','😷','🤒','🤕','🤢','🤮','🤧','😵‍💫','🤠','👻','💀',
      '👍','👎','👏','🙌','👐','🤲','🤝','🙏','💪','🧠','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','🔥','✨'
    ];
    content = `<div class="emoji-grid">${emojis.map((e) => `<button type="button" class="drawer-emoji-btn">${e}</button>`).join('')}</div>`;
  } else if (tab === 'stickers') {
    content = `<div class="sticker-grid">${STICKER_PACK.map((s) => `<button type="button" class="drawer-sticker-btn" data-stk="${s}">${s}</button>`).join('')}</div>`;
  } else if (tab === 'gifs') {
    content = `<div class="gif-grid">${POPULAR_GIFS.map((g) => `<img src="${g}" class="drawer-gif-img" loading="lazy" alt="GIF">`).join('')}</div>`;
  }

  drawer.innerHTML = `
    <div class="drawer-tabs">
      <button type="button" class="d-tab${tab === 'emojis' ? ' active' : ''}" data-tab="emojis">ایموجی‌ها</button>
      <button type="button" class="d-tab${tab === 'stickers' ? ' active' : ''}" data-tab="stickers">استیکرها</button>
      <button type="button" class="d-tab${tab === 'gifs' ? ' active' : ''}" data-tab="gifs">گیف‌ها</button>
    </div>
    <div class="drawer-body">${content}</div>
  `;

  drawer.onclick = (e) => {
    const tabBtn = e.target.closest('.d-tab');
    if (tabBtn) {
      renderMediaDrawer(tabBtn.dataset.tab);
      return;
    }
    const emBtn = e.target.closest('.drawer-emoji-btn');
    if (emBtn) {
      const input = $('#msg-input');
      if (input) {
        input.value += emBtn.textContent;
        input.focus();
        updateComposerButtons();
      }
      return;
    }
    const stkBtn = e.target.closest('.drawer-sticker-btn');
    if (stkBtn) {
      drawer.classList.add('hidden');
      const input = $('#msg-input');
      if (input) input.value = stkBtn.dataset.stk;
      sendMessage();
      return;
    }
    const gifImg = e.target.closest('.drawer-gif-img');
    if (gifImg) {
      drawer.classList.add('hidden');
      const input = $('#msg-input');
      if (input) input.value = gifImg.src;
      sendMessage();
      return;
    }
  };
}

function bindSendPopover() {
  const popover = $('#send-popover');
  if (!popover) return;

  $('#send-action-silent')?.addEventListener('click', () => {
    popover.classList.add('hidden');
    sendMessage({ silent: true });
  });

  $('#send-action-schedule')?.addEventListener('click', () => {
    popover.classList.add('hidden');
    const input = $('#sched-datetime');
    const now = new Date(Date.now() + 10 * 60e3);
    if (input) {
      input.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    $('#modal-schedule')?.classList.remove('hidden');
  });

  $$('.sched-quick-picks button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.addMin || 10);
      const target = new Date(Date.now() + mins * 60e3);
      const input = $('#sched-datetime');
      if (input) {
        input.value = new Date(target.getTime() - target.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
      }
    });
  });

  $('#sched-confirm-btn')?.addEventListener('click', () => {
    const dt = $('#sched-datetime')?.value;
    if (!dt) {
      showToast('زمان را مشخص کنید');
      return;
    }
    const scheduledAt = new Date(dt).toISOString();
    $('#modal-schedule')?.classList.add('hidden');
    sendMessage({ scheduledAt });
  });
}

function bindComposer() {
  const input = $('#msg-input');
  const sendBtn = $('#send-btn');
  const voiceBtn = $('#voice-btn');
  const emojiBtn = $('#emoji-btn');
  const attachBtn = $('#attach-btn');

  sendBtn?.addEventListener('click', () => sendMessage());

  sendBtn?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const pop = $('#send-popover');
    if (pop) {
      pop.classList.toggle('hidden');
      pop.style.bottom = '65px';
      pop.style.left = '';
    }
  });

  voiceBtn?.addEventListener('click', startVoiceRecording);
  emojiBtn?.addEventListener('click', toggleMediaDrawer);

  // کلیک روی دکمه سنجاق: باز شدن مستقیم فایل‌براوزر سیستم
  attachBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    const fi = $('#file-input');
    if (fi) {
      fi.removeAttribute('accept');
      fi.click();
    }
  });

  // کلیک‌راست یا نگه‌داشتن روی سنجاق: منوی گزینه‌های پیشرفته (نظرسنجی، رسانه)
  const openAttachMenu = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && attachBtn.dataset.menuOpen === '1') {
      closeMenu();
      return;
    }
    const items = [
      {
        label: 'ارسال عکس و ویدیو',
        icon: ICONS.camera,
        action: () => {
          const fi = $('#file-input');
          if (fi) {
            fi.accept = 'image/*,video/*';
            fi.click();
          }
        },
      },
      {
        label: 'ارسال فایل و اسناد',
        icon: ICONS.file,
        action: () => {
          const fi = $('#file-input');
          if (fi) {
            fi.removeAttribute('accept');
            fi.click();
          }
        },
      },
      {
        label: 'نظرسنجی جدید',
        icon: '📊',
        action: () => {
          const q = $('#poll-question');
          if (q) q.value = '';
          $$('.poll-opt-input').forEach((i) => (i.value = ''));
          $('#modal-poll')?.classList.remove('hidden');
        },
      },
    ];
    const rect = attachBtn.getBoundingClientRect();
    openMenu(items, rect.left, rect.top - 8, { anchorAbove: true });
    attachBtn.dataset.menuOpen = '1';
  };

  attachBtn?.addEventListener('contextmenu', openAttachMenu);

  let attachLongPressTimer = null;
  attachBtn?.addEventListener('touchstart', (e) => {
    attachLongPressTimer = setTimeout(() => {
      attachLongPressTimer = null;
      openAttachMenu(e);
    }, 600);
  }, { passive: true });
  attachBtn?.addEventListener('touchend', () => {
    if (attachLongPressTimer) clearTimeout(attachLongPressTimer);
  }, { passive: true });
  attachBtn?.addEventListener('touchmove', () => {
    if (attachLongPressTimer) clearTimeout(attachLongPressTimer);
  }, { passive: true });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'ArrowUp' && !input.value.trim() && !state.editingMessage) {
      const store = state.messagesByChat.get(state.activeChatId) || [];
      const myMsgs = store.filter((m) => m.sender.id === state.me?.id && !m.poll);
      if (myMsgs.length) {
        e.preventDefault();
        startEditMessage(myMsgs[myMsgs.length - 1]);
      }
    }
  });

  input?.addEventListener('input', () => {
    updateComposerButtons();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    typingPing(false);

    if (state.activeChatId && !state.editingMessage) {
      const val = input.value;
      if (val.trim()) {
        localStorage.setItem('gg_draft_' + state.activeChatId, val);
      } else {
        localStorage.removeItem('gg_draft_' + state.activeChatId);
      }
      renderSidebar();
    }

    checkMentionAutocomplete();
    updateComposerButtons();
  });

  input?.addEventListener('keyup', updateComposerButtons);
  input?.addEventListener('change', updateComposerButtons);
  input?.addEventListener('paste', () => setTimeout(updateComposerButtons, 0));
  input?.addEventListener('cut', () => setTimeout(updateComposerButtons, 0));

  $('#file-input')?.addEventListener('change', () => {
    const f = $('#file-input')?.files[0];
    if (f) setPendingFile(f);
    const fi = $('#file-input');
    if (fi) fi.value = '';
  });

  updateComposerButtons();

  $('#messages')?.addEventListener('scroll', async () => {
    closeMenu();
    const el = $('#messages');
    const chatId = state.activeChatId;
    if (!chatId || el.scrollTop > 80 || state.loadingOlder) return;
    const arr = state.messagesByChat.get(chatId) || [];
    if (!arr.length || state.noMore.get(chatId)) return;

    state.loadingOlder = true;
    const prevHeight = el.scrollHeight;
    try {
      await loadMessages(chatId, arr[0].id);
      renderMessages(chatId, { keepScroll: prevHeight });
    } catch {}
    state.loadingOlder = false;
  });

  bindLongPress('#messages', '.msg', (el, x, y) => {
    const id = Number(el.dataset.id);
    const store = state.messagesByChat.get(state.activeChatId) || [];
    const m = store.find((mm) => mm.id === id);
    if (!m || m.is_service) return;
    openMenu(msgMenuItems(m), x, y, {
      reactions: true,
      onReaction: (emoji) => toggleReaction(m.id, emoji),
    });
  });

  $('#messages')?.addEventListener('click', (e) => {
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    const rxBtn = e.target.closest('.reaction-pill');
    if (rxBtn) {
      const mid = Number(rxBtn.dataset.mid);
      const emoji = rxBtn.dataset.rx;
      toggleReaction(mid, emoji);
      return;
    }
    const quote = e.target.closest('.reply-quote');
    if (quote) {
      goToMessage(Number(quote.dataset.goto));
      return;
    }
    const pollOpt = e.target.closest('.poll-option');
    if (pollOpt) {
      const pollId = Number(pollOpt.dataset.pollId);
      const optId = Number(pollOpt.dataset.optId);
      votePoll(pollId, optId, false);
      return;
    }
    const retractBtn = e.target.closest('.poll-retract-btn');
    if (retractBtn) {
      const pollId = Number(retractBtn.dataset.pollId);
      votePoll(pollId, null, true);
      return;
    }
    const mentionTag = e.target.closest('.mention-tag');
    if (mentionTag) {
      const uname = mentionTag.dataset.username;
      if (uname) {
        state.searchQ = uname;
        const searchInput = $('#search-input');
        if (searchInput) searchInput.value = uname;
        renderSidebar();
      }
      return;
    }
  });

  $('#chat-header-info')?.addEventListener('click', () => {
    if (state.activeChatId) openChatInfo(state.activeChatId);
  });
}

/* ═══════════════ راه‌اندازی و مقداردهی اولیه (App Init) ═══════════════ */

async function init() {
  applyTheme(state.theme);
  applyWallpaper(state.wallpaper);
  bindAuth();
  bindSidebar();
  bindComposer();
  bindSendPopover();
  bindPollModal();
  bindTopicModal();
  bindWallpaperModal();
  bindChatSearch();
  bindInfoPane();
  bindNewChatModal();
  bindEditModal();
  bindAddModal();
  bindJoinModal();
  bindForwardModal();
  bindProfileModal();
  bindSettingsDrawer();
  bindOverlays();
  window.addEventListener('hashchange', checkUrlHash);

  if (state.token) {
    try {
      await enterApp();
      checkUrlHash();
      return;
    } catch {
      localStorage.removeItem('gg_token');
      state.token = null;
    }
  }
  $('#auth-screen')?.classList.remove('hidden');
  $('#login-username')?.focus();
}

init();
