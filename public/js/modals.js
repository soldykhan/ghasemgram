'use strict';

/* ═══════════════ ماژول مودال‌ها، پنجره‌ها و تنظیمات (Modals & Drawers) ═══════════════ */

let myContacts = [];
let newChatSearched = [];

function openNewChatModal(type) {
  state.newChatType = type;
  state.newChatMembers = new Set();
  state.newChatAvatar = null;
  myContacts = [];
  newChatSearched = [];
  const titleEl = $('#modal-new-title');
  if (titleEl) titleEl.textContent = type === 'group' ? 'گروه جدید' : 'کانال جدید';
  const createBtn = $('#create-chat-btn');
  if (createBtn) createBtn.textContent = type === 'group' ? 'ساخت گروه' : 'ساخت کانال';
  const titleInput = $('#new-chat-title');
  if (titleInput) {
    titleInput.value = '';
    titleInput.placeholder = type === 'group' ? 'نام گروه' : 'نام کانال';
  }
  const usernameWrap = $('#new-channel-username-wrap');
  const usernameInput = $('#new-channel-username');
  if (usernameWrap) {
    if (type === 'channel') {
      usernameWrap.classList.remove('hidden');
      if (usernameInput) usernameInput.value = '';
    } else {
      usernameWrap.classList.add('hidden');
      if (usernameInput) usernameInput.value = '';
    }
  }
  const aboutInput = $('#new-chat-about');
  if (aboutInput) aboutInput.value = '';
  const filterInput = $('#member-filter');
  if (filterInput) filterInput.value = '';
  const avPreview = $('#new-avatar-preview');
  if (avPreview) avPreview.innerHTML = type === 'group' ? ICONS.group : ICONS.channel;
  $('#modal-new')?.classList.remove('hidden');
  titleInput?.focus();
  const listEl = $('#member-list');
  if (listEl) listEl.innerHTML = '<div class="empty-hint">در حال بارگذاری مخاطبین…</div>';

  api('/contacts')
    .then((r) => {
      myContacts = r.contacts || [];
      renderMemberList('');
    })
    .catch(() => {
      myContacts = [];
      renderMemberList('');
    });
}

function renderMemberList(filter) {
  const f = filter.trim().toLowerCase();
  const source = f.length >= 2 && newChatSearched.length ? newChatSearched : myContacts;
  const users = source.filter(
    (u) => !f || u.display_name.toLowerCase().includes(f) || u.username.toLowerCase().includes(f)
  );
  const listEl = $('#member-list');
  if (!listEl) return;
  if (!users.length) {
    if (!f) {
      listEl.innerHTML = `<div class="empty-hint">هنوز مخاطبی برای افزودن ندارید.<br><span style="font-size:12px;color:#8a97a3">تنها کاربرانی که با آن‌ها چت خصوصی داشته‌اید نمایش داده می‌شوند.</span></div>`;
    } else {
      listEl.innerHTML = `<div class="empty-hint">مخاطبی پیدا نشد</div>`;
    }
    return;
  }
  listEl.innerHTML = users
    .map(
      (u) => `
    <label class="member-row">
      ${avatarHTML(u)}
      <span class="mr-name">${esc(u.display_name)}</span>
      <span class="mr-uname">@${esc(u.username)}</span>
      <input type="checkbox" value="${u.id}" ${state.newChatMembers.has(u.id) ? 'checked' : ''}>
    </label>`
    )
    .join('');
}

function bindNewChatModal() {
  let newChatFilterTimer = null;
  $('#member-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(newChatFilterTimer);
    if (q.length < 2) {
      newChatSearched = [];
      renderMemberList(q);
      return;
    }
    renderMemberList(q);
    newChatFilterTimer = setTimeout(async () => {
      try {
        const r = await api('/search/users?q=' + encodeURIComponent(q));
        if ($('#member-filter')?.value.trim() === q) {
          newChatSearched = r.users || [];
          renderMemberList(q);
        }
      } catch {}
    }, 250);
  });

  $('#member-list')?.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.type !== 'checkbox') return;
    const id = Number(cb.value);
    if (cb.checked) state.newChatMembers.add(id);
    else state.newChatMembers.delete(id);
  });

  const wrap = $('#new-avatar-wrap');
  const inp = $('#new-avatar-input');
  const prev = $('#new-avatar-preview');
  if (wrap && inp && prev) {
    bindAvatarPicker(wrap, inp, prev, (f) => (state.newChatAvatar = f));
  }

  $('#create-chat-btn')?.addEventListener('click', async () => {
    const btn = $('#create-chat-btn');
    const title = $('#new-chat-title')?.value.trim();
    if (!title) {
      $('#new-chat-title')?.focus();
      return;
    }
    const username = $('#new-channel-username')?.value.trim().toLowerCase().replace(/^@/, '');
    if (state.newChatType === 'channel') {
      if (!username) {
        showToast('وارد کردن شناسه کاربری (یوزرنیم) برای کانال الزامی است');
        $('#new-channel-username')?.focus();
        return;
      }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        showToast('شناسه کاربری باید بین ۳ تا ۲۴ کاراکتر انگلیسی، عدد یا زیرخط باشد');
        $('#new-channel-username')?.focus();
        return;
      }
    }
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.set('type', state.newChatType);
      fd.set('title', title);
      if (state.newChatType === 'channel') {
        fd.set('username', username);
      }
      fd.set('about', $('#new-chat-about')?.value.trim() || '');
      fd.set('member_ids', JSON.stringify([...state.newChatMembers]));
      if (state.newChatAvatar) fd.set('avatar', state.newChatAvatar);
      const r = await api('/chats', { method: 'POST', formData: fd });
      state.chats.set(r.chat.id, r.chat);
      closeModals();
      renderSidebar();
      openChat(r.chat.id);
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ═══════════════ مودال ویرایش گفتگو ═══════════════ */

function openEditModal() {
  const c = state.chats.get(state.infoChatId);
  if (!c) return;
  state.editAvatar = null;
  const titleInp = $('#edit-title');
  if (titleInp) titleInp.value = c.title;
  const aboutInp = $('#edit-about');
  if (aboutInp) aboutInp.value = c.about || '';
  const userWrap = $('#edit-channel-username-wrap');
  const userInp = $('#edit-channel-username');
  if (userWrap) {
    if (c.type === 'channel') {
      userWrap.classList.remove('hidden');
      if (userInp) userInp.value = c.username || '';
    } else {
      userWrap.classList.add('hidden');
      if (userInp) userInp.value = '';
    }
  }
  const prev = $('#edit-avatar-preview');
  if (prev) {
    prev.innerHTML = avatarHTML({
      id: c.id,
      title: c.title,
      avatar_url: c.avatar_url,
      icon: c.type === 'group' ? ICONS.group : ICONS.channel,
    });
  }
  $('#modal-edit')?.classList.remove('hidden');
}

function bindEditModal() {
  const wrap = $('#edit-avatar-wrap');
  const inp = $('#edit-avatar-input');
  const prev = $('#edit-avatar-preview');
  if (wrap && inp && prev) {
    bindAvatarPicker(wrap, inp, prev, (f) => (state.editAvatar = f));
  }
  $('#edit-save-btn')?.addEventListener('click', async () => {
    const btn = $('#edit-save-btn');
    const chatId = state.infoChatId;
    if (!chatId) return;
    const title = $('#edit-title')?.value.trim();
    if (!title) {
      $('#edit-title')?.focus();
      return;
    }
    const c = state.chats.get(chatId);
    let username = null;
    if (c && c.type === 'channel') {
      username = $('#edit-channel-username')?.value.trim().toLowerCase().replace(/^@/, '');
      if (!username) {
        showToast('شناسه کاربری کانال الزامی است');
        $('#edit-channel-username')?.focus();
        return;
      }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        showToast('شناسه کاربری باید بین ۳ تا ۲۴ کاراکتر انگلیسی، عدد یا زیرخط باشد');
        $('#edit-channel-username')?.focus();
        return;
      }
    }
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.set('title', title);
      if (username) fd.set('username', username);
      fd.set('about', $('#edit-about')?.value.trim() || '');
      if (state.editAvatar) fd.set('avatar', state.editAvatar);
      const r = await api(`/chats/${chatId}`, { method: 'PUT', formData: fd });
      state.chats.set(r.chat.id, r.chat);
      closeModals();
      renderSidebar();
      if (state.activeChatId === chatId) renderChatHeader(r.chat);
      await refreshInfoPane();
      showToast('ذخیره شد ✅');
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ═══════════════ مودال افزودن عضو ═══════════════ */

let addContacts = [];
let addSearched = [];

function openAddMembers() {
  const chat = state.chats.get(state.infoChatId);
  if (!chat) return;
  state.addSelected = new Set();
  addContacts = [];
  addSearched = [];
  const filterInput = $('#add-filter');
  if (filterInput) filterInput.value = '';
  const list = $('#add-list');
  if (list) list.innerHTML = '<div class="empty-hint">در حال بارگذاری مخاطبین…</div>';
  $('#modal-add')?.classList.remove('hidden');

  api('/contacts')
    .then((r) => {
      const current = new Set((chat.members || []).map((mm) => mm.id));
      addContacts = (r.contacts || []).filter((u) => !current.has(u.id));
      renderAddList('');
    })
    .catch(() => {
      addContacts = [];
      renderAddList('');
    });
}

function renderAddList(filter) {
  const chat = state.chats.get(state.infoChatId);
  const current = new Set((chat?.members || []).map((mm) => mm.id));
  const f = filter.trim().toLowerCase();
  const source = f.length >= 2 && addSearched.length ? addSearched : addContacts;
  const users = source.filter(
    (u) => !current.has(u.id) && (!f || u.display_name.toLowerCase().includes(f) || u.username.toLowerCase().includes(f))
  );
  const list = $('#add-list');
  if (!list) return;
  if (!users.length) {
    if (!f) {
      list.innerHTML = `<div class="empty-hint">مخاطب جدیدی برای افزودن نیست.<br><span style="font-size:12px;color:#8a97a3">تنها کاربرانی که با آن‌ها چت خصوصی داشته‌اید نمایش داده می‌شوند.</span></div>`;
    } else {
      list.innerHTML = `<div class="empty-hint">کاربری پیدا نشد</div>`;
    }
    return;
  }
  list.innerHTML = users
    .map(
      (u) => `
    <label class="member-row">
      ${avatarHTML(u)}
      <span class="mr-name">${esc(u.display_name)}</span>
      <span class="mr-uname">@${esc(u.username)}</span>
      <input type="checkbox" value="${u.id}" ${state.addSelected.has(u.id) ? 'checked' : ''}>
    </label>`
    )
    .join('');
}

function bindAddModal() {
  let addFilterTimer = null;
  $('#add-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(addFilterTimer);
    if (q.length < 2) {
      addSearched = [];
      renderAddList(q);
      return;
    }
    renderAddList(q);
    addFilterTimer = setTimeout(async () => {
      try {
        const r = await api('/search/users?q=' + encodeURIComponent(q));
        if ($('#add-filter')?.value.trim() === q) {
          addSearched = r.users || [];
          renderAddList(q);
        }
      } catch {}
    }, 250);
  });
  $('#add-list')?.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.type !== 'checkbox') return;
    const id = Number(cb.value);
    if (cb.checked) state.addSelected.add(id);
    else state.addSelected.delete(id);
  });
  $('#add-save-btn')?.addEventListener('click', async () => {
    const btn = $('#add-save-btn');
    const chatId = state.infoChatId;
    if (!chatId || !state.addSelected.size) {
      showToast('حداقل یک کاربر را انتخاب کنید');
      return;
    }
    btn.disabled = true;
    try {
      const r = await api(`/chats/${chatId}/members`, {
        method: 'POST',
        body: { user_ids: [...state.addSelected] },
      });
      closeModals();
      showToast(`${faNum(r.added)} عضو اضافه شد ✅`);
      await refreshInfoPane();
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ═══════════════ مودال فوروارد ═══════════════ */

function openForwardModal(m) {
  state.forwarding = m;
  const filterInp = $('#forward-filter');
  if (filterInp) filterInp.value = '';
  renderForwardList('');
  $('#modal-forward')?.classList.remove('hidden');
}

function renderForwardList(filter) {
  const f = filter.trim().toLowerCase();
  const chats = [...state.chats.values()]
    .filter((c) => canPostIn(c))
    .filter((c) => !f || chatName(c).toLowerCase().includes(f))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updated_at || 0) - (a.updated_at || 0));
  const list = $('#forward-list');
  if (!list) return;
  list.innerHTML =
    chats
      .map(
        (c) => `
    <div class="chat-item" data-id="${c.id}">
      ${
        c.type === 'private'
          ? avatarHTML(c.peer || {})
          : avatarHTML({ id: c.id, title: c.title, avatar_url: c.avatar_url, icon: c.type === 'group' ? ICONS.group : ICONS.channel })
      }
      <div class="ci-main">
        <div class="ci-row"><span class="ci-name">${esc(chatName(c))}</span></div>
        <div class="ci-row"><span class="ci-preview">${c.type === 'group' ? 'گروه' : c.type === 'channel' ? 'کانال' : 'چت خصوصی'}</span></div>
      </div>
    </div>`
      )
      .join('') || '<div class="empty-hint">گفتگویی برای فوروارد نیست</div>';
}

function bindForwardModal() {
  $('#forward-filter')?.addEventListener('input', (e) => renderForwardList(e.target.value));
  $('#forward-list')?.addEventListener('click', async (e) => {
    const item = e.target.closest('.chat-item');
    if (!item || !state.forwarding) return;
    try {
      await api(`/chats/${item.dataset.id}/forward`, {
        method: 'POST',
        body: { message_id: state.forwarding.id },
      });
      state.forwarding = null;
      closeModals();
      showToast('فوروارد شد ✅');
    } catch (e2) {
      showToast(e2.message);
    }
  });
}

/* ═══════════════ مودال پروفایل، بیوگرافی و حریم خصوصی ═══════════════ */

function openProfileModal() {
  state.profAvatar = null;
  const disp = $('#prof-display');
  if (disp) disp.value = state.me?.display_name || '';
  const uname = $('#prof-username');
  if (uname) uname.value = '@' + (state.me?.username || '');
  const bio = $('#prof-bio');
  if (bio) bio.value = state.me?.bio || '';
  const priv = $('#prof-privacy');
  if (priv) priv.value = state.me?.privacy_last_seen || 'everyone';
  const prev = $('#prof-avatar-preview');
  if (prev && state.me) prev.innerHTML = avatarHTML(state.me);
  $('#modal-profile')?.classList.remove('hidden');
}

function bindProfileModal() {
  const wrap = $('#prof-avatar-wrap');
  const inp = $('#prof-avatar-input');
  const prev = $('#prof-avatar-preview');
  if (wrap && inp && prev) {
    bindAvatarPicker(wrap, inp, prev, (f) => (state.profAvatar = f));
  }

  $('#prof-blocked-btn')?.addEventListener('click', () => {
    closeModals();
    openBlockedUsersModal();
  });

  $('#prof-save-btn')?.addEventListener('click', async () => {
    const btn = $('#prof-save-btn');
    const display_name = $('#prof-display')?.value.trim();
    const bio = $('#prof-bio')?.value.trim() || '';
    const privacy_last_seen = $('#prof-privacy')?.value || 'everyone';

    if (!display_name) {
      $('#prof-display')?.focus();
      return;
    }
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.set('display_name', display_name);
      fd.set('bio', bio);
      fd.set('privacy_last_seen', privacy_last_seen);
      if (state.profAvatar) fd.set('avatar', state.profAvatar);
      state.me = await api('/me', { method: 'PUT', formData: fd });
      renderProfileChip();
      renderSettingsDrawer();
      closeModals();
      showToast('تغییرات ذخیره شد ✅');
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ═══════════════ پنل تنظیمات کاربر (Settings Drawer) ═══════════════ */

function renderSettingsDrawer() {
  if (!state.me) return;
  const avEl = $('#settings-avatar');
  if (avEl) avEl.innerHTML = avatarHTML(state.me, 'large');
  const nameEl = $('#settings-name');
  if (nameEl) nameEl.textContent = state.me.display_name || '';
  const unameEl = $('#settings-uname');
  if (unameEl) unameEl.textContent = `@${state.me.username || ''}`;
  const bioEl = $('#settings-bio-text');
  if (bioEl) bioEl.textContent = state.me.bio || 'بیوگرافی خود را تنظیم کنید...';
  const themeVal = $('#settings-theme-value');
  if (themeVal) themeVal.textContent = state.theme === 'dark' ? 'حالت شب' : 'حالت روز';
}

function openSettingsDrawer() {
  renderSettingsDrawer();
  const drawer = $('#settings-drawer');
  if (drawer) {
    drawer.classList.remove('hidden');
    requestAnimationFrame(() => {
      drawer.classList.add('open');
    });
  }
  $('#menu-dropdown')?.classList.add('hidden');
  $('#fab-menu')?.classList.add('hidden');
}

function closeSettingsDrawer() {
  const drawer = $('#settings-drawer');
  if (drawer) {
    drawer.classList.remove('open');
    setTimeout(() => {
      if (!drawer.classList.contains('open')) {
        drawer.classList.add('hidden');
      }
    }, 270);
  }
}

/* ═══════════════ مودال دستگاه‌های من ═══════════════ */

async function openDevicesModal() {
  closeSettingsDrawer();
  const modal = $('#modal-devices');
  if (!modal) return;
  modal.classList.remove('hidden');
  await renderDevicesList();
}

async function renderDevicesList() {
  const currentBox = $('#current-device-container');
  const otherBox = $('#other-devices-list');
  if (!currentBox || !otherBox) return;

  currentBox.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px;">در حال بارگذاری...</div>';
  otherBox.innerHTML = '';

  try {
    const data = await api('/sessions');
    const sessions = data.sessions || [];

    const current = sessions.find((s) => s.is_current);
    const others = sessions.filter((s) => !s.is_current);

    if (current) {
      const dev = current.device || {};
      const icon = dev.is_mobile ? '📱' : '💻';
      currentBox.innerHTML = `
        <div class="device-card current">
          <div class="device-card-main">
            <div class="device-icon">${icon}</div>
            <div class="device-info">
              <div class="device-name">${esc(dev.browser)} — ${esc(dev.os)}</div>
              <div class="device-meta">ورود: ${dayLabel(current.created_at)} ساعت ${faTime(current.created_at)} ${current.ip ? '· ' + esc(current.ip) : ''}</div>
            </div>
          </div>
          <span class="badge-current-device">نشست کنونی (آنلاین)</span>
        </div>`;
    } else {
      currentBox.innerHTML = '<div class="no-devices">دستگاه کنونی یافت نشد.</div>';
    }

    if (!others.length) {
      otherBox.innerHTML = '<div class="no-devices">هیچ دستگاه متصل دیگری وجود ندارد.</div>';
    } else {
      otherBox.innerHTML = others
        .map((s) => {
          const dev = s.device || {};
          const icon = dev.is_mobile ? '📱' : '💻';
          return `
          <div class="device-card" data-sid="${s.id}">
            <div class="device-card-main">
              <div class="device-icon">${icon}</div>
              <div class="device-info">
                <div class="device-name">${esc(dev.browser)} — ${esc(dev.os)}</div>
                <div class="device-meta">ورود: ${dayLabel(s.created_at)} ساعت ${faTime(s.created_at)} ${s.ip ? '· ' + esc(s.ip) : ''}</div>
              </div>
            </div>
            <button type="button" class="btn-terminate-device" onclick="terminateSession('${s.id}')">
              پایان اتصال
            </button>
          </div>`;
        })
        .join('');
    }
  } catch (e) {
    currentBox.innerHTML = `<div class="auth-error">${esc(e.message)}</div>`;
  }
}

async function terminateSession(id) {
  if (!confirm('آیا از قطع اتصال این دستگاه اطمینان دارید؟')) return;
  try {
    await api('/sessions/' + id, { method: 'DELETE' });
    showToast('اتصال دستگاه موردنظر بسته شد.');
    await renderDevicesList();
  } catch (e) {
    showToast(e.message);
  }
}

async function terminateOtherSessions() {
  if (!confirm('آیا از بستن تمام دستگاه‌های دیگر اطمینان دارید؟\nتمام نشست‌های فعال دیگر بسته شده و از آن‌ها خارج خواهید شد.')) return;
  try {
    await api('/sessions/terminate-others', { method: 'POST' });
    showToast('تمامی سایر دستگاه‌ها با موفقیت بسته شدند ✅');
    await renderDevicesList();
  } catch (e) {
    showToast(e.message);
  }
}

function bindSettingsDrawer() {
  $('#settings-close-btn')?.addEventListener('click', closeSettingsDrawer);
  $('#settings-backdrop')?.addEventListener('click', closeSettingsDrawer);

  $('#settings-qr-btn')?.addEventListener('click', () => {
    showToast(`کد کاربری: @${state.me?.username || ''} 📲`);
  });

  $('#settings-edit-profile-btn')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openProfileModal();
  });

  $('#item-profile')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openProfileModal();
  });

  $('#settings-bio-banner')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openProfileModal();
  });

  $('#item-saved')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openSavedMessages();
  });

  $('#item-devices')?.addEventListener('click', () => {
    openDevicesModal();
  });

  $('#btn-terminate-other-sessions')?.addEventListener('click', terminateOtherSessions);

  $('#item-theme')?.addEventListener('click', () => {
    toggleTheme();
    renderSettingsDrawer();
  });

  $('#item-privacy')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openProfileModal();
  });

  $('#item-blocked')?.addEventListener('click', () => {
    closeSettingsDrawer();
    openBlockedUsersModal();
  });

  $('#item-logout')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'خروج از حساب',
      text: 'آیا می‌خواهید از حساب خود خارج شوید؟',
      ok: 'خروج',
    });
    if (!ok) return;
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}
    localStorage.removeItem('gg_token');
    location.reload();
  });
}

/* ═══════════════ مودال‌ها و لایت‌باکس ═══════════════ */

function closeModals() {
  $$('.modal-overlay').forEach((el) => el.classList.add('hidden'));
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }
}

function openLightbox(src) {
  const img = $('#lightbox-img');
  if (img) img.src = src;
  const lb = $('#lightbox');
  if (lb) {
    lb.classList.remove('hidden');
  }
}

function bindOverlays() {
  $$('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeModals();
    });
  });
  $$('.modal-close').forEach((btn) => btn.addEventListener('click', closeModals));
  $('#confirm-ok')?.addEventListener('click', () => settleConfirm(true));
  $('#confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  $('#lightbox')?.addEventListener('click', () => $('#lightbox')?.classList.add('hidden'));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-dropdown') && !e.target.closest('#menu-btn')) {
      $('#menu-dropdown')?.classList.add('hidden');
    }
    if (!e.target.closest('#fab-menu') && !e.target.closest('#fab')) {
      $('#fab-menu')?.classList.add('hidden');
    }
    if (!e.target.closest('#media-drawer') && !e.target.closest('#emoji-btn')) {
      $('#media-drawer')?.classList.add('hidden');
    }
    if (!e.target.closest('#send-popover') && !e.target.closest('#send-btn')) {
      $('#send-popover')?.classList.add('hidden');
    }
    if (!e.target.closest('#ctx-menu') && !e.target.closest('#attach-btn')) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeModals();
      closeSettingsDrawer();
      $('#lightbox')?.classList.add('hidden');
      $('#media-drawer')?.classList.add('hidden');
      $('#send-popover')?.classList.add('hidden');
      if (state.infoChatId) closeInfoPane();
    }
  });
}

/* ═══════════════ جستجو درون گفتگو ═══════════════ */

let chatSearchMatches = [];
let chatSearchCurrentIndex = -1;

function openChatSearch() {
  $('#chat-search-bar')?.classList.remove('hidden');
  const input = $('#chat-search-input');
  if (input) {
    input.focus();
    input.select();
  }
  performChatSearch();
}

function closeChatSearch() {
  $('#chat-search-bar')?.classList.add('hidden');
  const input = $('#chat-search-input');
  if (input) input.value = '';
  const count = $('#chat-search-count');
  if (count) count.textContent = '';
  clearChatSearchHighlights();
  chatSearchMatches = [];
  chatSearchCurrentIndex = -1;
}

function clearChatSearchHighlights() {
  $$('#messages .msg.searched').forEach((el) => el.classList.remove('searched'));
}

function performChatSearch() {
  const q = $('#chat-search-input')?.value.trim().toLowerCase();
  clearChatSearchHighlights();
  chatSearchMatches = [];
  chatSearchCurrentIndex = -1;

  if (!q || !state.activeChatId) {
    const count = $('#chat-search-count');
    if (count) count.textContent = '';
    return;
  }

  const msgs = state.messagesByChat.get(state.activeChatId) || [];
  msgs.forEach((m) => {
    if (m.text && m.text.toLowerCase().includes(q)) {
      chatSearchMatches.push(m.id);
    }
  });

  const count = $('#chat-search-count');
  if (!chatSearchMatches.length) {
    if (count) count.textContent = 'یافت نشد';
    return;
  }

  chatSearchCurrentIndex = chatSearchMatches.length - 1;
  highlightCurrentChatSearchMatch();
}

function highlightCurrentChatSearchMatch() {
  clearChatSearchHighlights();
  if (chatSearchCurrentIndex < 0 || chatSearchCurrentIndex >= chatSearchMatches.length) return;
  const targetId = chatSearchMatches[chatSearchCurrentIndex];
  const count = $('#chat-search-count');
  if (count) count.textContent = `${faNum(chatSearchCurrentIndex + 1)} از ${faNum(chatSearchMatches.length)}`;

  const msgEl = $(`#messages .msg[data-id="${targetId}"]`);
  if (msgEl) {
    msgEl.classList.add('searched');
    msgEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    goToMessage(targetId);
  }
}

function nextChatSearchMatch() {
  if (!chatSearchMatches.length) return;
  chatSearchCurrentIndex = (chatSearchCurrentIndex + 1) % chatSearchMatches.length;
  highlightCurrentChatSearchMatch();
}

function prevChatSearchMatch() {
  if (!chatSearchMatches.length) return;
  chatSearchCurrentIndex = (chatSearchCurrentIndex - 1 + chatSearchMatches.length) % chatSearchMatches.length;
  highlightCurrentChatSearchMatch();
}

function bindChatSearch() {
  $('#chat-search-btn')?.addEventListener('click', () => {
    const isHidden = $('#chat-search-bar')?.classList.contains('hidden');
    if (isHidden) openChatSearch();
    else closeChatSearch();
  });
  $('#chat-search-close')?.addEventListener('click', closeChatSearch);
  $('#chat-search-next')?.addEventListener('click', nextChatSearchMatch);
  $('#chat-search-prev')?.addEventListener('click', prevChatSearchMatch);
  $('#chat-search-input')?.addEventListener('input', performChatSearch);
  $('#chat-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prevChatSearchMatch();
      else nextChatSearchMatch();
    } else if (e.key === 'Escape') {
      closeChatSearch();
    }
  });
}

/* ═══════════════ مودال عضویت با لینک دعوت ═══════════════ */

let joinPreviewData = null;

function parseInviteCode(str) {
  if (!str) return '';
  const trimmed = str.trim();
  const hashIdx = trimmed.indexOf('#join/');
  if (hashIdx !== -1) return trimmed.slice(hashIdx + 6).replace(/[^a-zA-Z0-9_@-]/g, '');
  const slashIdx = trimmed.lastIndexOf('/');
  if (slashIdx !== -1) return trimmed.slice(slashIdx + 1).replace(/[^a-zA-Z0-9_@-]/g, '');
  return trimmed.replace(/[^a-zA-Z0-9_@-]/g, '');
}

function openJoinModal(initialCode = '') {
  joinPreviewData = null;
  const input = $('#join-input');
  if (input) input.value = initialCode || '';
  $('#join-preview')?.classList.add('hidden');
  const preview = $('#join-preview');
  if (preview) preview.innerHTML = '';
  $('#join-error')?.classList.add('hidden');
  $('#join-confirm-btn')?.classList.add('hidden');
  $('#modal-join')?.classList.remove('hidden');
  if (initialCode) checkInviteCode();
  else input?.focus();
}

async function checkInviteCode() {
  const raw = $('#join-input')?.value.trim();
  const code = parseInviteCode(raw);
  const errBox = $('#join-error');
  const previewBox = $('#join-preview');
  const confirmBtn = $('#join-confirm-btn');

  errBox?.classList.add('hidden');
  previewBox?.classList.add('hidden');
  confirmBtn?.classList.add('hidden');

  if (!code) {
    if (errBox) {
      errBox.textContent = 'لطفاً کد یا لینک معتبر وارد کنید';
      errBox.classList.remove('hidden');
    }
    return;
  }

  try {
    const preview = await api(`/chats/join/${code}`);
    joinPreviewData = { code, ...preview };
    if (previewBox) {
      previewBox.innerHTML = `
        ${avatarHTML({ id: preview.id, title: preview.title, avatar_url: preview.avatar_url, icon: preview.type === 'group' ? ICONS.group : ICONS.channel })}
        <div class="join-preview-info">
          <h4>${esc(preview.title)}</h4>
          <div class="join-meta">${faNum(preview.member_count)} عضو · ${preview.type === 'group' ? 'گروه' : 'کانال'}</div>
          ${preview.about ? `<p class="join-about">${esc(preview.about)}</p>` : ''}
        </div>`;
      previewBox.classList.remove('hidden');
    }
    confirmBtn?.classList.remove('hidden');
    confirmBtn?.focus();
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message || 'لینک دعوت نامعتبر است یا منقضی شده است';
      errBox.classList.remove('hidden');
    }
  }
}

async function confirmJoinChat() {
  if (!joinPreviewData) return;
  const btn = $('#join-confirm-btn');
  btn.disabled = true;
  try {
    const r = await api(`/chats/join/${joinPreviewData.code}`, { method: 'POST' });
    closeModals();
    showToast('با موفقیت عضو شدید ✅');
    if (r.chat) state.chats.set(r.chat.id, r.chat);
    renderSidebar();
    openChat(r.chat_id || r.chat?.id);
    if (window.location.hash.startsWith('#join/')) {
      history.replaceState(null, '', window.location.pathname);
    }
  } catch (err) {
    const errBox = $('#join-error');
    if (errBox) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
  }
}

function bindJoinModal() {
  $('#join-check-btn')?.addEventListener('click', checkInviteCode);
  $('#join-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkInviteCode();
    }
  });
  $('#join-confirm-btn')?.addEventListener('click', confirmJoinChat);
}

function checkUrlHash() {
  if (window.location.hash.startsWith('#join/')) {
    const code = window.location.hash.slice(6);
    if (code) openJoinModal(code);
  }
}

/* ═══════════════ نظرسنجی جدید (New Poll Modal) ═══════════════ */

function bindPollModal() {
  $('#poll-add-opt-btn')?.addEventListener('click', () => {
    const list = $('#poll-options-list');
    if (!list) return;
    const count = list.querySelectorAll('.poll-opt-input').length + 1;
    if (count > 10) {
      showToast('حداکثر ۱۰ گزینه مجاز است');
      return;
    }
    const inp = document.createElement('input');
    inp.className = 'poll-opt-input';
    inp.placeholder = `گزینه ${faNum(count)}`;
    list.appendChild(inp);
    inp.focus();
  });

  $('#poll-create-btn')?.addEventListener('click', async () => {
    const question = $('#poll-question')?.value.trim();
    if (!question) {
      $('#poll-question')?.focus();
      return;
    }
    const options = $$('.poll-opt-input')
      .map((i) => i.value.trim())
      .filter(Boolean);
    if (options.length < 2) {
      showToast('حداقل ۲ گزینه وارد کنید');
      return;
    }
    const is_anonymous = $('#poll-anonymous')?.checked;
    const is_multiple = $('#poll-multiple')?.checked;

    try {
      await api(`/chats/${state.activeChatId}/polls`, {
        method: 'POST',
        body: { question, options, is_anonymous, is_multiple },
      });
      closeModals();
      showToast('نظرسنجی ایجاد شد 📊');
    } catch (e) {
      showToast(e.message);
    }
  });
}

/* ═══════════════ تاپیک جدید (New Topic Modal) ═══════════════ */

function bindTopicModal() {
  $('#topic-create-btn')?.addEventListener('click', async () => {
    const title = $('#topic-title')?.value.trim();
    const icon = $('#topic-icon')?.value.trim() || '💬';
    if (!title) {
      $('#topic-title')?.focus();
      return;
    }
    try {
      await api(`/chats/${state.activeChatId}/topics`, {
        method: 'POST',
        body: { title, icon },
      });
      closeModals();
      const titleInput = $('#topic-title');
      if (titleInput) titleInput.value = '';
      loadTopics(state.activeChatId);
      showToast('تاپیک جدید ایجاد شد ✅');
    } catch (e) {
      showToast(e.message);
    }
  });
}

/* ═══════════════ پس‌زمینه گفتگوها (Wallpaper Modal) ═══════════════ */

function bindWallpaperModal() {
  $('#wallpaper-grid')?.addEventListener('click', (e) => {
    const card = e.target.closest('.wp-card');
    if (!card) return;
    const wp = card.dataset.wp;
    state.wallpaper = wp;
    localStorage.setItem('gg_wallpaper', wp);
    applyWallpaper(wp);
    closeModals();
    showToast('پس‌زمینه تغییر کرد 🎨');
  });
}

/* ═══════════════ کاربران مسدودشده (Blocked Users) ═══════════════ */

async function openBlockedUsersModal() {
  try {
    const r = await api('/me/blocked');
    const list = $('#blocked-users-list');
    if (!list) return;
    if (!r.blocked || !r.blocked.length) {
      list.innerHTML = '<div class="empty-hint">هیچ کاربری در لیست مسدودها نیست</div>';
    } else {
      list.innerHTML = r.blocked
        .map(
          (u) => `
        <div class="member-row" data-uid="${u.id}">
          ${avatarHTML(u)}
          <span class="mr-name">${esc(u.display_name)}</span>
          <span class="mr-uname">@${esc(u.username)}</span>
          <button class="btn-ghost sm unblock-btn" data-uid="${u.id}">رفع مسدودی</button>
        </div>
      `
        )
        .join('');
      $$('.unblock-btn', list).forEach((btn) => {
        btn.onclick = async () => {
          const uid = Number(btn.dataset.uid);
          await api(`/users/${uid}/unblock`, { method: 'POST' });
          showToast('کاربر از مسدودی خارج شد');
          openBlockedUsersModal();
        };
      });
    }
    $('#modal-blocked')?.classList.remove('hidden');
  } catch (e) {
    showToast(e.message);
  }
}
