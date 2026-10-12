'use strict';

/* ═══════════════ ماژول گفتگوها، نوار کناری و اطلاعات چت (Chats & Sidebar) ═══════════════ */

const chatName = (c) => {
  if (c.is_saved) return 'پیام‌های ذخیره‌شده';
  return c.type === 'private' ? c.peer?.display_name || 'گفتگو' : c.title;
};
const canPostIn = (c) => c.type !== 'channel' || ['owner', 'admin'].includes(c.role);

async function loadChats() {
  const r = await api('/chats');
  state.chats.clear();
  r.chats.forEach((c) => {
    state.chats.set(c.id, c);
    if (c.peer && c.peer.online) state.online.add(c.peer.id);
    const peerR = Math.max(
      Number(c.max_peer_read_id || 0),
      Number(c.peer ? c.peer.last_read_id : 0)
    );
    state.peerReads.set(c.id, peerR);
  });
  renderSidebar();
}

function renderSidebar() {
  const q = state.searchQ.trim().toLowerCase();
  const chats = [...state.chats.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updated_at || 0) - (a.updated_at || 0))
    .filter((c) => {
      // فیلتر بر اساس پوشه / تب فعال
      if (state.activeTab === 'private' && (c.type !== 'private' || c.is_saved)) return false;
      if (state.activeTab === 'groups' && c.type !== 'group') return false;
      if (state.activeTab === 'channels' && c.type !== 'channel') return false;
      if (state.activeTab === 'unread' && (!c.unread_count || c.unread_count <= 0)) return false;

      // فیلتر جستجو
      if (!q) return true;
      const n = (chatName(c) || '').toLowerCase();
      return (
        n.includes(q) ||
        (c.title ? c.title.toLowerCase().includes(q) : false) ||
        (c.peer && c.peer.username ? c.peer.username.toLowerCase().includes(q) : false)
      );
    });

  let html = '';
  if (q && chats.length) html += `<div class="section-label">گفتگوها</div>`;
  html += chats.map(chatItemHTML).join('');
  if (q && !chats.length && !state.searchUsers.length && !state.searchMessages.length) {
    html = `<div class="empty-hint">نتیجه‌ای پیدا نشد</div>`;
  }

  // نتایج جستجوی کاربران
  if (q) {
    html += `<div class="section-label">کاربران</div>`;
    html +=
      state.searchUsers
        .map(
          (u) => `
      <div class="chat-item user-item" data-user="${u.id}">
        ${avatarHTML(u)}
        <div class="ci-main">
          <div class="ci-row"><span class="ci-name">${esc(u.display_name)}</span></div>
          <div class="ci-row"><span class="ci-preview">@${esc(u.username)}</span></div>
        </div>
      </div>`
        )
        .join('') || `<div class="empty-hint">کاربری با این نام پیدا نشد</div>`;
  }

  // نتایج جستجوی پیام‌ها در سراسر برنامه (Global Message Search)
  if (q && state.searchMessages.length) {
    html += `<div class="section-label">پیام‌ها (${faNum(state.searchMessages.length)})</div>`;
    html += state.searchMessages.map((m) => `
      <div class="chat-item search-msg-item" data-chat-id="${m.chat_id}" data-msg-id="${m.id}">
        ${avatarHTML(m.sender)}
        <div class="ci-main">
          <div class="ci-row">
            <span class="ci-name">${esc(m.chat_title || m.sender.display_name)}</span>
            <span class="ci-time">${listTime(m.created_at)}</span>
          </div>
          <div class="ci-row">
            <span class="ci-preview">${esc(truncate(m.text, 50))}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  const listEl = $('#chat-list');
  if (listEl) listEl.innerHTML = html;
}

function chatItemHTML(c) {
  let av;
  if (c.is_saved) {
    av = avatarHTML({ id: c.id, icon: ICONS.saved });
  } else if (c.type === 'private') {
    av = avatarHTML(c.peer || {});
  } else {
    av = avatarHTML({ id: c.id, title: c.title, avatar_url: c.avatar_url, icon: c.type === 'group' ? ICONS.group : ICONS.channel });
  }

  // پیش‌نویس خودکار چت (Auto-draft)
  const draft = localStorage.getItem('gg_draft_' + c.id);
  let preview = 'هنوز پیامی نیست';
  let isDraft = false;

  if (draft && c.id !== state.activeChatId) {
    preview = `پیش‌نویس: ${draft}`;
    isDraft = true;
  } else {
    const lm = c.last_message;
    if (lm) {
      let text = lm.text || '';
      let prefix = '';
      if (lm.sender_id === state.me?.id) prefix = 'شما: ';
      else if (c.type !== 'private') prefix = lm.sender_name + ': ';
      if (!text && lm.file) text = filePreviewTag(lm.file);
      preview = prefix + text;
    }
  }

  const badge = c.unread_count > 0 ? `<span class="ci-unread">${faNum(c.unread_count)}</span>` : '';
  const pin = c.pinned ? `<span class="pin-flag" title="سنجاق‌شده" style="display:inline-flex;width:14px;height:14px;vertical-align:middle;margin-inline-end:3px;">${ICONS.pin}</span>` : '';
  const muteIcon = c.is_muted ? `<span class="mute-flag" title="بی‌صدا">${ICONS.mute}</span>` : '';

  return `
  <div class="chat-item${c.id === state.activeChatId ? ' active' : ''}${c.unread_count > 0 ? ' unread' : ''}" data-id="${c.id}">
    ${av}
    <div class="ci-main">
      <div class="ci-row">
        <span class="ci-name">${esc(chatName(c))}</span>
        <span class="ci-time">${muteIcon}${pin}${listTime(c.updated_at)}</span>
      </div>
      <div class="ci-row">
        <span class="ci-preview${isDraft ? ' ci-draft' : ''}">${esc(truncate(preview, 45))}</span>
        ${badge}
      </div>
    </div>
  </div>`;
}

/* منوی زمینه آیتم‌های گفتگو */
function chatMenuItems(c) {
  const items = [];
  items.push({
    label: c.pinned ? 'برداشتن سنجاق' : 'سنجاق کردن',
    icon: c.pinned ? ICONS.unpin : ICONS.pin,
    action: () => togglePin(c),
  });

  // اعلان و بی‌صدا (Mute / Unmute)
  if (c.is_muted) {
    items.push({ label: 'لغو حالت بی‌صدا', icon: ICONS.unmute, action: () => unmuteChat(c) });
  } else {
    items.push({ label: 'بی‌صدا کردن (۸ ساعت)', icon: ICONS.mute, action: () => muteChat(c, 8 * 3600) });
    items.push({ label: 'بی‌صدا کردن همیشه', icon: ICONS.mute, action: () => muteChat(c, null) });
  }

  if (c.unread_count > 0) {
    items.push({ label: 'علامت‌گذاری به‌عنوان خوانده‌شده', icon: ICONS.read, action: () => markChatRead(c) });
  }
  if (c.type !== 'private' && c.role !== 'owner') {
    items.push({
      label: c.type === 'group' ? 'ترک گروه' : 'ترک کانال',
      icon: ICONS.leave,
      danger: true,
      action: () => leaveChat(c),
    });
  }
  if (c.type === 'private' || ['owner', 'admin'].includes(c.role)) {
    items.push({ label: 'پاک کردن تاریخچه', icon: ICONS.clear, danger: true, action: () => clearHistory(c) });
  }
  if (c.type === 'private' || c.role === 'owner') {
    items.push({ label: 'حذف گفتگو', icon: ICONS.delete, danger: true, action: () => deleteChat(c) });
  }
  return items;
}

async function muteChat(c, durationSeconds) {
  try {
    await api(`/chats/${c.id}/mute`, { method: 'POST', body: { duration_seconds: durationSeconds } });
    c.is_muted = true;
    showToast('گفتگو بی‌صدا شد 🔕');
    renderSidebar();
  } catch (e) {
    showToast(e.message);
  }
}

async function unmuteChat(c) {
  try {
    await api(`/chats/${c.id}/unmute`, { method: 'POST' });
    c.is_muted = false;
    showToast('اعلان‌ها فعال شدند 🔔');
    renderSidebar();
  } catch (e) {
    showToast(e.message);
  }
}

async function togglePin(c) {
  try {
    const r = await api(`/chats/${c.id}/pin`, { method: 'POST', body: { pinned: !c.pinned } });
    c.pinned = r.pinned;
    renderSidebar();
  } catch (e) {
    showToast(e.message);
  }
}

async function markChatRead(c) {
  try {
    await api(`/chats/${c.id}/read`, { method: 'POST' });
    c.unread_count = 0;
    renderSidebar();
  } catch (e) {
    showToast(e.message);
  }
}

function forgetChat(chatId) {
  state.chats.delete(chatId);
  state.messagesByChat.delete(chatId);
  if (state.activeChatId === chatId) closeChatView();
  if (state.infoChatId === chatId) closeInfoPane();
  renderSidebar();
}

async function leaveChat(c) {
  const what = c.type === 'group' ? 'گروه' : 'کانال';
  const ok = await askConfirm({ title: 'ترک ' + what, text: `آیا از ترک «${c.title}» مطمئن هستید؟` });
  if (!ok) return;
  try {
    await api(`/chats/${c.id}/leave`, { method: 'POST' });
    forgetChat(c.id);
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteChat(c) {
  const isPrivate = c.type === 'private';
  const ok = await askConfirm({
    title: 'حذف گفتگو',
    text: isPrivate
      ? 'کل گفتگو و تاریخچه آن برای هر دو طرف حذف می‌شود. مطمئن هستید؟'
      : `«${c.title}» و تمام پیام‌هایش برای همه اعضا حذف می‌شود. مطمئن هستید؟`,
    ok: 'حذف',
  });
  if (!ok) return;
  try {
    await api(`/chats/${c.id}`, { method: 'DELETE' });
    forgetChat(c.id);
  } catch (e) {
    showToast(e.message);
  }
}

async function clearHistory(c) {
  const ok = await askConfirm({
    title: 'پاک کردن تاریخچه',
    text: 'تمام پیام‌های این گفتگو پاک می‌شود. مطمئن هستید؟',
    ok: 'پاک کن',
  });
  if (!ok) return;
  try {
    await api(`/chats/${c.id}/messages`, { method: 'DELETE' });
    state.messagesByChat.delete(c.id);
    if (state.activeChatId === c.id) renderMessages(c.id);
    renderSidebar();
  } catch (e) {
    showToast(e.message);
  }
}

/* ═══════════════ پیام‌های ذخیره‌شده (Saved Messages) ═══════════════ */

async function openSavedMessages() {
  try {
    const r = await api('/chats/saved', { method: 'POST' });
    if (r.chat) {
      state.chats.set(r.chat.id, r.chat);
      renderSidebar();
      openChat(r.chat.id);
    }
  } catch (e) {
    showToast(e.message);
  }
}

function bindSidebar() {
  $('#chat-list')?.addEventListener('click', (e) => {
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    const searchMsgItem = e.target.closest('.search-msg-item');
    if (searchMsgItem) {
      const chatId = Number(searchMsgItem.dataset.chatId);
      const msgId = Number(searchMsgItem.dataset.msgId);
      openChat(chatId).then(() => {
        setTimeout(() => goToMessage(msgId), 300);
      });
      return;
    }
    const userItem = e.target.closest('.user-item');
    if (userItem) {
      startPrivateChat(Number(userItem.dataset.user));
      return;
    }
    const item = e.target.closest('.chat-item');
    if (item) openChat(Number(item.dataset.id));
  });

  // تب‌ها / پوشه‌های گفتگو
  $('#chat-tabs')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.chat-tab');
    if (!tabBtn) return;
    $$('#chat-tabs .chat-tab').forEach((b) => b.classList.remove('active'));
    tabBtn.classList.add('active');
    state.activeTab = tabBtn.dataset.tab;
    renderSidebar();
  });

  // منوی زمینه گفتگوها
  bindLongPress('#chat-list', '.chat-item[data-id]', (el, x, y) => {
    const c = state.chats.get(Number(el.dataset.id));
    if (c) openMenu(chatMenuItems(c), x, y);
  });

  // جستجوی سراسری پیام‌ها و کاربران
  let searchTimer = null;
  $('#search-input')?.addEventListener('input', (e) => {
    state.searchQ = e.target.value;
    renderSidebar();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = state.searchQ.trim();
      if (!q) {
        state.searchUsers = [];
        state.searchMessages = [];
        renderSidebar();
        return;
      }
      try {
        const [uRes, mRes] = await Promise.all([
          api('/search/users?q=' + encodeURIComponent(q)).catch(() => ({ users: [] })),
          api('/search/messages?q=' + encodeURIComponent(q)).catch(() => ({ messages: [] })),
        ]);
        if (state.searchQ.trim() === q) {
          state.searchUsers = uRes.users || [];
          state.searchMessages = mRes.messages || [];
          renderSidebar();
        }
      } catch {
        /* نادیده گرفتن */
      }
    }, 280);
  });

  // منوی اصلی (همبرگری)
  $('#menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#menu-dropdown')?.classList.toggle('hidden');
    $('#fab-menu')?.classList.add('hidden');
  });

  $('#menu-saved')?.addEventListener('click', () => {
    $('#menu-dropdown')?.classList.add('hidden');
    openSavedMessages();
  });

  $('#menu-theme')?.addEventListener('click', () => {
    $('#menu-dropdown')?.classList.add('hidden');
    toggleTheme();
  });

  $('#menu-wallpaper')?.addEventListener('click', () => {
    $('#menu-dropdown')?.classList.add('hidden');
    $('#modal-wallpaper')?.classList.remove('hidden');
  });

  $('#menu-join')?.addEventListener('click', () => {
    $('#menu-dropdown')?.classList.add('hidden');
    openJoinModal();
  });

  $('#menu-profile')?.addEventListener('click', () => {
    $('#menu-dropdown')?.classList.add('hidden');
    openSettingsDrawer();
  });

  $('#menu-logout')?.addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* نادیده گرفتن */
    }
    localStorage.removeItem('gg_token');
    location.reload();
  });

  // دکمه شناور
  $('#fab')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#fab-menu')?.classList.toggle('hidden');
    $('#menu-dropdown')?.classList.add('hidden');
  });
  $('#fab-group')?.addEventListener('click', () => {
    $('#fab-menu')?.classList.add('hidden');
    openNewChatModal('group');
  });
  $('#fab-channel')?.addEventListener('click', () => {
    $('#fab-menu')?.classList.add('hidden');
    openNewChatModal('channel');
  });

  $('#profile-chip')?.addEventListener('click', openSettingsDrawer);
  $('#back-btn')?.addEventListener('click', closeChatView);
}

async function startPrivateChat(userId) {
  try {
    const r = await api('/chats/private', { method: 'POST', body: { user_id: userId } });
    if (r.chat) {
      state.chats.set(r.chat.id, r.chat);
      const pRead = Math.max(Number(r.chat.max_peer_read_id || 0), Number(r.chat.peer ? r.chat.peer.last_read_id : 0));
      state.peerReads.set(r.chat.id, pRead);
    }
    state.searchQ = '';
    state.searchUsers = [];
    state.searchMessages = [];
    const searchInput = $('#search-input');
    if (searchInput) searchInput.value = '';
    renderSidebar();
    openChat(r.chat_id || r.chat?.id);
  } catch (e) {
    showToast(e.message);
  }
}

/* ═══════════════ باز کردن و نمایش گفتگو ═══════════════ */

async function openChat(id) {
  typingPing(true);
  const seq = ++state.openSeq;
  const chat = state.chats.get(id);
  if (!chat) return;

  const curRead = Math.max(
    state.peerReads.get(id) || 0,
    Number(chat.max_peer_read_id || 0),
    Number(chat.peer ? chat.peer.last_read_id : 0)
  );
  state.peerReads.set(id, curRead);

  state.activeChatId = id;
  state.activeTopicId = null;
  state.typingShown = false;
  cancelReply();
  cancelEdit();
  document.body.classList.add('chat-open');
  $('#empty-state')?.classList.add('hidden');
  $('#chat-view')?.classList.remove('hidden');
  closeInfoPane();
  renderSidebar();

  renderChatHeader(chat);
  renderPinnedBar(chat);
  loadTopics(id);

  // بازیابی پیش‌نویس (Auto-draft)
  const draft = localStorage.getItem('gg_draft_' + id);
  const input = $('#msg-input');
  if (input) {
    if (draft) {
      input.value = draft;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    } else {
      input.value = '';
      input.style.height = 'auto';
    }
  }

  const msgsEl = $('#messages');
  if (msgsEl) msgsEl.innerHTML = '';

  if (!state.messagesByChat.has(id)) {
    try {
      await loadMessages(id);
    } catch (e) {
      if (msgsEl) msgsEl.innerHTML = `<div class="empty-chat">${esc(e.message)}</div>`;
      return;
    }
    if (seq !== state.openSeq) return;
  }
  renderMessages(id);
  updateComposerForChat(chat);
  markChatReadQuiet(chat);
}

async function markChatReadQuiet(chat) {
  try {
    await api(`/chats/${chat.id}/read`, { method: 'POST' });
    chat.unread_count = 0;
    renderSidebar();
  } catch {
    /* نادیده گرفتن */
  }
}

function renderChatHeader(chat) {
  const el = $('#chat-header-info');
  if (!el) return;
  let title, av;
  if (chat.is_saved) {
    title = 'پیام‌های ذخیره‌شده';
    av = avatarHTML({ id: chat.id, icon: ICONS.saved });
  } else if (chat.type === 'private') {
    title = chat.peer?.display_name || 'گفتگوی خصوصی';
    av = avatarHTML(chat.peer || {});
  } else {
    title = chat.title;
    av = avatarHTML({ id: chat.id, title: chat.title, avatar_url: chat.avatar_url, icon: chat.type === 'group' ? ICONS.group : ICONS.channel });
  }
  el.innerHTML = `${av}<div class="cht"><div class="t">${esc(title)}</div><div class="s" id="header-sub"></div></div>`;
  renderChatHeaderSub(chat);
}

function renderChatHeaderSub(chat) {
  if (!chat) return;
  let sub = '';
  if (chat.is_saved) {
    sub = 'فضای ابری شخصی برای یادداشت‌ها';
  } else if (chat.type === 'private') {
    sub = chat.peer && (state.online.has(chat.peer.id) ? 'آنلاین' : relLastSeen(chat.peer.last_seen_at));
  } else {
    sub = `${faNum(chat.member_count)} عضو`;
  }
  setHeaderSub(esc(sub));
}

function setHeaderSub(html) {
  const el = $('#header-sub');
  if (el) el.innerHTML = html;
}

/* ═══════════════ پیام سنجاق‌شده در چت (Pinned Message) ═══════════════ */

function renderPinnedBar(chat) {
  const bar = $('#pinned-bar');
  if (!bar) return;
  if (!chat || !chat.pinned_message) {
    bar.classList.add('hidden');
    return;
  }
  const pm = chat.pinned_message;
  const content = $('#pinned-bar-content');
  const preview = pm.text || filePreviewTag(pm.file) || 'پیام سنجاق‌شده';
  content.innerHTML = `
    <span class="pinned-title">پیام سنجاق‌شده:</span>
    <span class="pinned-text">${esc(truncate(preview, 60))}</span>
  `;
  bar.classList.remove('hidden');

  content.onclick = () => goToMessage(pm.id);
  const closeBtn = $('#pinned-bar-close');
  if (closeBtn) {
    closeBtn.onclick = async () => {
      try {
        await api(`/chats/${chat.id}/pin-message`, { method: 'POST', body: { message_id: null } });
        chat.pinned_message = null;
        bar.classList.add('hidden');
      } catch (e) {
        showToast(e.message);
      }
    };
  }
}

async function pinMessageInChat(messageId) {
  try {
    const r = await api(`/chats/${state.activeChatId}/pin-message`, {
      method: 'POST',
      body: { message_id: messageId },
    });
    const c = state.chats.get(state.activeChatId);
    if (c) c.pinned_message = r.pinned_message;
    renderPinnedBar(c);
    showToast('پیام سنجاق شد 📌');
  } catch (e) {
    showToast(e.message);
  }
}

/* ═══════════════ تاپیک‌های گروه (Topics / Forum Mode) ═══════════════ */

async function loadTopics(chatId) {
  const topicBar = $('#topic-bar');
  if (!topicBar) return;
  const chat = state.chats.get(chatId);
  if (!chat || chat.type !== 'group') {
    topicBar.classList.add('hidden');
    return;
  }
  try {
    const r = await api(`/chats/${chatId}/topics`);
    state.topicsByChat.set(chatId, r.topics || []);
    renderTopicBar(chatId);
  } catch {
    topicBar.classList.add('hidden');
  }
}

function renderTopicBar(chatId) {
  const topicBar = $('#topic-bar');
  if (!topicBar) return;
  const topics = state.topicsByChat.get(chatId) || [];
  let html = `
    <button class="topic-pill${state.activeTopicId == null ? ' active' : ''}" data-tid="">
      <span>همه گفتگوها</span>
    </button>
  `;
  topics.forEach((t) => {
    html += `
      <button class="topic-pill${state.activeTopicId === t.id ? ' active' : ''}" data-tid="${t.id}">
        <span>${esc(t.icon || '💬')} ${esc(t.title)}</span>
      </button>
    `;
  });
  html += `<button class="topic-pill new-topic-btn" id="btn-open-topic-modal">+ تاپیک جدید</button>`;
  topicBar.innerHTML = html;
  topicBar.classList.remove('hidden');

  topicBar.onclick = (e) => {
    if (e.target.closest('#btn-open-topic-modal')) {
      $('#modal-topic')?.classList.remove('hidden');
      $('#topic-title')?.focus();
      return;
    }
    const pill = e.target.closest('.topic-pill');
    if (!pill) return;
    const tid = pill.dataset.tid ? Number(pill.dataset.tid) : null;
    state.activeTopicId = tid;
    $$('#topic-bar .topic-pill').forEach((b) => b.classList.remove('active'));
    pill.classList.add('active');
    renderMessages(chatId);
  };
}

function updateComposerForChat(chat) {
  const isPending = state.me && state.me.status === 'pending';
  if (isPending) {
    updateApprovalState();
    return;
  }
  const canPost = canPostIn(chat);
  $('#composer')?.classList.toggle('hidden', !canPost);
  $('#channel-notice')?.classList.toggle('hidden', canPost);
  clearPendingFile();
  if (canPost) $('#msg-input')?.focus();
}

function closeChatView() {
  typingPing(true);
  closeChatSearch();
  state.activeChatId = null;
  state.activeTopicId = null;
  cancelReply();
  cancelEdit();
  closeInfoPane();
  $('#chat-view')?.classList.add('hidden');
  $('#empty-state')?.classList.remove('hidden');
  document.body.classList.remove('chat-open');
  renderSidebar();
}

/* ═══════════════ پنل اطلاعات گفتگو و رسانه‌های اشتراکی ═══════════════ */

function canModerate(meRole, targetRole) {
  if (targetRole === 'owner') return false;
  if (meRole === 'owner') return true;
  if (meRole === 'admin') return targetRole === 'member';
  return false;
}

async function openChatInfo(chatId) {
  state.infoChatId = chatId;
  let data;
  try {
    data = await api('/chats/' + chatId);
  } catch (e) {
    showToast(e.message);
    return;
  }
  state.chats.set(chatId, data);
  const pane = $('#info-pane');
  if (!pane) return;
  pane.classList.remove('hidden');

  switchInfoTab('details');
  renderInfoPane(data);
  requestAnimationFrame(() => pane.classList.add('open'));
}

function closeInfoPane() {
  const pane = $('#info-pane');
  if (!pane) return;
  pane.classList.remove('open');
  pane.classList.add('hidden');
  state.infoChatId = null;
}

function switchInfoTab(tab) {
  $('#tab-btn-details')?.classList.toggle('active', tab === 'details');
  $('#tab-btn-media')?.classList.toggle('active', tab === 'media');
  $('#info-tab-content-details')?.classList.toggle('hidden', tab !== 'details');
  $('#info-tab-content-media')?.classList.toggle('hidden', tab !== 'media');

  if (tab === 'media' && state.infoChatId) {
    loadSharedMedia(state.sharedMediaType);
  }
}

async function loadSharedMedia(type) {
  state.sharedMediaType = type;
  $$('.shared-media-subtabs .sm-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const box = $('#shared-media-content');
  if (!box) return;
  box.innerHTML = '<div class="empty-hint">در حال بارگذاری رسانه‌ها…</div>';

  try {
    const r = await api(`/chats/${state.infoChatId}/media?type=${type}`);
    const items = r.items || [];
    if (!items.length) {
      box.innerHTML = '<div class="empty-hint">موردی یافت نشد</div>';
      return;
    }

    if (type === 'photos_videos') {
      box.innerHTML = `
        <div class="sm-grid">
          ${items.map((m) => {
            const url = furl(m.file.id);
            if (m.file.mime.startsWith('image/')) {
              return `<img src="${esc(url)}" class="sm-thumb" loading="lazy" onclick="openLightbox('${esc(url)}')">`;
            }
            return `<video src="${esc(url)}" class="sm-thumb" controls preload="metadata"></video>`;
          }).join('')}
        </div>
      `;
    } else if (type === 'files') {
      box.innerHTML = items.map((m) => `
        <a class="file-card sm-file-row" href="${esc(furl(m.file.id))}&download=1" download="${esc(m.file.name)}">
          <span class="file-icon">${ICONS.file}</span>
          <span class="file-info">
            <span class="file-name">${esc(m.file.name)}</span>
            <span class="file-size">${fmtSize(m.file.size)} · ${listTime(m.created_at)}</span>
          </span>
          <span class="file-dl">${ICONS.download}</span>
        </a>
      `).join('');
    } else if (type === 'audio') {
      box.innerHTML = items.map((m) => `
        <div class="sm-audio-row">
          ${voicePlayerHTML(m, m.file)}
          <span class="sm-audio-date">${listTime(m.created_at)}</span>
        </div>
      `).join('');
      bindVoicePlayers(box);
    } else if (type === 'links') {
      box.innerHTML = items.map((m) => linkPreviewHTML(m.link_preview)).join('');
    }
  } catch (e) {
    box.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`;
  }
}

function renderInfoPane(data) {
  const isPrivate = data.type === 'private';
  const chatIcon = data.type === 'group' ? ICONS.group : ICONS.channel;

  const heroAv = isPrivate
    ? avatarHTML(data.peer || {})
    : avatarHTML({ id: data.id, title: data.title, avatar_url: data.avatar_url, icon: chatIcon });
  const sub = isPrivate
    ? `@${esc(data.peer?.username || '')}<br>${state.online.has(data.peer?.id) ? 'آنلاین' : esc(relLastSeen(data.peer?.last_seen_at))}`
    : `${faNum(data.member_count)} عضو · ${data.type === 'group' ? 'گروه' : 'کانال'}`;
  $('#info-hero').innerHTML = `${heroAv}<div class="ih-title">${esc(isPrivate ? data.peer?.display_name || '' : data.title)}</div><div class="ih-sub">${sub}</div>`;
  const heroAvatar = $('#info-hero .avatar');
  const avUrl = isPrivate ? data.peer?.avatar_url : data.avatar_url;
  if (avUrl && heroAvatar) {
    heroAvatar.addEventListener('click', () => openLightbox(withToken(avUrl)));
  }

  // درباره گفتگو و بیوگرافی کاربر
  const aboutBox = $('#info-about');
  if (aboutBox) {
    const bioOrAbout = isPrivate ? data.peer?.bio : data.about;
    if (bioOrAbout) {
      aboutBox.textContent = bioOrAbout;
      aboutBox.classList.remove('hidden');
    } else {
      aboutBox.classList.add('hidden');
    }
  }

  // اکشن‌های مدیریتی
  const actions = $('#info-actions');
  if (actions) {
    if (!isPrivate && ['owner', 'admin'].includes(data.role)) {
      actions.innerHTML = `
        <button data-act="add-member">${ICONS.addMember} افزودن عضو</button>
        <button data-act="edit">${ICONS.edit} ویرایش</button>`;
      actions.classList.remove('hidden');
    } else {
      actions.innerHTML = '';
      actions.classList.add('hidden');
    }
  }

  // لینک دعوت
  const inviteBox = $('#info-invite-box');
  if (inviteBox) {
    if (!isPrivate) {
      const link = `${window.location.origin}#join/${data.invite_code || ''}`;
      const canRevoke = ['owner', 'admin'].includes(data.role);
      inviteBox.innerHTML = `
        <div class="invite-card">
          <div class="invite-card-head">
            <span style="display:flex;align-items:center;gap:6px;">${ICONS.link} لینک دعوت</span>
          </div>
          <div class="invite-link-row">
            <span class="invite-link-text">${esc(link)}</span>
          </div>
          <div class="invite-actions">
            <button type="button" id="copy-invite-btn">${ICONS.copy} کپی لینک</button>
            ${canRevoke ? `<button type="button" class="danger" id="revoke-invite-btn">${ICONS.refresh} لینک جدید</button>` : ''}
          </div>
        </div>`;
      inviteBox.classList.remove('hidden');

      const copyBtn = $('#copy-invite-btn');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(link);
            showToast('لینک دعوت کپی شد ✅');
          } catch {
            showToast('کپی ممکن نشد');
          }
        };
      }
      const revokeBtn = $('#revoke-invite-btn');
      if (revokeBtn) {
        revokeBtn.onclick = async () => {
          const ok = await askConfirm({
            title: 'لغو و ساخت لینک جدید',
            text: 'آیا از باطل کردن لینک فعلی و تولید لینک جدید مطمئن هستید؟ لینک قبلی دیگر معتبر نخواهد بود.',
            ok: 'تولید لینک جدید',
          });
          if (!ok) return;
          try {
            const r = await api(`/chats/${data.id}/invite-link/revoke`, { method: 'POST' });
            data.invite_code = r.invite_code;
            showToast('لینک جدید تولید شد ✅');
            await refreshInfoPane();
          } catch (e) {
            showToast(e.message);
          }
        };
      }
    } else {
      inviteBox.innerHTML = '';
      inviteBox.classList.add('hidden');
    }
  }

  // اعضا
  const membersBox = $('#info-members-box');
  if (membersBox) {
    if (!isPrivate) {
      $('#info-members-label').textContent = `اعضا (${faNum(data.member_count)})`;
      const meRole = data.role;
      $('#info-members').innerHTML = (data.members || [])
        .map((u) => {
          const badge =
            u.role === 'owner'
              ? '<span class="role-badge owner">👑 سازنده</span>'
              : u.role === 'admin'
                ? '<span class="role-badge">مدیر</span>'
                : '';
          const menu = (u.id !== state.me?.id && canModerate(meRole, u.role))
            ? `<button class="icon-btn im-menu" data-uid="${u.id}" title="گزینه‌ها">⋯</button>`
            : '';
          return `
          <div class="member-row" data-uid="${u.id}">
            ${avatarHTML(u)}
            <span class="mr-name">${esc(u.display_name)}${u.id === state.me?.id ? ' (شما)' : ''}</span>
            <span class="mr-uname">@${esc(u.username)}</span>
            ${badge}
            ${menu}
          </div>`;
        })
        .join('');
      membersBox.classList.remove('hidden');
    } else {
      membersBox.classList.add('hidden');
    }
  }

  // دکمه‌های خطرناک و مسدودی کاربر
  const danger = $('#info-danger');
  if (danger) {
    let dhtml = '';
    if (isPrivate && data.peer) {
      const isBlocked = data.peer.is_blocked;
      dhtml += `<button class="danger-btn" id="block-user-btn">${isBlocked ? 'رفع مسدودی کاربر' : 'مسدود کردن کاربر'}</button>`;
      dhtml += `<button class="danger-btn" data-dact="clear">پاک کردن تاریخچه</button>`;
      dhtml += `<button class="danger-btn" data-dact="delete">حذف گفتگو</button>`;
    } else {
      if (data.role !== 'owner') {
        dhtml += `<button class="danger-btn" data-dact="leave">ترک ${data.type === 'group' ? 'گروه' : 'کانال'}</button>`;
      }
      if (data.role === 'owner') {
        dhtml += `<button class="danger-btn" data-dact="delete">حذف ${data.type === 'group' ? 'گروه' : 'کانال'}</button>`;
      }
    }
    danger.innerHTML = dhtml;

    const blockBtn = $('#block-user-btn');
    if (blockBtn && isPrivate && data.peer) {
      blockBtn.onclick = async () => {
        const peerId = data.peer.id;
        if (data.peer.is_blocked) {
          await api(`/users/${peerId}/unblock`, { method: 'POST' });
          data.peer.is_blocked = false;
          showToast('کاربر از مسدودی خارج شد');
        } else {
          await api(`/users/${peerId}/block`, { method: 'POST' });
          data.peer.is_blocked = true;
          showToast('کاربر مسدود شد');
        }
        renderInfoPane(data);
      };
    }
  }
}

async function refreshInfoPane() {
  if (!state.infoChatId) return;
  const id = state.infoChatId;
  try {
    const data = await api('/chats/' + id);
    state.chats.set(id, data);
    renderInfoPane(data);
    renderSidebar();
  } catch {
    /* نادیده گرفتن */
  }
}

async function setMemberRole(chatId, uid, role) {
  try {
    await api(`/chats/${chatId}/members/${uid}`, { method: 'PUT', body: { role } });
    showToast(role === 'admin' ? 'به مدیر ارتقا یافت ✅' : 'مدیریت او گرفته شد');
    await refreshInfoPane();
  } catch (e) {
    showToast(e.message);
  }
}

async function removeMember(chatId, u, chatType) {
  const what = chatType === 'group' ? 'گروه' : 'کانال';
  const ok = await askConfirm({
    title: 'حذف عضو',
    text: `«${u.display_name}» از ${what} حذف شود؟`,
    ok: 'حذف',
  });
  if (!ok) return;
  try {
    await api(`/chats/${chatId}/members/${u.id}`, { method: 'DELETE' });
    showToast('عضو حذف شد');
    await refreshInfoPane();
  } catch (e) {
    showToast(e.message);
  }
}

function bindInfoPane() {
  $('#info-back')?.addEventListener('click', closeInfoPane);

  $('#tab-btn-details')?.addEventListener('click', () => switchInfoTab('details'));
  $('#tab-btn-media')?.addEventListener('click', () => switchInfoTab('media'));

  $('.shared-media-subtabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sm-tab');
    if (btn) loadSharedMedia(btn.dataset.type);
  });

  $('#info-actions')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'add-member') openAddMembers();
    if (btn.dataset.act === 'edit') openEditModal();
  });

  $('#info-members')?.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.im-menu');
    if (!menuBtn) return;
    e.stopPropagation();
    const chat = state.chats.get(state.infoChatId);
    if (!chat) return;
    const uid = Number(menuBtn.dataset.uid);
    const target = (chat.members || []).find((u) => u.id === uid);
    if (!target) return;
    const rect = menuBtn.getBoundingClientRect();
    const items = [];
    if (target.role === 'member') {
      items.push({ label: 'ارتقا به مدیر', icon: ICONS.admin, action: () => setMemberRole(chat.id, uid, 'admin') });
    }
    if (target.role === 'admin' && chat.role === 'owner') {
      items.push({ label: 'سلب مدیریت', icon: ICONS.demote, action: () => setMemberRole(chat.id, uid, 'member') });
    }
    items.push({
      label: `حذف از ${chat.type === 'group' ? 'گروه' : 'کانال'}`,
      icon: ICONS.userRemove,
      danger: true,
      action: () => removeMember(chat.id, target, chat.type),
    });
    openMenu(items, rect.left, rect.bottom + 4);
  });

  $('#info-danger')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dact]');
    if (!btn) return;
    const chat = state.chats.get(state.infoChatId);
    if (!chat) return;
    if (btn.dataset.dact === 'leave') leaveChat(chat);
    if (btn.dataset.dact === 'clear') clearHistory(chat);
    if (btn.dataset.dact === 'delete') deleteChat(chat);
  });
}
