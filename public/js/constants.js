'use strict';

/* ═══════════════ توابع و ابزارهای کمکی عمومی ═══════════════ */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

const faTime = (ts) => new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const faDate = (ts) => new Date(ts).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', year: 'numeric' });
const faNum = (n) => (n == null || Number.isNaN(Number(n)) ? '۰' : Number(n).toLocaleString('fa-IR'));

function listTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return faTime(ts);
  return d.toLocaleDateString('fa-IR', { day: 'numeric', month: 'short' });
}

function relLastSeen(ts) {
  if (!ts) return 'آخرین بازدید خیلی وقت پیش';
  const diff = Date.now() - Number(ts);
  if (diff < 60 * 1000) return 'آخرین بازدید لحظاتی پیش';
  if (diff < 60 * 60 * 1000) {
    const mins = Math.floor(diff / (60 * 1000));
    return `آخرین بازدید ${faNum(mins)} دقیقه قبل`;
  }
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `آخرین بازدید امروز در ${faTime(ts)}`;
  }
  const yest = new Date(now.getTime() - 24 * 3600 * 1000);
  if (d.toDateString() === yest.toDateString()) {
    return `آخرین بازدید دیروز در ${faTime(ts)}`;
  }
  return `آخرین بازدید ${faDate(ts)}`;
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return faNum(n) + ' بایت';
  if (n < 1024 * 1024) return faNum((n / 1024).toFixed(1)) + ' کیلوبایت';
  return faNum((n / (1024 * 1024)).toFixed(1)) + ' مگابایت';
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const d1 = new Date(a), d2 = new Date(b);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function daySeparatorHTML(prev, cur) {
  if (!prev || !sameDay(prev.created_at, cur.created_at)) {
    return `<div class="day-sep">${faDate(cur.created_at)}</div>`;
  }
  return '';
}

const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
  '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
  '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩',
  '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣',
  '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
  '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗',
  '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯',
  '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐',
  '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈',
  '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾',
  '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿',
  '😾', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞',
  '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
  '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
  '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
  '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
  '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
  '🔥', '✨', '🌟', '💫', '💥', '💢', '💦', '💨', '🕳️', '💣',
];

const AV_COLORS = [
  ['#e17076', '#f2a37b'], ['#7bc862', '#a5de8b'], ['#65aadd', '#9fd0f0'],
  ['#a695e7', '#c7b9f0'], ['#ee7aae', '#f7b3ce'], ['#faa774', '#fdbe96'],
];

const NAME_COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#faa774', '#6ec9cb', '#f2b33d'];
const nameColor = (id) => NAME_COLORS[(Math.abs(Number(id) || 0) * 7) % NAME_COLORS.length];

function avatarHTML(item, cls = '') {
  const id = Math.abs(Number(item.id || 0));
  const [c1, c2] = AV_COLORS[id % AV_COLORS.length];
  const bg = ` style="background:linear-gradient(180deg,${c1},${c2})"`;
  if (item.avatar_url) {
    return `<div class="avatar ${cls}"><img src="${esc(withToken(item.avatar_url))}" alt=""></div>`;
  }
  if (item.icon) {
    return `<div class="avatar ${cls}"${bg}><span class="av-icon">${item.icon}</span></div>`;
  }
  const name = (item.display_name || item.title || '؟').trim();
  const ch = [...name][0] || '؟';
  return `<div class="avatar ${cls}"${bg}>${esc(ch)}</div>`;
}

function filePreviewTag(file) {
  if (!file) return '';
  if (file.mime && file.mime.startsWith('image/')) return '🖼 عکس';
  if (file.mime && file.mime.startsWith('video/')) return '🎬 ویدیو';
  if (file.mime && file.mime.startsWith('audio/')) return '🎤 پیام صوتی';
  return `📎 فایل ${file.name || ''}`;
}

function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'امروز';
  if (d.toDateString() === y.toDateString()) return 'دیروز';
  return faDate(ts);
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉'];

const ICONS = {
  group: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M16 11a3 3 0 10-3-3 3 3 0 003 3zm-8 0a3 3 0 10-3-3 3 3 0 003 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05A4.22 4.22 0 0117 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  channel: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M18 11v2h4v-2zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6zM4 9a2 2 0 00-2 2v2a2 2 0 002 2h1v4h2v-4h1l5 3V6L8 9zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69a4.22 4.22 0 001.5-3.34z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zm-1 7V3.5L18.5 9zM6 20V4h5v7h7v9z"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M5 20h14v-2H5zm7-18v8.17l-3.59-3.58L7 8l5 5 5-5-1.41-1.41L12 10.17V2z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 10-3.2-3.2 3.2 3.2 0 003.2 3.2zM9 3L7.17 5H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.17L15 3zm3 15a5 5 0 115-5 5 5 0 01-5 5z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>',
  unpin: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M2 5.27L3.28 4 20 20.72l-1.28 1.28-4.75-4.75V22l-1-1-1-7H6v-2c1.66 0 3-1.34 3-3V8.27L2 5.27zM16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.4 0-.75.25-.91.61L8.83 5.38 16 12.55V9z"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  forward: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  read: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.41 11.93l-1.41 1.41 5.66 5.66 12-12-1.42-1.41zM.41 13.41L6.07 19.07 7.49 17.66 1.83 12 .41 13.41z"/></svg>',
  clear: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M19.36 10.04l-7.4-7.4a1.996 1.996 0 00-2.83 0L3.71 8.06c-.78.78-.78 2.05 0 2.83l7.4 7.4c.78.78 2.05.78 2.83 0l5.42-5.42c.78-.79.78-2.05 0-2.83zm-8.81-5.99c.39-.39 1.02-.39 1.41 0l5.99 5.99c.39.39.39 1.02 0 1.41l-2.12 2.12L9.84 7.58l5.99-5.99-1.28-1.28-5.99 5.99 1.28 1.28 1.41-1.41 1.41 1.41z"/></svg>',
  leave: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  admin: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
  demote: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/></svg>',
  userRemove: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 2v-2h-2V6h2V4h2v2h2v2h-2v2h-2zm-7 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
  addMember: '<svg viewBox="0 0 24 24" width="18" height="18" style="width:18px;height:18px;max-width:18px;max-height:18px;display:block;" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
  saved: '<svg viewBox="0 0 24 24" width="20" height="20" style="width:20px;height:20px;max-width:20px;max-height:20px;display:block;" fill="currentColor"><path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="14" height="14" style="width:14px;height:14px;max-width:14px;max-height:14px;display:block;" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.01 4.01C7.01 8.28 7 8.28 7 8.28v7.44h4l5 5V14.27l4.73 4.73 1.27-1.27L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  unmute: '<svg viewBox="0 0 24 24" width="14" height="14" style="width:14px;height:14px;max-width:14px;max-height:14px;display:block;" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  // تیک تک تلگرامی: زاویه تمیز و ابعاد استاندارد
  singleTick: '<svg viewBox="0 0 16 11" width="16" height="11" style="width:16px;height:11px;max-width:16px;max-height:11px;display:inline-block;" class="tick-svg" aria-hidden="true"><path d="M3.5 5.8L6.5 8.8L12.5 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // دو تیک موازی با فاصله دقیق ۵ پیکسلی بدون هرگونه تداخل و درهم‌رفتگی
  doubleTick: '<svg viewBox="0 0 18 11" width="18" height="11" style="width:18px;height:11px;max-width:18px;max-height:11px;display:inline-block;" class="tick-svg" aria-hidden="true"><path d="M1.5 5.8L4.5 8.8L10.5 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 5.8L9.5 8.8L15.5 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  verified: '<svg viewBox="0 0 24 24" width="17" height="17" style="width:17px;height:17px;max-width:17px;max-height:17px;display:block;" class="verified-badge-svg"><path fill="#2AABEE" d="M12 2l2.4 2.4 3.4-.4 1.4 3.1 3.1 1.4-.4 3.4L24 14.3l-2.4 2.4.4 3.4-3.1 1.4-1.4 3.1-3.4-.4-2.4 2.4-2.4-2.4-3.4.4-1.4-3.1-3.1-1.4.4-3.4L0 12l2.4-2.4-.4-3.4 3.1-1.4 1.4-3.1 3.4.4L12 2z"/><path fill="#fff" d="M10 15.5l-3.5-3.5 1.4-1.4 2.1 2.1 5.6-5.6 1.4 1.4-7 7z"/></svg>',
};

function verifiedBadgeHTML() {
  return `<span class="verified-badge" title="سفیر رسمی">${ICONS.verified}</span>`;
}

const singleCheckSVG = () => ICONS.singleTick;
const doubleCheckSVG = () => ICONS.doubleTick;

const STICKERS = [
  { id: 'stk_1', emoji: '😎', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60e.png' },
  { id: 'stk_2', emoji: '🚀', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f680.png' },
  { id: 'stk_3', emoji: '🔥', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f525.png' },
  { id: 'stk_4', emoji: '🎉', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f389.png' },
  { id: 'stk_5', emoji: '❤️', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2764.png' },
  { id: 'stk_6', emoji: '👍', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44d.png' },
  { id: 'stk_7', emoji: '🌟', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f31f.png' },
  { id: 'stk_8', emoji: '💯', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4af.png' },
  { id: 'stk_9', emoji: '💡', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4a1.png' },
  { id: 'stk_10', emoji: '🐱', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f431.png' },
  { id: 'stk_11', emoji: '🇮🇷', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f1ee-1f1f7.png' },
  { id: 'stk_12', emoji: '☕', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2615.png' },
];

const GIFS = [
  { id: 'gif_1', title: 'خوش‌آمد', url: 'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif' },
  { id: 'gif_2', title: 'موفقیت', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
  { id: 'gif_3', title: 'کف زدن', url: 'https://media.giphy.com/media/nbvFVPiEiJH6JOGIok/giphy.gif' },
  { id: 'gif_4', title: 'خنده', url: 'https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif' },
  { id: 'gif_5', title: 'تایید', url: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif' },
  { id: 'gif_6', title: 'تعجب', url: 'https://media.giphy.com/media/5VKbvrjxpVJCM/giphy.gif' },
];

/* ═══════════════ نشانه‌گذاری متن و اسپویلرها (Markdown & Spoilers) ═══════════════ */

function formatMessageText(raw) {
  if (!raw) return '';
  let s = esc(raw);

  // استخراج بلوک‌های کد سه تایی
  const codeBlocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="code-block"><code>${code}</code></pre>`);
    return `\x01BLOCK_${idx}\x02`;
  });

  // استخراج کدهای تک‌خطی
  const inlineCodes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline-code">${code}</code>`);
    return `\x01INLINE_${idx}\x02`;
  });

  // اسپویلرها
  s = s.replace(/\|\|([\s\S]*?)\|\|/g, '<span class="spoiler" title="کلیک برای نمایش">$1</span>');

  // بولد
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // ایتالیک
  s = s.replace(/__([^_\n]+)__/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g, '$1<em>$2</em>');

  // خط‌خورده
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // منشن‌ها
  s = s.replace(/@([a-zA-Z0-9_]{3,30})/g, '<a class="mention-tag" data-username="$1">@$1</a>');

  // لینک‌های اینترنتی
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');

  // بازگردانی کدهای درون‌خطی و بلوک‌ها
  s = s.replace(/\x01INLINE_(\d+)\x02/g, (_, i) => inlineCodes[i] || '');
  s = s.replace(/\x01BLOCK_(\d+)\x02/g, (_, i) => codeBlocks[i] || '');

  return s;
}
