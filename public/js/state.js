'use strict';

/* ═══════════════ وضعیت برنامه (Application State) ═══════════════ */

const state = {
  token: localStorage.getItem('gg_token') || null,
  me: null,
  chats: new Map(),          // chatId -> chat
  messagesByChat: new Map(), // chatId -> آرایه پیام‌ها (صعودی)
  noMore: new Map(),         // chatId -> پیام قدیمی‌تری نمانده
  seen: new Set(),           // شناسه پیام‌های دیده‌شده
  online: new Set(),
  peerReads: new Map(),      // chatId -> آخرین شناسه پیام خوانده‌شده توسط هم‌صحبت‌ها
  searchQ: '',
  searchUsers: [],
  searchMessages: [],        // نتایج جستجوی پیام‌ها در سراسر برنامه
  activeChatId: null,
  infoChatId: null,
  replyTo: null,
  forwarding: null,
  pendingFile: null,
  socket: null,
  // ویرایش پیام
  editingMessage: null,
  // پوشه‌ها و تب‌های گفتگو
  activeTab: 'all',
  // تاپیک‌ها
  activeTopicId: null,
  topicsByChat: new Map(),   // chatId -> آرایه تاپیک‌ها
  // ضبط صدا
  mediaRecorder: null,
  voiceChunks: [],
  voiceTimer: null,
  voiceSeconds: 0,
  // تم و پس‌زمینه
  theme: localStorage.getItem('gg_theme') || 'light',
  wallpaper: localStorage.getItem('gg_wallpaper') || 'default',
  // ارسال بدون صدا یا با زمان‌بندی
  nextSilent: false,
  nextScheduledAt: null,
  // رسانه‌های اشتراکی در اطلاعات چت
  sharedMediaType: 'photos_videos',
  // مودال گروه/کانال جدید
  newChatType: 'group',
  newChatMembers: new Set(),
  newChatAvatar: null,
  allUsers: [],
  // مودال افزودن عضو
  addCandidates: [],
  addSelected: new Set(),
  // مودال ویرایش
  editAvatar: null,
  // مودال پروفایل
  profAvatar: null,
  typingTimer: null,
  typingShown: false,
  loadingOlder: false,
  openSeq: 0,
  suppressClick: false,
};

const withToken = (url) =>
  url && state.token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token) : url;
const furl = (id) => withToken(`/api/files/${id}`);

/* ═══════════════ ارتباط با API ═══════════════ */

async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch('/api' + path, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = data && data.error ? data.error : typeof data === 'string' ? data : 'خطا در برقراری ارتباط';
    if ((res.status === 401 || (res.status === 403 && (msg.includes('بن') || msg.includes('مسدود')))) && state.token) {
      state.token = null;
      localStorage.removeItem('gg_token');
      if ($('#auth-screen')?.classList.contains('hidden')) {
        alert(msg);
        window.location.reload();
      }
    }
    throw new Error(msg);
  }
  return data;
}

/* ═══════════════ اعلان‌ها و پیام‌ها ═══════════════ */

let toastTimer = null;
function showToast(text) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

let confirmResolve = null;
function askConfirm({ title = 'تایید عملیات', text, ok = 'تایید', danger = false }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'btn-danger' : 'btn-primary';
    $('#modal-confirm').classList.remove('hidden');
  });
}
function settleConfirm(val) {
  $('#modal-confirm').classList.add('hidden');
  if (confirmResolve) {
    confirmResolve(val);
    confirmResolve = null;
  }
}

/* ═══════════════ تم و پس‌زمینه (Themes & Wallpapers) ═══════════════ */

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const themeText = $('#theme-btn-text');
  if (themeText) themeText.textContent = theme === 'dark' ? 'حالت روز' : 'حالت شب';
  const settingsThemeVal = $('#settings-theme-value');
  if (settingsThemeVal) settingsThemeVal.textContent = theme === 'dark' ? 'حالت شب' : 'حالت روز';
  applyWallpaper(state.wallpaper || 'default');
}

function applyWallpaper(wp) {
  state.wallpaper = wp;
  document.documentElement.setAttribute('data-wallpaper', wp);
  const paneEl = $('#chat-pane');
  if (paneEl) paneEl.setAttribute('data-wallpaper', wp);
  const messagesEl = $('#messages');
  if (messagesEl) messagesEl.setAttribute('data-wallpaper', wp);
  $$('.wp-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.wp === wp);
  });
}

function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = next;
  localStorage.setItem('gg_theme', next);
  applyTheme(next);
  showToast(next === 'dark' ? 'حالت شب فعال شد 🌙' : 'حالت روز فعال شد ☀️');
}

/* ═══════════════ وضعیت تایید حساب کاربر ═══════════════ */

function updateApprovalState() {
  const isPending = state.me && state.me.status === 'pending';
  const banner = $('#pending-banner');
  const sendBtn = $('#send-btn');
  const msgInput = $('#msg-input');
  const attachBtn = $('#attach-btn');
  const micBtn = $('#mic-btn');
  const fabBtn = $('#fab');

  if (banner) banner.classList.toggle('hidden', !isPending);
  if (sendBtn) sendBtn.disabled = isPending;
  if (msgInput) {
    if (isPending) {
      msgInput.disabled = true;
      msgInput.placeholder = 'حساب شما در انتظار تایید ادمین است...';
    } else {
      msgInput.disabled = false;
      msgInput.placeholder = 'پیام خود را بنویسید...';
    }
  }
  if (attachBtn) attachBtn.disabled = isPending;
  if (micBtn) micBtn.disabled = isPending;
  if (fabBtn) fabBtn.style.pointerEvents = isPending ? 'none' : '';
}

/* ═══════════════ منوی زمینه (راست‌کلیک / لمس طولانی) ═══════════════ */

function openMenu(items, x, y, opts = {}) {
  const menu = $('#ctx-menu');
  let html = '';
  if (opts.reactions && typeof opts.onReaction === 'function') {
    html += `<div class="ctx-reactions">` +
      QUICK_REACTIONS.map((emoji) => `<button type="button" class="ctx-rx-btn" data-rx="${esc(emoji)}">${esc(emoji)}</button>`).join('') +
      `</div>`;
  }
  html += items
    .map(
      (it, i) => `
    <button class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">
      ${it.icon || ''}
      <span>${esc(it.label)}</span>
    </button>`
    )
    .join('');
  menu.innerHTML = html;
  menu.classList.remove('hidden');

  if (opts.reactions && typeof opts.onReaction === 'function') {
    $$('.ctx-rx-btn', menu).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        opts.onReaction(btn.dataset.rx);
      });
    });
  }

  $$('.ctx-item', menu).forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.i);
      closeMenu();
      items[idx]?.action?.();
    });
  });

  const w = menu.offsetWidth, h = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + w > vw - 10) left = vw - w - 10;
  if (top + h > vh - 10) top = vh - h - 10;
  if (left < 10) left = 10;
  if (top < 10) top = 10;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function closeMenu() {
  const menu = $('#ctx-menu');
  if (menu) menu.classList.add('hidden');
}

function bindLongPress(containerSel, itemSel, handler) {
  const container = $(containerSel);
  if (!container) return;
  let timer = null, sx = 0, sy = 0;

  container.addEventListener('contextmenu', (e) => {
    const item = e.target.closest(itemSel);
    if (!item) return;
    e.preventDefault();
    handler(item, e.clientX, e.clientY);
  });

  container.addEventListener('touchstart', (e) => {
    const item = e.target.closest(itemSel);
    if (!item) return;
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    timer = setTimeout(() => {
      state.suppressClick = true;
      handler(item, sx, sy);
    }, 480);
  });

  const cancel = () => clearTimeout(timer);
  container.addEventListener('touchend', cancel);
  container.addEventListener('touchcancel', cancel);
  container.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearTimeout(timer);
  });
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch {}
}
