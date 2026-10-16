'use strict';

/* ═══════════════ ماژول پیام‌ها و حباب‌های گفتگو (Messages & Bubbles) ═══════════════ */

async function loadMessages(chatId, before) {
  const qTopic = state.activeTopicId ? `&topic_id=${state.activeTopicId}` : '';
  const q = before ? `&before=${before}` : '';
  const r = await api(`/chats/${chatId}/messages?limit=50${q}${qTopic}`);
  if (r.max_peer_read_id != null) {
    state.peerReads.set(chatId, Math.max(state.peerReads.get(chatId) || 0, Number(r.max_peer_read_id)));
  }
  r.messages.forEach((m) => state.seen.add(m.id));
  if (before) {
    const store = state.messagesByChat.get(chatId) || [];
    const seenIds = new Set(store.map((x) => x.id));
    const older = r.messages.filter((x) => !seenIds.has(x.id));
    store.unshift(...older);
    state.messagesByChat.set(chatId, store);
  } else {
    state.messagesByChat.set(chatId, r.messages);
  }
  state.noMore.set(chatId, r.messages.length < 50);
  return r.messages;
}

function timeWithChecks(chat, m) {
  const t = faTime(m.created_at);
  const editedTag = m.edited_at ? '<span class="msg-edited-tag">(ویرایش)</span>' : '';
  if (m.sender.id !== state.me?.id) {
    return `${t}${editedTag}`;
  }
  // در گفتگوی پیام‌های ذخیره‌شده تیک نیاز نیست
  if (chat && (chat.is_saved || chat.type === 'saved')) {
    return `${t}${editedTag}`;
  }
  // پیام ارسالی خودمان در چت خصوصی و گروه - نمایش وضعیت با تیک دوگانه تلگرام
  const cid = Number(m.chat_id || chat?.id);
  const peerRead = Number(state.peerReads.get(cid) || 0);
  const read = peerRead >= Number(m.id);
  const ticks = read
    ? `<span class="msg-ticks read" title="خوانده شد">${doubleCheckSVG()}</span>`
    : `<span class="msg-ticks delivered" title="ارسال شد">${singleCheckSVG()}</span>`;
  return `${t}${editedTag}${ticks}`;
}

function reactionsHTML(m) {
  if (!m.reactions || !m.reactions.length) return '';
  const pills = m.reactions
    .map(
      (r) => `
    <button type="button" class="reaction-pill${r.me ? ' active' : ''}" data-mid="${m.id}" data-rx="${esc(r.emoji)}" title="${r.me ? 'حذف واکنش' : 'ثبت واکنش'}">
      <span>${esc(r.emoji)}</span><span class="rx-count">${faNum(r.count)}</span>
    </button>`
    )
    .join('');
  return `<div class="msg-reactions">${pills}</div>`;
}

function updateMessageReactionsDOM(messageId, reactions) {
  const msgEl = $(`#messages .msg[data-id="${messageId}"]`);
  if (!msgEl) return;
  const dummyM = { id: messageId, reactions };
  const newHTML = reactionsHTML(dummyM);
  let rxBox = msgEl.querySelector('.msg-reactions');
  if (rxBox) {
    if (!reactions || !reactions.length) {
      rxBox.remove();
    } else {
      rxBox.outerHTML = newHTML;
    }
  } else if (newHTML) {
    const bubble = msgEl.querySelector('.bubble');
    if (bubble) {
      const timeEl = bubble.querySelector('.msg-time');
      if (timeEl) timeEl.insertAdjacentHTML('beforebegin', newHTML);
      else bubble.insertAdjacentHTML('beforeend', newHTML);
    }
  }
}

async function toggleReaction(messageId, emoji) {
  try {
    const r = await api(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: { emoji },
    });
    for (const [cid, msgs] of state.messagesByChat.entries()) {
      const target = msgs.find((m) => m.id === messageId);
      if (target) {
        target.reactions = r.reactions;
        if (Number(state.activeChatId) === Number(cid)) {
          updateMessageReactionsDOM(messageId, r.reactions);
        }
        break;
      }
    }
  } catch (err) {
    showToast(err.message);
  }
}

/* ═══════════════ نظرسنجی‌ها (Polls & Quizzes) ═══════════════ */

function pollHTML(poll) {
  if (!poll) return '';
  const totalVotes = poll.total_votes || 0;
  const isVoted = (poll.my_votes || []).length > 0;
  const optionsHTML = (poll.options || []).map((opt) => {
    const isMyPick = (poll.my_votes || []).includes(opt.id);
    const pct = totalVotes > 0 ? Math.round((opt.vote_count / totalVotes) * 100) : 0;
    return `
    <div class="poll-option${isMyPick ? ' voted' : ''}" data-poll-id="${poll.id}" data-opt-id="${opt.id}">
      <div class="poll-opt-bar" style="width: ${pct}%"></div>
      <div class="poll-opt-content">
        <span class="poll-opt-text">${isMyPick ? '✓ ' : ''}${esc(opt.text)}</span>
        <span class="poll-opt-pct">${faNum(pct)}٪ (${faNum(opt.vote_count)})</span>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="poll-card" data-poll-id="${poll.id}">
    <div class="poll-header">
      <span class="poll-icon">📊</span>
      <span class="poll-question">${esc(poll.question)}</span>
    </div>
    <div class="poll-meta">
      <span>${poll.is_anonymous ? 'نظرسنجی ناشناس' : 'نظرسنجی عمومی'}</span> · 
      <span>${poll.is_multiple ? 'امکان انتخاب چند گزینه' : 'تک‌گزینه‌ای'}</span>
    </div>
    <div class="poll-options">${optionsHTML}</div>
    <div class="poll-footer">
      <span>${faNum(totalVotes)} رای</span>
      ${isVoted ? `<button type="button" class="poll-retract-btn btn-ghost sm" data-poll-id="${poll.id}">پس گرفتن رای</button>` : ''}
    </div>
  </div>`;
}

function updatePollInStore(poll) {
  for (const [cid, msgs] of state.messagesByChat.entries()) {
    const target = msgs.find((m) => m.poll && m.poll.id === poll.id);
    if (target) {
      target.poll = poll;
      if (Number(state.activeChatId) === Number(cid)) {
        const card = $(`#messages .poll-card[data-poll-id="${poll.id}"]`);
        if (card) {
          card.outerHTML = pollHTML(poll);
        }
      }
      break;
    }
  }
}

async function votePoll(pollId, optionId, retract = false) {
  try {
    let optionIds = [];
    if (!retract) {
      const msgs = state.messagesByChat.get(state.activeChatId) || [];
      const m = msgs.find((mm) => mm.poll && mm.poll.id === pollId);
      if (m && m.poll) {
        if (m.poll.is_multiple) {
          const current = new Set(m.poll.my_votes || []);
          if (current.has(optionId)) current.delete(optionId);
          else current.add(optionId);
          optionIds = [...current];
        } else {
          optionIds = [optionId];
        }
      } else {
        optionIds = [optionId];
      }
    }
    const r = await api(`/polls/${pollId}/vote`, {
      method: 'POST',
      body: { option_ids: optionIds },
    });
    updatePollInStore(r.poll);
  } catch (err) {
    showToast(err.message);
  }
}

/* ═══════════════ پیش‌نمایش لینک و فایل‌ها ═══════════════ */

function linkPreviewHTML(lp) {
  if (!lp || !lp.url) return '';
  return `
  <a class="link-preview-card" href="${esc(lp.url)}" target="_blank" rel="noopener noreferrer">
    ${lp.image ? `<img class="lp-image" src="${esc(lp.image)}" alt="" loading="lazy">` : ''}
    <div class="lp-content">
      ${lp.site_name ? `<div class="lp-site">${esc(lp.site_name)}</div>` : ''}
      ${lp.title ? `<div class="lp-title">${esc(lp.title)}</div>` : ''}
      ${lp.description ? `<div class="lp-desc">${esc(truncate(lp.description, 120))}</div>` : ''}
    </div>
  </a>`;
}

function fileHTML(file) {
  const url = furl(file.id);
  const mime = file.mime || '';
  if (mime.startsWith('image/')) {
    return `<img class="msg-img" src="${esc(url)}" alt="${esc(file.name)}" loading="lazy">`;
  }
  if (mime.startsWith('video/')) {
    return `
    <div class="video-container">
      <video class="msg-video" src="${esc(url)}" controls preload="metadata"></video>
      <button type="button" class="pip-btn" title="تصویر در تصویر">📺</button>
    </div>`;
  }
  if (mime.startsWith('audio/')) {
    return voicePlayerHTML({ id: 0, created_at: Date.now() }, file);
  }
  return `
  <a class="file-card" href="${esc(url)}&download=1" download="${esc(file.name)}">
    <span class="file-icon">${ICONS.file}</span>
    <span class="file-info">
      <span class="file-name">${esc(file.name)}</span>
      <span class="file-size">${fmtSize(file.size)}</span>
    </span>
    <span class="file-dl">${ICONS.download}</span>
  </a>`;
}

function messageHTML(chat, m, prev) {
  if (m.is_service) {
    return `<div class="service-msg" data-id="${m.id}"><span>${esc(m.text)}</span></div>`;
  }

  const out = m.sender.id === state.me?.id;
  const isGroup = chat?.type === 'group';
  const grouped =
    !!prev &&
    prev.sender.id === m.sender.id &&
    sameDay(prev.created_at, m.created_at) &&
    m.created_at - prev.created_at < 5 * 60e3 &&
    !m.reply_to &&
    !prev.reply_to &&
    !prev.is_service;
  const showAvatar = !out && !grouped;
  const showName = !out && isGroup && !grouped;
  const isVoiceOrAudio = !!(m.file && (m.is_voice || (m.file.mime && m.file.mime.startsWith('audio/'))));
  const mediaOnly = m.file && m.file.mime && /^(image|video)\//.test(m.file.mime) && !m.text && !m.poll;

  let inner = '';
  if (m.forward) {
    inner += `<div class="forwarded">فورواردشده از <b>${esc(m.forward.from_name)}</b></div>`;
  }
  if (m.reply_to) {
    const preview = m.reply_to.text || filePreviewTag(m.reply_to.file || { mime: m.reply_to.mime, name: '' });
    inner += `<div class="reply-quote" data-goto="${m.reply_to.id}">
      <div class="rq-name">${esc(m.reply_to.sender_name)}</div>
      <div class="rq-text">${esc(truncate(preview, 80))}</div>
    </div>`;
  }
  if (showName) {
    const isSafir = m.sender && (m.sender.username === 'safir' || m.sender.is_safir);
    inner += `<div class="sender" style="color:${nameColor(m.sender.id)}">${esc(m.sender.display_name)}${isSafir ? verifiedBadgeHTML() : ''}</div>`;
  }

  // نظرسنجی
  if (m.poll) {
    inner += pollHTML(m.poll);
  }

  // فایل و ویس
  if (m.file) {
    if (isVoiceOrAudio) {
      inner += voicePlayerHTML(m, m.file);
    } else {
      inner += fileHTML(m.file);
    }
  }

  // متن با نشانه‌گذاری Markdown & Spoilers
  if (m.text) {
    inner += `<div class="msg-text">${formatMessageText(m.text)}</div>`;
  }

  // پیش‌نمایش لینک (Rich Link Preview)
  if (m.link_preview) {
    inner += linkPreviewHTML(m.link_preview);
  }

  const rxHTML = reactionsHTML(m);

  return `
  <div class="msg ${out ? 'out' : 'in'}${grouped ? ' grouped' : ''}" data-id="${m.id}">
    ${showAvatar ? avatarHTML(m.sender, 'msg-avatar') : ''}
    <div class="bubble${mediaOnly ? ' media' : ''}${isVoiceOrAudio ? ' voice-bubble' : ''}">
      ${inner}
      ${rxHTML}
      <span class="msg-time">${timeWithChecks(chat, m)}</span>
    </div>
  </div>`;
}

function renderMessages(chatId, opts = {}) {
  const el = $('#messages');
  if (!el) return;
  chatId = Number(chatId);
  if (Number(state.activeChatId) !== chatId) return;
  let arr = state.messagesByChat.get(chatId) || [];
  if (state.activeTopicId) {
    arr = arr.filter((m) => m.topic_id === state.activeTopicId);
  }
  const chat = state.chats.get(chatId);
  let html = '';
  let prev = null;
  for (const m of arr) {
    html += daySeparatorHTML(prev, m);
    html += messageHTML(chat, m, prev);
    prev = m;
  }
  el.innerHTML = html || '<div class="empty-chat">هنوز پیامی نیست. اولین پیام را بفرستید! 👋</div>';
  if (opts.keepScroll != null) el.scrollTop = el.scrollHeight - opts.keepScroll;
  else if (opts.preserveScroll != null) el.scrollTop = opts.preserveScroll;
  else scrollBottom(true);
  bindMessageEvents(el);
}

function updateReadTicksInDOM(chatId, readUpToId) {
  const container = $('#messages');
  if (!container) return;
  const msgEls = container.querySelectorAll('.msg.out[data-id]');
  msgEls.forEach((el) => {
    const mid = Number(el.dataset.id);
    if (mid && mid <= Number(readUpToId)) {
      const ticksEl = el.querySelector('.msg-ticks');
      if (ticksEl) {
        ticksEl.className = 'msg-ticks read';
        ticksEl.title = 'خوانده شد';
        ticksEl.innerHTML = doubleCheckSVG();
      }
    }
  });
}

function appendMessageNode(m) {
  const el = $('#messages');
  if (!el) return;
  const empty = el.querySelector('.empty-chat');
  if (empty) empty.remove();
  const store = state.messagesByChat.get(m.chat_id) || [];
  const prev = store.length >= 2 ? store[store.length - 2] : null;
  el.insertAdjacentHTML(
    'beforeend',
    daySeparatorHTML(prev, m) + messageHTML(state.chats.get(m.chat_id), m, prev)
  );
  scrollBottom(m.sender.id === state.me?.id);
  bindMessageEvents(el);
}

function scrollBottom(force) {
  const el = $('#messages');
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 250;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function bindMessageEvents(root) {
  $$('img.msg-img', root).forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    img.addEventListener('click', () => openLightbox(img.src));
    img.addEventListener('load', () => scrollBottom(false));
  });

  // کنترل تصویر در تصویر (Picture-in-Picture)
  $$('.pip-btn', root).forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const video = btn.previousElementSibling;
      if (!video) return;
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else if (video.requestPictureInPicture) {
          await video.requestPictureInPicture();
        }
      } catch {
        showToast('تصویر در تصویر پشتیبانی نمی‌شود');
      }
    });
  });

  bindVoicePlayers(root);
}

function goToMessage(id) {
  const el = $(`#messages .msg[data-id="${id}"]`);
  if (!el) {
    showToast('پیام اصلی در پیام‌های بارگذاری‌شده نیست');
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1300);
}

function onIncomingMessage(m) {
  if (state.seen.has(m.id)) return;
  state.seen.add(m.id);

  if (m.sender && (m.sender.username === 'safir' || m.sender.display_name === 'سفیر') && m.text && m.text.includes('تایید گردید')) {
    if (state.me) state.me.status = 'approved';
    updateApprovalState();
    showToast('🎉 حساب کاربری شما توسط ادمین تایید شد! هم‌اکنون می‌توانید شروع به گفتگو کنید.');
  }

  const store = state.messagesByChat.get(m.chat_id);
  if (store && !store.some((x) => x.id === m.id)) {
    store.push(m);
  }

  const c = state.chats.get(m.chat_id);
  if (c) {
    c.last_message = {
      id: m.id,
      sender_id: m.sender.id,
      sender_name: m.sender.display_name,
      text: m.text,
      file: m.file ? { mime: m.file.mime, name: m.file.name } : null,
      created_at: m.created_at,
    };
    c.updated_at = m.created_at;
  } else {
    loadChats();
  }

  // صدای اعلان (بررسی بی‌صدا و پیام آرام)
  const isMuted = c && (c.is_muted || (c.muted_until && c.muted_until > Date.now()));
  if (m.sender.id !== state.me?.id && !m.is_silent && !isMuted) {
    beep();
  }

  if (Number(m.chat_id) === Number(state.activeChatId)) {
    if (c) c.unread_count = 0;
    if (!state.activeTopicId || m.topic_id === state.activeTopicId) {
      appendMessageNode(m);
    }
    api(`/chats/${m.chat_id}/read`, { method: 'POST' }).catch(() => {});
  } else if (c) {
    c.unread_count = (c.unread_count || 0) + 1;
  }
  renderSidebar();
}

/* ═══════════════ منوی زمینه پیام‌ها و ویرایش ═══════════════ */

function msgMenuItems(m) {
  const chat = state.chats.get(m.chat_id);
  const items = [];
  items.push({ label: 'پاسخ', icon: ICONS.reply, action: () => setReply(m) });

  // نمایش لیست سین‌کنندگان در گروه (فقط برای پیام‌های خودمان)
  if (chat && chat.type === 'group' && m.sender.id === state.me?.id) {
    items.push({
      label: 'چه کسانی خواندند',
      icon: ICONS.read,
      action: () => showSeenByList(m),
    });
  }

  // ویرایش پیام (Message Editing)
  if (m.sender.id === state.me?.id && !m.poll) {
    items.push({ label: 'ویرایش', icon: ICONS.edit, action: () => startEditMessage(m) });
  }

  // سنجاق کردن پیام در چت (Pin Message)
  const canPin = chat && (chat.type === 'private' || ['owner', 'admin'].includes(chat.role));
  if (canPin) {
    items.push({ label: 'سنجاق کردن', icon: ICONS.pin, action: () => pinMessageInChat(m.id) });
  }

  if (m.text) {
    items.push({
      label: 'کپی متن',
      icon: ICONS.copy,
      action: async () => {
        try {
          await navigator.clipboard.writeText(m.text);
          showToast('متن کپی شد');
        } catch {
          showToast('کپی ممکن نشد');
        }
      },
    });
  }

  items.push({ label: 'فوروارد', icon: ICONS.forward, action: () => openForwardModal(m) });

  const canDelete =
    m.sender.id === state.me?.id || (chat && chat.type !== 'private' && ['owner', 'admin'].includes(chat.role));
  if (canDelete) {
    items.push({
      label: 'حذف پیام',
      icon: ICONS.delete,
      danger: true,
      action: async () => {
        const ok = await askConfirm({ title: 'حذف پیام', text: 'این پیام برای همه حذف می‌شود. مطمئن هستید؟', ok: 'حذف' });
        if (!ok) return;
        try {
          await api(`/messages/${m.id}`, { method: 'DELETE' });
        } catch (e) {
          showToast(e.message);
        }
      },
    });
  }
  return items;
}

/* ═══════════════ لیست سین‌کنندگان پیام در گروه ═══════════════ */

async function showSeenByList(m) {
  const existing = document.getElementById('seen-by-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'seen-by-modal';
  modal.className = 'seen-by-modal';
  modal.innerHTML = `
    <div class="seen-by-modal-inner">
      <div class="seen-by-header">
        <h3>👁 خوانده‌شده توسط</h3>
        <button class="icon-btn" id="seen-by-close">✕</button>
      </div>
      <div class="seen-by-list" id="seen-by-list">
        <div class="empty-hint">در حال بارگذاری...</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#seen-by-close').onclick = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  try {
    const r = await api(`/messages/${m.id}/seen-by`);
    const list = modal.querySelector('#seen-by-list');
    const readers = r.seen_by || [];
    if (!readers.length) {
      list.innerHTML = '<div class="empty-hint">هنوز کسی این پیام را نخوانده است</div>';
    } else {
      list.innerHTML = readers.map((u) => `
        <div class="seen-by-row">
          ${avatarHTML(u, 'small')}
          <span class="sb-name">${esc(u.display_name)}</span>
          <span class="sb-time">${u.seen_at ? faTime(u.seen_at) : ''}</span>
        </div>`).join('');
    }
  } catch (e) {
    const list = modal.querySelector('#seen-by-list');
    list.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`;
  }
}

/* ═══════════════ ویرایش و پاسخ به پیام ═══════════════ */

function startEditMessage(m) {
  state.editingMessage = m;
  cancelReply();
  const bar = $('#edit-bar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="edit-bar-main">
      <span class="edit-bar-title">ویرایش پیام</span>
      <span class="edit-bar-sub">${esc(truncate(m.text || '', 50))}</span>
    </div>
    <button id="edit-cancel" class="icon-btn" title="لغو ویرایش">✕</button>
  `;
  bar.classList.remove('hidden');
  $('#edit-cancel').onclick = cancelEdit;

  const input = $('#msg-input');
  if (input) {
    input.value = m.text || '';
    input.focus();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  }
}

function cancelEdit() {
  state.editingMessage = null;
  const bar = $('#edit-bar');
  if (bar) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

function setReply(m) {
  cancelEdit();
  state.replyTo = m;
  const bar = $('#reply-bar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="rb-line"></div>
    <div class="rb-main">
      <div class="rb-name">پاسخ به ${esc(m.sender.display_name)}</div>
      <div class="rb-text">${esc(truncate(m.text || filePreviewTag(m.file), 60))}</div>
    </div>
    <button id="reply-remove" class="icon-btn" title="لغو پاسخ">✕</button>`;
  bar.classList.remove('hidden');
  $('#reply-remove').addEventListener('click', cancelReply);
  if (canPostIn(state.chats.get(m.chat_id) || {})) $('#msg-input')?.focus();
}

function cancelReply() {
  state.replyTo = null;
  const bar = $('#reply-bar');
  if (bar) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

function setPendingFile(f) {
  state.pendingFile = f;
  const bar = $('#attach-bar');
  if (!bar) return;
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="ab-icon">📎</span>
    <span class="ab-info">
      <span class="ab-name">${esc(f.name)}</span>
      <span class="ab-size">${fmtSize(f.size)}</span>
    </span>
    <button id="ab-remove" class="icon-btn" title="حذف">✕</button>`;
  $('#ab-remove').addEventListener('click', clearPendingFile);
  $('#msg-input')?.focus();
}

function clearPendingFile() {
  state.pendingFile = null;
  const bar = $('#attach-bar');
  if (bar) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

let isSendingMessage = false;

async function sendMessage({ silent = false, scheduledAt = null } = {}) {
  if (isSendingMessage) return;
  const input = $('#msg-input');
  if (!input) return;
  const text = input.value.trim();
  const file = state.pendingFile;
  const chatId = state.activeChatId;
  if ((!text && !file) || !chatId) return;

  // ویرایش پیام در حال ویرایش
  if (state.editingMessage) {
    const editId = state.editingMessage.id;
    try {
      isSendingMessage = true;
      const r = await api(`/messages/${editId}`, { method: 'PUT', body: { text } });
      input.value = '';
      cancelEdit();
      localStorage.removeItem('gg_draft_' + chatId);
      const store = state.messagesByChat.get(chatId);
      if (store) {
        const i = store.findIndex((m) => m.id === editId);
        if (i >= 0) store[i] = r.message;
      }
      renderMessages(chatId);
      showToast('پیام ویرایش شد ✅');
    } catch (e) {
      showToast(e.message);
    } finally {
      isSendingMessage = false;
    }
    return;
  }

  isSendingMessage = true;
  const sendBtn = $('#send-btn');
  if (sendBtn) sendBtn.disabled = true;

  const prevReply = state.replyTo;
  const fd = new FormData();
  if (text) fd.set('text', text);
  if (file) fd.set('file', file);
  if (prevReply) fd.set('reply_to_id', prevReply.id);
  if (silent || state.nextSilent) fd.set('is_silent', '1');
  if (scheduledAt || state.nextScheduledAt) fd.set('scheduled_at', scheduledAt || state.nextScheduledAt);
  if (state.activeTopicId) fd.set('topic_id', String(state.activeTopicId));

  state.nextSilent = false;
  state.nextScheduledAt = null;

  input.value = '';
  input.style.height = 'auto';
  clearPendingFile();
  cancelReply();
  typingPing(true);
  localStorage.removeItem('gg_draft_' + chatId);
  renderSidebar();

  try {
    const m = await api(`/chats/${chatId}/messages`, { method: 'POST', formData: fd });
    if (m.scheduled) {
      showToast('پیام برای زمان مشخص زمان‌بندی شد 🕒');
    } else {
      onIncomingMessage(m);
    }
  } catch (e) {
    showToast(e.message);
    input.value = text;
    if (file) setPendingFile(file);
    if (prevReply) setReply(prevReply);
  } finally {
    isSendingMessage = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function checkMentionAutocomplete() {
  const input = $('#msg-input');
  if (!input) return;
  const chat = state.chats.get(state.activeChatId);
  const popup = $('#mention-popup');
  if (!chat || chat.type === 'private' || !popup) {
    if (popup) popup.classList.add('hidden');
    return;
  }
  const pos = input.selectionStart;
  const val = input.value.slice(0, pos);
  const match = val.match(/@([a-zA-Z0-9_]*)$/);
  if (!match) {
    popup.classList.add('hidden');
    return;
  }
  const q = match[1].toLowerCase();
  const members = (chat.members || []).filter(
    (u) => u.username && u.username.toLowerCase().includes(q) && u.id !== state.me?.id
  );
  if (!members.length) {
    popup.classList.add('hidden');
    return;
  }
  popup.innerHTML = members
    .slice(0, 6)
    .map(
      (u) => `
    <div class="mention-item" data-uname="${esc(u.username)}">
      ${avatarHTML(u, 'tiny')}
      <div class="mi-info">
        <span class="mi-name">${esc(u.display_name)}</span>
        <span class="mi-uname">@${esc(u.username)}</span>
      </div>
    </div>
  `
    )
    .join('');
  popup.classList.remove('hidden');

  popup.onclick = (e) => {
    const item = e.target.closest('.mention-item');
    if (!item) return;
    const uname = item.dataset.uname;
    const before = val.replace(/@([a-zA-Z0-9_]*)$/, `@${uname} `);
    input.value = before + input.value.slice(pos);
    popup.classList.add('hidden');
    input.focus();
    input.selectionStart = input.selectionEnd = before.length;
  };
}
