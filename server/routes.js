'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const { UPLOAD_DIR, ensureSafirBot } = require('./db');
const { USERNAME_RE, hashPassword, verifyPassword, newToken, fixFileName } = require('./util');

const MAX_FILE_SIZE = 200 * 1024 * 1024; // ۲۰۰ مگابایت

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const err = (status, message) => new ApiError(status, message);

// پوشش توابع async برای هدایت خطا به middleware خطا
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

module.exports = function createApi(db, sock) {
  const api = express.Router();

  /* ---------------- ابزارهای مشترک ---------------- */

  const fileUrl = (id) => (id ? `/api/files/${id}` : null);

  function userPublic(u, viewerId = 0) {
    if (!u) return null;
    let lastSeen = u.last_seen_at;
    if (u.privacy_last_seen === 'nobody' && viewerId && Number(u.id) !== Number(viewerId)) {
      lastSeen = null;
    }
    return {
      id: Number(u.id),
      username: u.username,
      display_name: u.display_name,
      avatar_url: fileUrl(u.avatar_file_id),
      bio: u.bio || '',
      privacy_last_seen: u.privacy_last_seen || 'everyone',
      status: u.status || 'approved',
      last_seen_at: lastSeen,
    };
  }

  const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  function isBlockedBetween(u1, u2) {
    if (!u1 || !u2) return false;
    const row = db
      .prepare('SELECT 1 FROM blocked_users WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)')
      .get(u1, u2, u2, u1);
    return !!row;
  }

  async function fetchLinkPreview(text) {
    if (!text) return null;
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (!match) return null;
    const url = match[0];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html')) return null;

      const html = (await res.text()).slice(0, 50000);
      const getMeta = (prop) => {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["'](?:og:)?${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
        const m = html.match(re);
        return m ? m[1] : null;
      };
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = getMeta('title') || (titleMatch ? titleMatch[1].trim() : null);
      const description = getMeta('description');
      const image = getMeta('image');
      let site_name = getMeta('site_name');
      if (!site_name) {
        try { site_name = new URL(url).hostname; } catch {}
      }
      if (!title && !description) return null;
      return { url, title: (title || '').slice(0, 150), description: (description || '').slice(0, 300), image, site_name };
    } catch {
      return null;
    }
  }

  function getPollData(msgId, viewerId = 0) {
    if (!msgId) return null;
    const poll = db.prepare('SELECT * FROM polls WHERE message_id = ?').get(msgId);
    if (!poll) return null;
    const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position, id').all(poll.id);
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM poll_votes WHERE poll_id = ?').get(poll.id).c;
    const myVotes = viewerId
      ? db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(poll.id, viewerId).map((r) => r.option_id)
      : [];

    const optsWithCounts = options.map((opt) => {
      const count = db.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE option_id = ?').get(opt.id).c;
      const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      return {
        id: Number(opt.id),
        text: opt.text,
        votes: count,
        percent,
        chosen: myVotes.includes(Number(opt.id)),
      };
    });

    return {
      id: Number(poll.id),
      question: poll.question,
      is_anonymous: !!poll.is_anonymous,
      allows_multiple: !!poll.allows_multiple,
      is_quiz: !!poll.is_quiz,
      correct_option_id: poll.correct_option_id ? Number(poll.correct_option_id) : null,
      closed: !!poll.closed,
      total_votes: totalVotes,
      my_votes: myVotes,
      options: optsWithCounts,
    };
  }

  function saveFile(file, userId) {
    const name = fixFileName(file.originalname || 'فایل');
    const info = db
      .prepare('INSERT INTO files (stored_name, original_name, mime_type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(file.filename, name, file.mimetype || 'application/octet-stream', file.size, userId, Date.now());
    return Number(info.lastInsertRowid);
  }

  const getMembership = (chatId, userId) =>
    db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);

  const chatMemberCount = (chatId) =>
    db.prepare('SELECT COUNT(*) AS c FROM chat_members WHERE chat_id = ?').get(chatId).c;

  const MESSAGE_SELECT = `
    SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name,
           u.avatar_file_id AS sender_avatar_file_id,
           f.original_name AS file_name, f.mime_type AS file_mime, f.size AS file_size,
           r.id AS reply_id, r.text AS reply_text, r.file_id AS reply_file_id,
           ru.display_name AS reply_sender_name, rf.mime_type AS reply_file_mime
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id
    LEFT JOIN files rf ON rf.id = r.file_id`;

  const getMessageFull = (id) => db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);

  function getMessageReactions(msgId, viewerId) {
    if (!msgId) return [];
    try {
      return db
        .prepare(`SELECT emoji, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
                  FROM message_reactions WHERE message_id = ? GROUP BY emoji`)
        .all(viewerId || 0, msgId)
        .map((r) => ({ emoji: r.emoji, count: Number(r.count), me: !!r.me }));
    } catch {
      return [];
    }
  }

  function postServiceMessage(chatId, actorId, text) {
    const now = Date.now();
    const info = db
      .prepare('INSERT INTO messages (chat_id, sender_id, text, is_service, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(chatId, actorId, text, now);
    const msgId = Number(info.lastInsertRowid);
    const payload = messagePayload(getMessageFull(msgId));
    const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
    for (const m of members) sock.emitToUser(m.user_id, 'message', payload);
    return payload;
  }

  function ensureInviteCode(chatId) {
    let row = db.prepare('SELECT invite_code FROM chats WHERE id = ?').get(chatId);
    if (row && row.invite_code) return row.invite_code;
    const code = crypto.randomBytes(8).toString('hex');
    db.prepare('UPDATE chats SET invite_code = ? WHERE id = ?').run(code, chatId);
    return code;
  }

  function messagePayload(row, viewerId = 0) {
    let linkPreview = null;
    if (row.link_preview) {
      try { linkPreview = JSON.parse(row.link_preview); } catch {}
    }
    return {
      id: Number(row.id),
      chat_id: Number(row.chat_id),
      text: row.text,
      is_service: !!row.is_service,
      is_silent: !!row.is_silent,
      is_voice: !!(row.is_voice || (row.file_mime && row.file_mime.startsWith('audio/'))),
      edited_at: row.edited_at ? Number(row.edited_at) : null,
      link_preview: linkPreview,
      topic_id: row.topic_id ? Number(row.topic_id) : null,
      created_at: Number(row.created_at),
      sender: {
        id: Number(row.sender_id),
        username: row.sender_username,
        display_name: row.sender_display_name,
        avatar_url: fileUrl(row.sender_avatar_file_id),
      },
      file: row.file_id
        ? { id: Number(row.file_id), name: row.file_name, mime: row.file_mime, size: Number(row.file_size), url: fileUrl(row.file_id) }
        : null,
      reply_to: row.reply_id
        ? {
            id: Number(row.reply_id),
            text: row.reply_text,
            sender_name: row.reply_sender_name,
            mime: row.reply_file_mime,
          }
        : null,
      forward: row.forward_from_id ? { from_name: row.forward_from_name } : null,
      reactions: getMessageReactions(Number(row.id), viewerId),
      poll: getPollData(Number(row.id), viewerId),
    };
  }

  function chatListItem(chatId, viewerId) {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return null;
    const member = getMembership(chatId, viewerId);
    if (!member) return null;

    const isSaved = !!chat.is_saved;
    let peer = null;
    let maxPeerRead = 0;
    if (chat.type === 'private' && !isSaved) {
      const p = db
        .prepare(`SELECT u.*, cm.last_read_id AS peer_last_read FROM chat_members cm
                  JOIN users u ON u.id = cm.user_id
                  WHERE cm.chat_id = ? AND cm.user_id != ?`)
        .get(chatId, viewerId);
      if (p) {
        maxPeerRead = Number(p.peer_last_read || 0);
        peer = {
          ...userPublic(p, viewerId),
          online: sock.isOnline(p.id),
          last_seen_at: p.last_seen_at,
          last_read_id: maxPeerRead,
        };
      }
    } else if (!isSaved) {
      const g = db
        .prepare(`SELECT COALESCE(MAX(last_read_id), 0) AS max_read FROM chat_members
                  WHERE chat_id = ? AND user_id != ?`)
        .get(chatId, viewerId);
      maxPeerRead = Number(g ? g.max_read : 0);
    }

    const last = db.prepare(`${MESSAGE_SELECT} WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1`).get(chatId);
    const unread = db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND id > ? AND sender_id != ?')
      .get(chatId, member.last_read_id || 0, viewerId).c;

    const isMuted = member.muted_until === -1 || (Number(member.muted_until) > 0 && Number(member.muted_until) > Date.now());

    let pinnedMsg = null;
    if (chat.pinned_message_id) {
      const pRow = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(chat.pinned_message_id);
      if (pRow) pinnedMsg = messagePayload(pRow, viewerId);
    }

    return {
      id: Number(chat.id),
      type: isSaved ? 'saved' : chat.type,
      is_saved: isSaved,
      title: isSaved ? 'پیام‌های ذخیره‌شده' : chat.title,
      about: chat.about || null,
      avatar_url: isSaved ? null : fileUrl(chat.avatar_file_id),
      member_count: isSaved ? 1 : chatMemberCount(chatId),
      role: member.role,
      peer,
      max_peer_read_id: maxPeerRead,
      invite_code: (!isSaved && chat.type !== 'private') ? (chat.invite_code || ensureInviteCode(chat.id)) : null,
      pinned: !!member.pinned,
      pinned_message_id: chat.pinned_message_id ? Number(chat.pinned_message_id) : null,
      pinned_message: pinnedMsg,
      topics_enabled: !!chat.topics_enabled,
      muted_until: Number(member.muted_until || 0),
      is_muted: isMuted,
      unread_count: unread,
      updated_at: last ? Number(last.created_at) : Number(chat.created_at),
      last_message: last
        ? {
            id: Number(last.id),
            sender_id: Number(last.sender_id),
            sender_name: last.sender_display_name,
            text: last.text,
            is_service: !!last.is_service,
            is_silent: !!last.is_silent,
            is_voice: !!(last.is_voice || (last.file_mime && last.file_mime.startsWith('audio/'))),
            edited_at: last.edited_at ? Number(last.edited_at) : null,
            created_at: Number(last.created_at),
            file: last.file_id ? { mime: last.file_mime, name: last.file_name } : null,
          }
        : null,
    };
  }

  // فرآیند پس‌زمینه برای ارسال پیام‌های زمان‌بندی‌شده
  const schedTimer = setInterval(() => {
    try {
      const now = Date.now();
      const due = db.prepare('SELECT * FROM scheduled_messages WHERE scheduled_for <= ?').all(now);
      for (const s of due) {
        db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(s.id);
        const info = db
          .prepare('INSERT INTO messages (chat_id, sender_id, text, file_id, reply_to_id, is_silent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(s.chat_id, s.sender_id, s.text, s.file_id, s.reply_to_id, s.is_silent, now);
        const msgId = Number(info.lastInsertRowid);
        db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(msgId, s.chat_id, s.sender_id);
        const payload = messagePayload(getMessageFull(msgId));
        const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(s.chat_id);
        for (const m of members) sock.emitToUser(m.user_id, 'message', payload);
      }
    } catch {}
  }, 2000);
  if (schedTimer && typeof schedTimer.unref === 'function') schedTimer.unref();

  // حذف کامل گفتگو به‌همراه پیام‌ها و پاک‌سازی فایل‌های بی‌استفاده
  function deleteChatCompletely(chatId) {
    const chat = db.prepare('SELECT avatar_file_id FROM chats WHERE id = ?').get(chatId);
    const fileIds = db
      .prepare('SELECT DISTINCT file_id AS fid FROM messages WHERE chat_id = ? AND file_id IS NOT NULL')
      .all(chatId)
      .map((r) => r.fid);
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    for (const fid of fileIds) cleanupFileIfUnused(fid);
    if (chat && chat.avatar_file_id) cleanupFileIfUnused(chat.avatar_file_id);
  }

  // حذف فایل در صورت نبود هیچ ارجاعی
  function cleanupFileIfUnused(fid) {
    const used =
      db.prepare('SELECT 1 AS x FROM messages WHERE file_id = ?').get(fid) ||
      db.prepare('SELECT 1 AS x FROM users WHERE avatar_file_id = ?').get(fid) ||
      db.prepare('SELECT 1 AS x FROM chats WHERE avatar_file_id = ?').get(fid);
    if (used) return;
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fid);
    if (!f) return;
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name));
    } catch {}
    db.prepare('DELETE FROM files WHERE id = ?').run(fid);
  }

  const isModerator = (member) => member && ['owner', 'admin'].includes(member.role);

  /* ---------------- احراز هویت ---------------- */

  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token || '';
    const row = token
      ? db.prepare('SELECT u.*, s.token AS session_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token)
      : null;
    if (!row) return next(err(401, 'ابتدا وارد حساب خود شوید.'));
    req.user = row;
    req.token = token;
    next();
  }

  function requireApproved(req, res, next) {
    if (req.user && req.user.status === 'pending') {
      return next(err(403, 'حساب شما در انتظار تایید ادمین است و دسترسی به این بخش را ندارید.'));
    }
    next();
  }

  function sendSafirBotMessage(toUserId, text) {
    const safir = ensureSafirBot();
    if (!safir || Number(safir.id) === Number(toUserId)) return null;
    let chatId;
    const existing = db.prepare(`
      SELECT c.id FROM chats c
      JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
      JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private' AND c.is_saved = 0
    `).get(safir.id, toUserId);
    if (existing) {
      chatId = Number(existing.id);
    } else {
      const now = Date.now();
      const cInfo = db.prepare("INSERT INTO chats (type, created_by, created_at) VALUES ('private', ?, ?)").run(safir.id, now);
      chatId = Number(cInfo.lastInsertRowid);
      db.prepare("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)").run(chatId, safir.id, now);
      db.prepare("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)").run(chatId, toUserId, now);
    }
    const now = Date.now();
    const mInfo = db.prepare("INSERT INTO messages (chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)").run(chatId, safir.id, text, now);
    const msgId = Number(mInfo.lastInsertRowid);
    db.prepare("UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?").run(msgId, chatId, safir.id);
    const payload = messagePayload(getMessageFull(msgId));
    sock.emitToUser(toUserId, 'message', payload);
    const chatItem = chatListItem(chatId, toUserId);
    if (chatItem) sock.emitToUser(toUserId, 'chat', chatItem);
    return { chatId, msgId, payload };
  }

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.post(
    '/auth/register',
    upload.single('avatar'),
    h(async (req, res) => {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const display_name = String(req.body.display_name || '').trim();

      if (!USERNAME_RE.test(username)) throw err(400, 'نام کاربری باید ۳ تا ۲۴ نویسه باشد: حروف انگلیسی، عدد یا _');
      if (password.length < 6) throw err(400, 'رمز عبور باید حداقل ۶ کاراکتر باشد.');
      if (!display_name || display_name.length > 50) throw err(400, 'نام نمایشی را وارد کنید (حداکثر ۵۰ کاراکتر).');
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        throw err(409, 'این نام کاربری قبلاً ثبت شده است.');
      }

      let avatarFileId = null;
      if (req.file) avatarFileId = saveFile(req.file, null);

      const now = Date.now();
      const info = db
        .prepare('INSERT INTO users (username, password_hash, display_name, avatar_file_id, status, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(username, hashPassword(password), display_name, avatarFileId, 'pending', now, now);
      const userId = Number(info.lastInsertRowid);
      if (avatarFileId) {
        db.prepare('UPDATE files SET uploaded_by = ? WHERE id = ?').run(userId, avatarFileId);
      }

      const token = newToken();
      db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now);

      // ارسال پیام توسط ربات سفیر: "شما در انتظار تایید ادمین هستید"
      sendSafirBotMessage(userId, 'شما در انتظار تایید ادمین هستید');

      const u = getUserById(userId);
      res.json({ token, user: { ...userPublic(u), last_seen_at: u.last_seen_at } });
    })
  );

  api.post(
    '/auth/login',
    h(async (req, res) => {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!u || !verifyPassword(password, u.password_hash)) throw err(401, 'نام کاربری یا رمز عبور اشتباه است.');

      const token = newToken();
      db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, u.id, Date.now());
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), u.id);
      res.json({ token, user: { ...userPublic(u), last_seen_at: u.last_seen_at } });
    })
  );

  api.post(
    '/auth/logout',
    auth,
    h(async (req, res) => {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), req.user.id);
      res.json({ ok: true });
    })
  );

  api.get('/me', auth, h(async (req, res) => {
    res.json({ ...userPublic(req.user, req.user.id), last_seen_at: req.user.last_seen_at });
  }));

  api.put(
    '/me',
    auth,
    upload.single('avatar'),
    h(async (req, res) => {
      const display_name = String(req.body.display_name || '').trim();
      if (!display_name || display_name.length > 50) throw err(400, 'نام نمایشی نامعتبر است.');
      let avatarFileId = req.user.avatar_file_id;
      if (req.file) avatarFileId = saveFile(req.file, req.user.id);
      const bio = req.body.bio !== undefined ? String(req.body.bio || '').trim().slice(0, 150) : (req.user.bio || '');
      const privacy = req.body.privacy_last_seen === 'nobody' ? 'nobody' : (req.user.privacy_last_seen || 'everyone');
      db.prepare('UPDATE users SET display_name = ?, avatar_file_id = ?, bio = ?, privacy_last_seen = ? WHERE id = ?')
        .run(display_name, avatarFileId, bio, privacy, req.user.id);
      const u = getUserById(req.user.id);
      res.json({ ...userPublic(u, req.user.id), last_seen_at: u.last_seen_at });
    })
  );

  api.put(
    '/me/privacy',
    auth,
    h(async (req, res) => {
      const privacy = req.body.privacy_last_seen === 'nobody' ? 'nobody' : 'everyone';
      db.prepare('UPDATE users SET privacy_last_seen = ? WHERE id = ?').run(privacy, req.user.id);
      res.json({ ok: true, privacy_last_seen: privacy });
    })
  );

  api.get(
    '/me/blocked',
    auth,
    h(async (req, res) => {
      const rows = db.prepare(`
        SELECT u.*, b.created_at AS blocked_at
        FROM blocked_users b
        JOIN users u ON u.id = b.blocked_id
        WHERE b.user_id = ?
        ORDER BY b.created_at DESC
      `).all(req.user.id);
      res.json({ blocked: rows.map((u) => userPublic(u, req.user.id)) });
    })
  );

  api.post(
    '/users/:id/block',
    auth,
    h(async (req, res) => {
      const targetId = Number(req.params.id);
      if (!targetId || targetId === req.user.id) throw err(400, 'شناسه کاربر نامعتبر است.');
      if (!getUserById(targetId)) throw err(404, 'کاربر پیدا نشد.');
      db.prepare('INSERT OR IGNORE INTO blocked_users (user_id, blocked_id, created_at) VALUES (?, ?, ?)')
        .run(req.user.id, targetId, Date.now());
      res.json({ ok: true, blocked: true });
    })
  );

  api.post(
    '/users/:id/unblock',
    auth,
    h(async (req, res) => {
      const targetId = Number(req.params.id);
      db.prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_id = ?').run(req.user.id, targetId);
      res.json({ ok: true, blocked: false });
    })
  );

  /* ---------------- کاربران و جستجو ---------------- */

  api.get(
    '/users',
    auth,
    h(async (req, res) => {
      const q = String(req.query.q || '').trim();
      const like = `%${q}%`;
      const rows = db
        .prepare(`SELECT id, username, display_name, avatar_file_id FROM users
                  WHERE id != ? AND (? = '' OR username LIKE ? OR display_name LIKE ?)
                  ORDER BY display_name LIMIT 200`)
        .all(req.user.id, q, like, like);
      res.json({ users: rows.map(userPublic) });
    })
  );

  // فقط کاربرانی که با آنها گفتگوی خصوصی داشته‌ام (مخاطبین من)
  api.get(
    '/contacts',
    auth,
    h(async (req, res) => {
      const q = String(req.query.q || '').trim();
      const like = `%${q}%`;
      const rows = db
        .prepare(`
          SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_file_id
          FROM users u
          JOIN chat_members cm_peer ON cm_peer.user_id = u.id
          JOIN chats c ON c.id = cm_peer.chat_id
          JOIN chat_members cm_me ON cm_me.chat_id = c.id AND cm_me.user_id = ?
          WHERE u.id != ? AND c.type = 'private'
            AND (? = '' OR u.username LIKE ? OR u.display_name LIKE ?)
          ORDER BY u.display_name
        `)
        .all(req.user.id, req.user.id, q, like, like);
      res.json({ contacts: rows.map(userPublic) });
    })
  );

  // لیست کاربرانی که پیام گروهی را خوانده‌اند
  api.get(
    '/messages/:id/seen-by',
    auth,
    h(async (req, res) => {
      const msgId = Number(req.params.id);
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      if (!msg) throw err(404, 'پیام پیدا نشد.');
      const member = getMembership(msg.chat_id, req.user.id);
      if (!member) throw err(403, 'دسترسی ندارید.');
      // فقط برای گروه‌ها
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(msg.chat_id);
      if (!chat || chat.type !== 'group') throw err(400, 'این قابلیت فقط برای گروه‌ها موجود است.');
      // کاربرانی که last_read_id >= msgId دارند (به جز فرستنده)
      const readers = db.prepare(`
        SELECT u.id, u.display_name, u.username, u.avatar_file_id, cm.last_read_id AS seen_at
        FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.last_read_id >= ? AND cm.user_id != ?
        ORDER BY cm.last_read_id DESC
      `).all(msg.chat_id, msgId, msg.sender_id);
      res.json({
        seen_by: readers.map((u) => ({
          id: Number(u.id),
          display_name: u.display_name,
          username: u.username,
          avatar_url: fileUrl(u.avatar_file_id),
          seen_at: Number(u.seen_at) || null,
        })),
      });
    })
  );

  api.get(
    '/search/users',
    auth,
    h(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ users: [] });
      const like = `%${q}%`;
      const rows = db
        .prepare(`SELECT id, username, display_name, avatar_file_id FROM users
                  WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
                  ORDER BY username LIMIT 20`)
        .all(req.user.id, like, like);
      res.json({ users: rows.map(userPublic) });
    })
  );

  /* ---------------- گفتگوها ---------------- */

  api.get(
    '/chats',
    auth,
    h(async (req, res) => {
      const rows = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(req.user.id);
      const items = rows.map((r) => chatListItem(r.chat_id, req.user.id)).filter(Boolean);
      items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
      res.json({ chats: items });
    })
  );

  api.get(
    '/chats/:id',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const item = chatListItem(chatId, req.user.id);
      if (!item) throw err(404, 'گفتگو پیدا نشد.');
      const members = db
        .prepare(`SELECT u.id, u.username, u.display_name, u.avatar_file_id, cm.role, cm.joined_at
                  FROM chat_members cm JOIN users u ON u.id = cm.user_id
                  WHERE cm.chat_id = ?
                  ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at, u.display_name`)
        .all(chatId);
      item.members = members.map((u) => ({ ...userPublic(u), role: u.role }));
      res.json(item);
    })
  );

  // شروع یا بازکردن چت خصوصی با یک کاربر
  api.post(
    '/chats/private',
    auth,
    requireApproved,
    h(async (req, res) => {
      const targetId = Number(req.body.user_id);
      if (!targetId || targetId === req.user.id) throw err(400, 'کاربر نامعتبر است.');
      const target = getUserById(targetId);
      if (!target) throw err(404, 'کاربر پیدا نشد.');
      if (isBlockedBetween(req.user.id, targetId)) throw err(403, 'ارتباط با این کاربر مسدود است.');

      const existing = db
        .prepare(`SELECT c.id FROM chats c
                  JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
                  JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
                  WHERE c.type = 'private' AND c.is_saved = 0 AND (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) = 2`)
        .get(req.user.id, targetId);

      if (existing) {
        return res.json({ chat_id: Number(existing.id), created: false, chat: chatListItem(existing.id, req.user.id) });
      }

      const now = Date.now();
      db.exec('BEGIN');
      try {
        const info = db
          .prepare("INSERT INTO chats (type, title, avatar_file_id, created_by, created_at) VALUES ('private', NULL, NULL, ?, ?)")
          .run(req.user.id, now);
        const chatId = Number(info.lastInsertRowid);
        const ins = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
        ins.run(chatId, req.user.id, 'member', now);
        ins.run(chatId, targetId, 'member', now);
        db.exec('COMMIT');
        sock.emitToUser(targetId, 'chat', chatListItem(chatId, targetId));
        res.json({ chat_id: chatId, created: true, chat: chatListItem(chatId, req.user.id) });
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    })
  );

  // دریافت یا ساخت گفتگوی پیام‌های ذخیره‌شده (Saved Messages)
  api.post(
    '/chats/saved',
    auth,
    h(async (req, res) => {
      const existing = db.prepare('SELECT id FROM chats WHERE is_saved = 1 AND created_by = ?').get(req.user.id);
      if (existing) {
        return res.json({ chat_id: Number(existing.id), chat: chatListItem(existing.id, req.user.id) });
      }
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const info = db
          .prepare("INSERT INTO chats (type, title, is_saved, created_by, created_at) VALUES ('private', 'پیام‌های ذخیره‌شده', 1, ?, ?)")
          .run(req.user.id, now);
        const chatId = Number(info.lastInsertRowid);
        db.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(chatId, req.user.id, now);
        db.exec('COMMIT');
        res.json({ chat_id: chatId, chat: chatListItem(chatId, req.user.id) });
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    })
  );

  // ساخت گروه یا کانال
  api.post(
    '/chats',
    auth,
    requireApproved,
    upload.single('avatar'),
    h(async (req, res) => {
      const type = String(req.body.type || '');
      if (!['group', 'channel'].includes(type)) throw err(400, 'نوع گفتگو نامعتبر است.');
      const title = String(req.body.title || '').trim();
      if (!title || title.length > 80) {
        throw err(400, type === 'group' ? 'نام گروه را وارد کنید.' : 'نام کانال را وارد کنید.');
      }
      const about = String(req.body.about || '').trim().slice(0, 300);

      let memberIds = [];
      try {
        if (Array.isArray(req.body.member_ids)) {
          memberIds = req.body.member_ids.map(Number).filter(Boolean);
        } else if (typeof req.body.member_ids === 'string') {
          const parsed = JSON.parse(req.body.member_ids);
          memberIds = Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
        }
      } catch {
        memberIds = [];
      }
      memberIds = [...new Set(memberIds)].filter((id) => id !== req.user.id);
      for (const id of memberIds) {
        if (!getUserById(id)) throw err(400, 'یکی از اعضای انتخاب‌شده پیدا نشد.');
      }

      let avatarFileId = null;
      if (req.file) avatarFileId = saveFile(req.file, req.user.id);

      const now = Date.now();
      let chatId;
      db.exec('BEGIN');
      try {
        const info = db
          .prepare('INSERT INTO chats (type, title, about, avatar_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(type, title, about || null, avatarFileId, req.user.id, now);
        chatId = Number(info.lastInsertRowid);
        db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(chatId, req.user.id, 'owner', now);
        const ins = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
        for (const id of memberIds) ins.run(chatId, id, 'member', now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      postServiceMessage(chatId, req.user.id, `«${req.user.display_name}» ${type === 'group' ? 'گروه' : 'کانال'} «${title}» را ایجاد کرد`);

      for (const id of memberIds) sock.emitToUser(id, 'chat', chatListItem(chatId, id));
      res.json({ chat_id: chatId, chat: chatListItem(chatId, req.user.id) });
    })
  );

  // ویرایش گروه/کانال (نام، توضیحات، عکس) — فقط مدیران
  api.put(
    '/chats/:id',
    auth,
    upload.single('avatar'),
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      if (chat.type === 'private') throw err(400, 'گفتگوی خصوصی قابل ویرایش نیست.');
      const me = getMembership(chatId, req.user.id);
      if (!isModerator(me)) throw err(403, 'فقط مدیران می‌توانند گفتگو را ویرایش کنند.');

      const title = String(req.body.title || '').trim();
      if (!title || title.length > 80) throw err(400, 'نام گفتگو نامعتبر است.');
      const about = String(req.body.about || '').trim().slice(0, 300);
      let avatarFileId = chat.avatar_file_id;
      if (req.file) avatarFileId = saveFile(req.file, req.user.id);

      db.prepare('UPDATE chats SET title = ?, about = ?, avatar_file_id = ? WHERE id = ?').run(title, about || null, avatarFileId, chatId);

      if (title !== chat.title) {
        postServiceMessage(chatId, req.user.id, `«${req.user.display_name}» نام ${chat.type === 'group' ? 'گروه' : 'کانال'} را به «${title}» تغییر داد`);
      }

      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ chat: chatListItem(chatId, req.user.id) });
    })
  );

  // حذف گفتگو: خصوصی برای هر دو طرف؛ گروه/کانال فقط سازنده
  api.delete(
    '/chats/:id',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!me) throw err(403, 'عضو این گفتگو نیستید.');
      if (chat.type !== 'private' && me.role !== 'owner') {
        throw err(403, 'فقط سازنده می‌تواند گفتگو را حذف کند.');
      }

      const memberIds = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((r) => r.user_id);
      deleteChatCompletely(chatId);
      for (const uid of memberIds) sock.emitToUser(uid, 'chat-removed', { chat_id: chatId });
      res.json({ ok: true });
    })
  );

  // پاک کردن تاریخچه پیام‌ها
  api.delete(
    '/chats/:id/messages',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!me) throw err(403, 'عضو این گفتگو نیستید.');
      if (chat.type !== 'private' && !isModerator(me)) {
        throw err(403, 'فقط مدیران می‌توانند تاریخچه را پاک کنند.');
      }

      const fileIds = db
        .prepare('SELECT DISTINCT file_id AS fid FROM messages WHERE chat_id = ? AND file_id IS NOT NULL')
        .all(chatId)
        .map((r) => r.fid);
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      db.prepare('UPDATE chat_members SET last_read_id = 0 WHERE chat_id = ?').run(chatId);
      for (const fid of fileIds) cleanupFileIfUnused(fid);

      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true });
    })
  );

  // ترک گروه/کانال — اگر سازنده برود، مدیریت به قدیمی‌ترین مدیر یا عضو می‌رسد
  api.post(
    '/chats/:id/leave',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      if (chat.type === 'private') throw err(400, 'برای گفتگوی خصوصی از حذف گفتگو استفاده کنید.');
      const me = getMembership(chatId, req.user.id);
      if (!me) throw err(403, 'عضو این گفتگو نیستید.');

      const wasOwner = me.role === 'owner';
      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);

      const remaining = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? ORDER BY joined_at, user_id').all(chatId);
      if (!remaining.length) {
        deleteChatCompletely(chatId);
        sock.emitToUser(req.user.id, 'chat-removed', { chat_id: chatId });
        return res.json({ ok: true, deleted: true });
      }
      if (wasOwner) {
        const next = remaining.find((r) => r.role === 'admin') || remaining[0];
        db.prepare("UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?").run(chatId, next.user_id);
      }

      postServiceMessage(chatId, req.user.id, `«${req.user.display_name}» ${chat.type === 'group' ? 'گروه' : 'کانال'} را ترک کرد`);

      sock.emitToUser(req.user.id, 'chat-removed', { chat_id: chatId });
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true });
    })
  );

  // سنجاق/برداشتن سنجاق گفتگو در فهرست خودم
  api.post(
    '/chats/:id/pin',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const pinned = req.body.pinned ? 1 : 0;
      db.prepare('UPDATE chat_members SET pinned = ? WHERE chat_id = ? AND user_id = ?').run(pinned, chatId, req.user.id);
      res.json({ ok: true, pinned: !!pinned });
    })
  );

  // سنجاق کردن یا برداشتن سنجاق پیام داخل گفتگو
  api.post(
    '/chats/:id/pin-message',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!me) throw err(403, 'عضو این گفتگو نیستید.');
      if (['group', 'channel'].includes(chat.type) && !isModerator(me)) {
        throw err(403, 'فقط مدیران می‌توانند پیام را سنجاق کنند.');
      }

      const messageId = req.body.message_id ? Number(req.body.message_id) : null;
      if (messageId) {
        const m = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(messageId);
        if (!m || Number(m.chat_id) !== chatId) throw err(400, 'پیام مورد نظر در این گفتگو وجود ندارد.');
      }

      db.prepare('UPDATE chats SET pinned_message_id = ? WHERE id = ?').run(messageId, chatId);

      const pinnedMsg = messageId ? messagePayload(getMessageFull(messageId), req.user.id) : null;
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat-pin-message', {
          chat_id: chatId,
          pinned_message_id: messageId,
          pinned_message: pinnedMsg,
        });
      }

      if (messageId && !chat.is_saved) {
        postServiceMessage(chatId, req.user.id, `«${req.user.display_name}» یک پیام را سنجاق کرد`);
      }

      res.json({ ok: true, pinned_message_id: messageId, pinned_message: pinnedMsg });
    })
  );

  // بی‌صدا کردن گفتگو
  api.post(
    '/chats/:id/mute',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const minutes = Number(req.body.duration_minutes ?? -1);
      const until = minutes === -1 ? -1 : Date.now() + minutes * 60 * 1000;
      db.prepare('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?').run(until, chatId, req.user.id);
      res.json({ ok: true, muted_until: until });
    })
  );

  // با صدا کردن گفتگو
  api.post(
    '/chats/:id/unmute',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      db.prepare('UPDATE chat_members SET muted_until = 0 WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);
      res.json({ ok: true, muted_until: 0 });
    })
  );

  // علامت‌گذاری گفتگو به‌عنوان خوانده‌شده
  api.post(
    '/chats/:id/read',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE chat_id = ?').get(chatId).m;
      db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(latest, chatId, req.user.id);
      const others = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, req.user.id);
      for (const o of others) {
        sock.emitToUser(o.user_id, 'read', { chat_id: chatId, user_id: req.user.id, last_read_id: Number(latest) });
      }
      res.json({ ok: true, last_read_id: Number(latest) });
    })
  );

  /* ---------------- اعضا و نقش‌ها ---------------- */

  // افزودن عضو به گروه/کانال — فقط مدیران
  api.post(
    '/chats/:id/members',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type === 'private') throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!isModerator(me)) throw err(403, 'فقط مدیران می‌توانند عضو اضافه کنند.');

      let ids = [];
      try {
        if (Array.isArray(req.body.user_ids)) {
          ids = req.body.user_ids.map(Number).filter(Boolean);
        } else if (typeof req.body.user_ids === 'string') {
          const parsed = JSON.parse(req.body.user_ids);
          ids = Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
        }
      } catch {
        ids = [];
      }
      ids = [...new Set(ids)];
      const now = Date.now();
      const ins = db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
      const added = [];
      for (const id of ids) {
        if (!getUserById(id)) throw err(400, 'یکی از کاربران پیدا نشد.');
        if (ins.run(chatId, id, now).changes > 0) added.push(id);
      }

      for (const id of added) {
        const u = getUserById(id);
        if (u) postServiceMessage(chatId, req.user.id, `«${req.user.display_name}»، «${u.display_name}» را به ${chat.type === 'group' ? 'گروه' : 'کانال'} اضافه کرد`);
      }

      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true, added: added.length });
    })
  );

  // حذف عضو از گروه/کانال — فقط مدیران (مدیر نمی‌تواند مدیر دیگر یا سازنده را حذف کند)
  api.delete(
    '/chats/:id/members/:uid',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const uid = Number(req.params.uid);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type === 'private') throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!isModerator(me)) throw err(403, 'فقط مدیران می‌توانند عضو حذف کنند.');

      const target = getMembership(chatId, uid);
      if (!target) throw err(404, 'این کاربر عضو این گفتگو نیست.');
      if (target.role === 'owner') throw err(403, 'سازنده قابل حذف نیست.');
      if (me.role === 'admin' && target.role === 'admin') throw err(403, 'مدیر نمی‌تواند مدیر دیگر را حذف کند.');

      const targetUser = getUserById(uid);
      db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, uid);

      if (targetUser) {
        postServiceMessage(chatId, req.user.id, `«${req.user.display_name}»، «${targetUser.display_name}» را از ${chat.type === 'group' ? 'گروه' : 'کانال'} حذف کرد`);
      }

      sock.emitToUser(uid, 'chat-removed', { chat_id: chatId });
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true });
    })
  );

  // تغییر نقش عضو (ارتقا به مدیر / سلب مدیریت)
  api.put(
    '/chats/:id/members/:uid',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const uid = Number(req.params.uid);
      const role = String(req.body.role || '');
      if (!['admin', 'member'].includes(role)) throw err(400, 'نقش نامعتبر است.');

      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type === 'private') throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!isModerator(me)) throw err(403, 'فقط مدیران می‌توانند نقش‌ها را تغییر دهند.');

      const target = getMembership(chatId, uid);
      if (!target) throw err(404, 'این کاربر عضو این گفتگو نیست.');
      if (target.role === 'owner') throw err(403, 'نقش سازنده قابل تغییر نیست.');
      if (uid === req.user.id) throw err(400, 'نمی‌توانید نقش خودتان را تغییر دهید.');
      if (me.role === 'admin' && (target.role !== 'member' || role !== 'admin')) {
        throw err(403, 'مدیران فقط می‌توانند اعضای عادی را مدیر کنند.');
      }

      db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run(role, chatId, uid);
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true });
    })
  );

  /* ---------------- پیام‌ها ---------------- */

  api.get(
    '/chats/:id/messages',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'به این گفتگو دسترسی ندارید.');
      const before = req.query.before ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const topicId = req.query.topic_id ? Number(req.query.topic_id) : null;

      let sql = `${MESSAGE_SELECT} WHERE m.chat_id = ? AND m.id < ?`;
      const params = [chatId, before];
      if (topicId) {
        sql += ' AND m.topic_id = ?';
        params.push(topicId);
      }
      sql += ' ORDER BY m.id DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      rows.reverse();

      const gRead = db.prepare('SELECT COALESCE(MAX(last_read_id), 0) AS max_read FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chatId, req.user.id);
      const maxPeerRead = Number(gRead ? gRead.max_read : 0);

      res.json({
        messages: rows.map((m) => messagePayload(m, req.user.id)),
        max_peer_read_id: maxPeerRead,
      });
    })
  );

  api.post(
    '/chats/:id/messages',
    auth,
    upload.single('file'),
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const member = getMembership(chatId, req.user.id);
      if (!member) throw err(403, 'عضو این گفتگو نیستید.');
      if (req.user.status === 'pending') {
        throw err(403, 'حساب شما در انتظار تایید ادمین است و امکان ارسال پیام ندارید.');
      }
      if (chat.type === 'channel' && !isModerator(member)) {
        throw err(403, 'فقط مدیران می‌توانند در کانال پیام منتشر کنند.');
      }

      if (chat.type === 'private' && !chat.is_saved) {
        const peer = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chatId, req.user.id);
        if (peer && isBlockedBetween(req.user.id, peer.user_id)) {
          throw err(403, 'ارتباط با این کاربر مسدود است.');
        }
      }

      const text = String(req.body.text || '').trim();
      let fileId = null;
      if (req.file) fileId = saveFile(req.file, req.user.id);
      if (!text && !fileId) throw err(400, 'پیام خالی است.');
      if (text.length > 4000) throw err(400, 'متن پیام خیلی طولانی است.');

      let replyToId = null;
      if (req.body.reply_to_id && Number(req.body.reply_to_id) > 0) {
        const r = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(Number(req.body.reply_to_id));
        if (!r || Number(r.chat_id) !== chatId) throw err(400, 'پیام پاسخ‌شده معتبر نیست.');
        replyToId = Number(r.id);
      }

      const isSilent = req.body.is_silent === '1' || req.body.is_silent === 1 || req.body.is_silent === 'true' || req.body.is_silent === true ? 1 : 0;
      const isVoice = (
        req.body.is_voice === '1' ||
        req.body.is_voice === 1 ||
        req.body.is_voice === 'true' ||
        req.body.is_voice === true ||
        (req.file && req.file.mimetype && req.file.mimetype.startsWith('audio/'))
      ) ? 1 : 0;
      const topicId = req.body.topic_id ? Number(req.body.topic_id) : null;
      const scheduledAt = req.body.scheduled_at ? Number(req.body.scheduled_at) : null;

      if (scheduledAt && scheduledAt > Date.now() + 1000) {
        const schedInfo = db
          .prepare('INSERT INTO scheduled_messages (chat_id, sender_id, text, file_id, reply_to_id, is_silent, scheduled_for, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(chatId, req.user.id, text || null, fileId, replyToId, isSilent, scheduledAt, Date.now());
        return res.json({ scheduled: true, id: Number(schedInfo.lastInsertRowid), scheduled_for: scheduledAt });
      }

      let linkPreview = null;
      try {
        const lp = await fetchLinkPreview(text);
        if (lp) linkPreview = JSON.stringify(lp);
      } catch {}

      const info = db
        .prepare('INSERT INTO messages (chat_id, sender_id, text, file_id, reply_to_id, is_silent, is_voice, topic_id, link_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(chatId, req.user.id, text || null, fileId, replyToId, isSilent, isVoice, topicId, linkPreview, Date.now());

      const msgId = Number(info.lastInsertRowid);
      db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(msgId, chatId, req.user.id);

      const payload = messagePayload(getMessageFull(msgId));
      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
      for (const m of members) {
        sock.emitToUser(m.user_id, 'message', payload);
        if (Number(m.user_id) !== Number(req.user.id)) {
          sock.emitToUser(m.user_id, 'read', { chat_id: chatId, user_id: req.user.id, last_read_id: msgId });
        }
      }
      res.json(payload);
    })
  );

  // ویرایش پیام (فقط توسط فرستنده)
  api.put(
    '/messages/:id',
    auth,
    h(async (req, res) => {
      const msgId = Number(req.params.id);
      const msg = getMessageFull(msgId);
      if (!msg) throw err(404, 'پیام پیدا نشد.');
      if (Number(msg.sender_id) !== req.user.id) throw err(403, 'فقط فرستنده می‌تواند پیام را ویرایش کند.');
      if (msg.is_service) throw err(400, 'پیام‌های سیستمی قابل ویرایش نیستند.');

      const text = String(req.body.text || '').trim();
      if (!text && !msg.file_id) throw err(400, 'متن پیام نمی‌تواند خالی باشد.');
      if (text.length > 4000) throw err(400, 'متن پیام خیلی طولانی است.');

      const now = Date.now();
      let linkPreview = null;
      try {
        const lp = await fetchLinkPreview(text);
        if (lp) linkPreview = JSON.stringify(lp);
      } catch {}

      db.prepare('UPDATE messages SET text = ?, edited_at = ?, link_preview = ? WHERE id = ?').run(text, now, linkPreview, msgId);

      const updated = messagePayload(getMessageFull(msgId), req.user.id);
      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(msg.chat_id);
      for (const m of members) sock.emitToUser(m.user_id, 'message-edited', updated);
      res.json(updated);
    })
  );

  // لیست پیام‌های زمان‌بندی‌شده کاربر در گفتگو
  api.get(
    '/chats/:id/scheduled',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const rows = db.prepare('SELECT * FROM scheduled_messages WHERE chat_id = ? AND sender_id = ? ORDER BY scheduled_for ASC').all(chatId, req.user.id);
      res.json({ scheduled: rows });
    })
  );

  // لغو ارسال پیام زمان‌بندی‌شده
  api.delete(
    '/scheduled/:id',
    auth,
    h(async (req, res) => {
      const id = Number(req.params.id);
      const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
      if (!row) throw err(404, 'پیام پیدا نشد.');
      if (row.sender_id !== req.user.id) throw err(403, 'اجازه حذف ندارید.');
      db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
      res.json({ ok: true });
    })
  );

  // ایجاد نظرسنجی
  api.post(
    '/chats/:id/polls',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const member = getMembership(chatId, req.user.id);
      if (!member) throw err(403, 'عضو این گفتگو نیستید.');
      if (chat.type === 'channel' && !isModerator(member)) {
        throw err(403, 'فقط مدیران می‌توانند در کانال نظرسنجی بگذارند.');
      }

      const question = String(req.body.question || '').trim();
      if (!question || question.length > 255) throw err(400, 'صورت سوال نظرسنجی را وارد کنید.');

      let options = Array.isArray(req.body.options) ? req.body.options : [];
      options = options.map((o) => String(o || '').trim()).filter(Boolean);
      if (options.length < 2 || options.length > 10) throw err(400, 'تعداد گزینه‌ها باید بین ۲ تا ۱۰ باشد.');

      const isAnonymous = req.body.is_anonymous ? 1 : 0;
      const allowsMultiple = req.body.allows_multiple ? 1 : 0;
      const isQuiz = req.body.is_quiz ? 1 : 0;
      const correctOptionIdx = req.body.correct_option_index != null ? Number(req.body.correct_option_index) : null;

      const now = Date.now();
      let msgId, pollId;
      db.exec('BEGIN');
      try {
        const msgInfo = db
          .prepare('INSERT INTO messages (chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)')
          .run(chatId, req.user.id, `📊 ${question}`, now);
        msgId = Number(msgInfo.lastInsertRowid);

        const pollInfo = db
          .prepare('INSERT INTO polls (message_id, question, is_anonymous, allows_multiple, is_quiz, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(msgId, question, isAnonymous, allowsMultiple, isQuiz, now);
        pollId = Number(pollInfo.lastInsertRowid);

        const insOpt = db.prepare('INSERT INTO poll_options (poll_id, text, position) VALUES (?, ?, ?)');
        options.forEach((optText, idx) => {
          const optInfo = insOpt.run(pollId, optText, idx);
          if (isQuiz && correctOptionIdx === idx) {
            db.prepare('UPDATE polls SET correct_option_id = ? WHERE id = ?').run(Number(optInfo.lastInsertRowid), pollId);
          }
        });

        db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(msgId, chatId, req.user.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      const payload = messagePayload(getMessageFull(msgId), req.user.id);
      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
      for (const m of members) sock.emitToUser(m.user_id, 'message', payload);
      res.json(payload);
    })
  );

  // ثبت یا تغییر رای در نظرسنجی
  api.post(
    '/polls/:id/vote',
    auth,
    h(async (req, res) => {
      const pollId = Number(req.params.id);
      const poll = db.prepare('SELECT p.*, m.chat_id FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.id = ?').get(pollId);
      if (!poll) throw err(404, 'نظرسنجی پیدا نشد.');
      if (poll.closed) throw err(400, 'نظرسنجی بسته شده است.');

      const member = getMembership(poll.chat_id, req.user.id);
      if (!member) throw err(403, 'عضو این گفتگو نیستید.');

      let optionIds = Array.isArray(req.body.option_ids) ? req.body.option_ids.map(Number).filter(Boolean) : [];
      if (!poll.allows_multiple && optionIds.length > 1) {
        optionIds = [optionIds[0]];
      }

      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, req.user.id);
        const ins = db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)');
        for (const optId of optionIds) {
          const valid = db.prepare('SELECT 1 FROM poll_options WHERE id = ? AND poll_id = ?').get(optId, pollId);
          if (valid) ins.run(pollId, optId, req.user.id, Date.now());
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(poll.chat_id);
      for (const m of members) {
        sock.emitToUser(m.user_id, 'poll-updated', {
          message_id: poll.message_id,
          poll: getPollData(poll.message_id, m.user_id),
        });
      }
      res.json({ ok: true, poll: getPollData(poll.message_id, req.user.id) });
    })
  );

  // جستجوی سراسری پیام‌ها در تمام گفتگوهای من
  api.get(
    '/search/messages',
    auth,
    h(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ messages: [] });
      const like = `%${q}%`;
      const rows = db
        .prepare(`
          SELECT m.id, m.chat_id, m.text, m.created_at, u.display_name AS sender_name,
                 c.type AS chat_type, c.title AS chat_title, c.is_saved
          FROM messages m
          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
          JOIN chats c ON c.id = m.chat_id
          JOIN users u ON u.id = m.sender_id
          WHERE m.is_service = 0 AND m.text LIKE ?
          ORDER BY m.id DESC LIMIT 50
        `)
        .all(req.user.id, like);

      const results = rows.map((r) => ({
        id: Number(r.id),
        chat_id: Number(r.chat_id),
        chat_title: r.is_saved ? 'پیام‌های ذخیره‌شده' : (r.chat_title || r.sender_name),
        chat_type: r.is_saved ? 'saved' : r.chat_type,
        sender_name: r.sender_name,
        text: r.text,
        created_at: Number(r.created_at),
      }));
      res.json({ messages: results });
    })
  );

  // دریافت رسانه‌های اشتراک‌گذاشته‌شده در گفتگو (Shared Media)
  api.get(
    '/chats/:id/media',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const type = String(req.query.type || 'photos_videos');

      let rows = [];
      if (type === 'photos_videos') {
        rows = db.prepare(`
          SELECT m.id AS message_id, m.created_at, f.id AS file_id, f.original_name, f.mime_type, f.size
          FROM messages m
          JOIN files f ON f.id = m.file_id
          WHERE m.chat_id = ? AND (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%')
          ORDER BY m.id DESC LIMIT 100
        `).all(chatId);
      } else if (type === 'files') {
        rows = db.prepare(`
          SELECT m.id AS message_id, m.created_at, f.id AS file_id, f.original_name, f.mime_type, f.size
          FROM messages m
          JOIN files f ON f.id = m.file_id
          WHERE m.chat_id = ? AND NOT (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%' OR f.mime_type LIKE 'audio/%')
          ORDER BY m.id DESC LIMIT 100
        `).all(chatId);
      } else if (type === 'audio') {
        rows = db.prepare(`
          SELECT m.id AS message_id, m.created_at, m.is_voice, f.id AS file_id, f.original_name, f.mime_type, f.size
          FROM messages m
          JOIN files f ON f.id = m.file_id
          WHERE m.chat_id = ? AND (f.mime_type LIKE 'audio/%' OR m.is_voice = 1)
          ORDER BY m.id DESC LIMIT 100
        `).all(chatId);
      } else if (type === 'links') {
        rows = db.prepare(`
          SELECT m.id AS message_id, m.created_at, m.text, m.link_preview
          FROM messages m
          WHERE m.chat_id = ? AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%')
          ORDER BY m.id DESC LIMIT 100
        `).all(chatId);
      }

      const items = rows.map((r) => ({
        ...r,
        url: r.file_id ? fileUrl(r.file_id) : null,
        link_preview: r.link_preview ? JSON.parse(r.link_preview) : null,
      }));
      res.json({ items });
    })
  );

  // تاپیک‌ها و گفتگوهای موضوعی (Topics / Forum Mode)
  api.get(
    '/chats/:id/topics',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      if (!getMembership(chatId, req.user.id)) throw err(403, 'عضو این گفتگو نیستید.');
      const topics = db.prepare('SELECT * FROM chat_topics WHERE chat_id = ? ORDER BY id ASC').all(chatId);
      res.json({ topics });
    })
  );

  api.post(
    '/chats/:id/topics',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type !== 'group') throw err(400, 'تاپیک‌ها فقط برای گروه‌ها فعال می‌شوند.');
      const member = getMembership(chatId, req.user.id);
      if (!isModerator(member)) throw err(403, 'فقط مدیران می‌توانند تاپیک بسازند.');

      const title = String(req.body.title || '').trim();
      if (!title || title.length > 50) throw err(400, 'عنوان تاپیک نامعتبر است.');
      const icon = String(req.body.icon || '💬').trim().slice(0, 4);

      db.prepare('UPDATE chats SET topics_enabled = 1 WHERE id = ?').run(chatId);
      const info = db
        .prepare('INSERT INTO chat_topics (chat_id, title, icon, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(chatId, title, icon, req.user.id, Date.now());
      const topicId = Number(info.lastInsertRowid);
      const topic = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(topicId);

      postServiceMessage(chatId, req.user.id, `«${req.user.display_name}» تاپیک «${icon} ${title}» را ایجاد کرد`);

      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'topic-created', { chat_id: chatId, topic });
      }
      res.json({ topic });
    })
  );

  // فوروارد یک پیام به گفتگوی دیگر
  api.post(
    '/chats/:id/forward',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) throw err(404, 'گفتگو پیدا نشد.');
      const member = getMembership(chatId, req.user.id);
      if (!member) throw err(403, 'عضو این گفتگو نیستید.');
      if (chat.type === 'channel' && !isModerator(member)) {
        throw err(403, 'فقط مدیران می‌توانند در کانال پیام منتشر کنند.');
      }

      const src = getMessageFull(Number(req.body.message_id));
      if (!src) throw err(404, 'پیام اصلی پیدا نشد.');
      if (!getMembership(src.chat_id, req.user.id)) throw err(403, 'به پیام اصلی دسترسی ندارید.');

      const forwardFromId = src.forward_from_id || src.sender_id;
      const forwardFromName = src.forward_from_name || src.sender_display_name;

      const info = db
        .prepare('INSERT INTO messages (chat_id, sender_id, text, file_id, forward_from_id, forward_from_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(chatId, req.user.id, src.text, src.file_id, forwardFromId, forwardFromName, Date.now());

      const fwdMsgId = Number(info.lastInsertRowid);
      db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(fwdMsgId, chatId, req.user.id);

      const payload = messagePayload(getMessageFull(fwdMsgId));
      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
      for (const m of members) sock.emitToUser(m.user_id, 'message', payload);
      res.json(payload);
    })
  );

  // حذف پیام — فرستنده، یا مدیران در گروه/کانال
  api.delete(
    '/messages/:id',
    auth,
    h(async (req, res) => {
      const msg = getMessageFull(Number(req.params.id));
      if (!msg) throw err(404, 'پیام پیدا نشد.');
      const me = getMembership(msg.chat_id, req.user.id);
      if (!me) throw err(403, 'به این گفتگو دسترسی ندارید.');
      if (Number(msg.sender_id) !== req.user.id && !isModerator(me)) {
        throw err(403, 'اجازه حذف این پیام را ندارید.');
      }

      db.prepare('DELETE FROM messages WHERE id = ?').run(Number(msg.id));
      if (msg.file_id) cleanupFileIfUnused(msg.file_id);

      const memberIds = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(msg.chat_id).map((r) => r.user_id);
      for (const uid of memberIds) {
        sock.emitToUser(uid, 'message-deleted', { chat_id: Number(msg.chat_id), message_id: Number(msg.id) });
        sock.emitToUser(uid, 'chat', chatListItem(msg.chat_id, uid));
      }
      res.json({ ok: true });
    })
  );

  // ثبت یا تغییر ری‌اکشن به پیام (تلگرامی)
  api.post(
    '/messages/:id/reactions',
    auth,
    h(async (req, res) => {
      const msgId = Number(req.params.id);
      const msg = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(msgId);
      if (!msg) throw err(404, 'پیام پیدا نشد.');
      const me = getMembership(msg.chat_id, req.user.id);
      if (!me) throw err(403, 'به این گفتگو دسترسی ندارید.');

      const emoji = String(req.body.emoji || '').trim();
      const ALLOWED = ['👍', '❤️', '😂', '🔥', '👏', '😢', '🎉'];
      if (!ALLOWED.includes(emoji)) throw err(400, 'ایموجی نامعتبر است.');

      const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').get(msgId, req.user.id);
      if (existing && existing.emoji === emoji) {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(msgId, req.user.id);
      } else {
        db.prepare(`
          INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
        `).run(msgId, req.user.id, emoji, Date.now());
      }

      const reactions = getMessageReactions(msgId, req.user.id);
      const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(msg.chat_id);
      for (const m of members) {
        sock.emitToUser(m.user_id, 'message-reactions', {
          chat_id: Number(msg.chat_id),
          message_id: msgId,
          reactions: getMessageReactions(msgId, m.user_id),
        });
      }
      res.json({ ok: true, reactions });
    })
  );

  // پیش‌نمایش گفتگو با لینک دعوت
  api.get(
    '/chats/join/:code',
    auth,
    h(async (req, res) => {
      const code = String(req.params.code || '').trim();
      const chat = db.prepare('SELECT * FROM chats WHERE invite_code = ?').get(code);
      if (!chat) throw err(404, 'لینک دعوت نامعتبر یا منقضی شده است.');
      const member = getMembership(chat.id, req.user.id);
      res.json({
        id: Number(chat.id),
        type: chat.type,
        title: chat.title,
        about: chat.about,
        avatar_url: fileUrl(chat.avatar_file_id),
        member_count: chatMemberCount(chat.id),
        already_member: !!member,
      });
    })
  );

  // پیوستن به گروه یا کانال با لینک دعوت
  api.post(
    '/chats/join/:code',
    auth,
    requireApproved,
    h(async (req, res) => {
      const code = String(req.params.code || '').trim();
      const chat = db.prepare('SELECT * FROM chats WHERE invite_code = ?').get(code);
      if (!chat) throw err(404, 'لینک دعوت نامعتبر یا منقضی شده است.');
      const member = getMembership(chat.id, req.user.id);
      if (member) {
        return res.json({ already_member: true, chat_id: chat.id, chat: chatListItem(chat.id, req.user.id) });
      }

      const now = Date.now();
      db.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(chat.id, req.user.id, now);

      postServiceMessage(chat.id, req.user.id, `«${req.user.display_name}» با لینک دعوت به ${chat.type === 'group' ? 'گروه' : 'کانال'} پیوست`);

      const userChat = chatListItem(chat.id, req.user.id);
      sock.emitToUser(req.user.id, 'chat', userChat);
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chat.id, req.user.id)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chat.id, r.user_id));
      }
      res.json({ already_member: false, chat_id: chat.id, chat: userChat });
    })
  );

  // باطل کردن و ساخت مجدد لینک دعوت (فقط مدیران)
  api.post(
    '/chats/:id/invite-link/revoke',
    auth,
    h(async (req, res) => {
      const chatId = Number(req.params.id);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type === 'private') throw err(404, 'گفتگو پیدا نشد.');
      const me = getMembership(chatId, req.user.id);
      if (!isModerator(me)) throw err(403, 'فقط مدیران می‌توانند لینک دعوت را بازنشانی کنند.');

      const newCode = crypto.randomBytes(8).toString('hex');
      db.prepare('UPDATE chats SET invite_code = ? WHERE id = ?').run(newCode, chatId);
      for (const r of db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)) {
        sock.emitToUser(r.user_id, 'chat', chatListItem(chatId, r.user_id));
      }
      res.json({ ok: true, invite_code: newCode });
    })
  );

  /* ---------------- فایل‌ها ---------------- */

  api.get(
    '/files/:id',
    auth,
    h(async (req, res) => {
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
      if (!f) throw err(404, 'فایل پیدا نشد.');
      const p = path.join(UPLOAD_DIR, f.stored_name);
      if (!fs.existsSync(p)) throw err(404, 'فایل پیدا نشد.');

      const stat = fs.statSync(p);
      res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      const disp = req.query.download ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);

      const stream = fs.createReadStream(p);
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    })
  );

  /* ---------------- پنل مدیریت (Admin Panel API) ---------------- */

  function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.admin_token || '';
    if (!token) return next(err(401, 'دسترسی غیرمجاز. لطفاً وارد پنل مدیریت شوید.'));
    const session = db
      .prepare('SELECT a.*, s.token AS session_token FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?')
      .get(token);
    if (!session) return next(err(401, 'نشست ادمین نامعتبر یا منقضی شده است.'));
    req.admin = session;
    next();
  }

  // بررسی وضعیت راه‌اندازی پنل ادمین
  api.get('/admin/status', h(async (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.admin_token || '';
    let currentAdmin = null;
    if (token) {
      const s = db.prepare('SELECT a.id, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?').get(token);
      if (s) currentAdmin = { id: Number(s.id), username: s.username };
    }
    res.json({
      initialized: count > 0,
      logged_in: !!currentAdmin,
      admin: currentAdmin,
    });
  }));

  // راه‌اندازی اولیه (ایجاد اولین ادمین)
  api.post('/admin/setup', h(async (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
    if (count > 0) throw err(400, 'پنل ادمین قبلاً راه‌اندازی شده است.');
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || username.length < 3) throw err(400, 'نام کاربری ادمین باید حداقل ۳ کاراکتر باشد.');
    if (!password || password.length < 6) throw err(400, 'رمز عبور ادمین باید حداقل ۶ کاراکتر باشد.');

    const now = Date.now();
    const info = db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(username, hashPassword(password), now);
    const adminId = Number(info.lastInsertRowid);
    const token = newToken();
    db.prepare('INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)').run(token, adminId, now);
    res.json({ ok: true, token, admin: { id: adminId, username } });
  }));

  // بازنشانی حساب ادمین (در صورت فراموشی رمز یا نیاز به تنظیم مجدد)
  api.post('/admin/reset', h(async (req, res) => {
    db.exec('DELETE FROM admin_sessions; DELETE FROM admins;');
    res.json({ ok: true, message: 'پنل مدیریت بازنشانی شد. اکنون می‌توانید نام کاربری و رمز عبور جدید تعیین کنید.' });
  }));

  // ورود ادمین
  api.post('/admin/login', h(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!a || !verifyPassword(password, a.password_hash)) {
      throw err(401, 'نام کاربری یا رمز عبور ادمین نادرست است.');
    }
    const token = newToken();
    db.prepare('INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)').run(token, a.id, Date.now());
    res.json({ ok: true, token, admin: { id: Number(a.id), username: a.username } });
  }));

  // خروج ادمین
  api.post('/admin/logout', adminAuth, h(async (req, res) => {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(req.admin.session_token);
    res.json({ ok: true });
  }));

  // مشخصات ادمین فعلی
  api.get('/admin/me', adminAuth, h(async (req, res) => {
    res.json({ admin: { id: Number(req.admin.id), username: req.admin.username } });
  }));

  // تغییر نام کاربری و رمز عبور ادمین
  api.put('/admin/credentials', adminAuth, h(async (req, res) => {
    const currentPass = String(req.body.current_password || '');
    if (!verifyPassword(currentPass, req.admin.password_hash)) {
      throw err(400, 'رمز عبور فعلی ادمین نادرست است.');
    }
    const newUsername = req.body.new_username ? String(req.body.new_username).trim() : req.admin.username;
    if (newUsername.length < 3) throw err(400, 'نام کاربری باید حداقل ۳ کاراکتر باشد.');

    if (newUsername.toLowerCase() !== req.admin.username.toLowerCase()) {
      const exists = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?').get(newUsername, req.admin.id);
      if (exists) throw err(409, 'این نام کاربری قبلاً استفاده شده است.');
    }

    let newHash = req.admin.password_hash;
    if (req.body.new_password) {
      const newPass = String(req.body.new_password);
      if (newPass.length < 6) throw err(400, 'رمز عبور جدید باید حداقل ۶ کاراکتر باشد.');
      newHash = hashPassword(newPass);
    }

    db.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?').run(newUsername, newHash, req.admin.id);
    res.json({ ok: true, admin: { id: Number(req.admin.id), username: newUsername } });
  }));

  // لیست کاربران (در انتظار تایید و تایید شده)
  api.get('/admin/users', adminAuth, h(async (req, res) => {
    const pending = db
      .prepare("SELECT id, username, display_name, avatar_file_id, status, created_at FROM users WHERE status = 'pending' AND username != 'safir' ORDER BY created_at DESC")
      .all()
      .map((u) => ({ ...userPublic(u), created_at: Number(u.created_at) }));

    const approved = db
      .prepare("SELECT id, username, display_name, avatar_file_id, status, created_at, last_seen_at FROM users WHERE status = 'approved' AND username != 'safir' ORDER BY created_at DESC LIMIT 100")
      .all()
      .map((u) => ({ ...userPublic(u), created_at: Number(u.created_at), last_seen_at: Number(u.last_seen_at) }));

    const totalUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username != 'safir'").get().c;

    res.json({
      pending,
      approved,
      stats: {
        total_users: Number(totalUsers),
        pending_count: pending.length,
        approved_count: approved.length,
      },
    });
  }));

  // تایید کاربر توسط ادمین
  api.post('/admin/users/:id/approve', adminAuth, h(async (req, res) => {
    const targetId = Number(req.params.id);
    const u = getUserById(targetId);
    if (!u) throw err(404, 'کاربر پیدا نشد.');
    if (u.username === 'safir') throw err(400, 'ربات سفیر قابل ویرایش نیست.');

    db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(targetId);

    // ربات سفیر پیام "ادمین تاییدت کرد" را ارسال می‌کند
    sendSafirBotMessage(targetId, 'ادمین تاییدت کرد');

    // ارسال رویداد زنده به سوکت کاربر برای فعال‌سازی آنی تمام امکانات
    sock.emitToUser(targetId, 'user-status-changed', { status: 'approved' });

    res.json({ ok: true, message: 'کاربر با موفقیت تایید شد.' });
  }));

  // رد یا مسدودسازی کاربر توسط ادمین
  api.post('/admin/users/:id/reject', adminAuth, h(async (req, res) => {
    const targetId = Number(req.params.id);
    const u = getUserById(targetId);
    if (!u) throw err(404, 'کاربر پیدا نشد.');
    if (u.username === 'safir') throw err(400, 'ربات سفیر قابل ویرایش نیست.');

    db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(targetId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    sock.emitToUser(targetId, 'user-status-changed', { status: 'rejected' });
    res.json({ ok: true, message: 'کاربر رد شد.' });
  }));

  /* ---------------- مدیریت خطا ---------------- */

  // eslint-disable-next-line no-unused-vars
  api.use((error, req, res, next) => {
    if (req.file && req.file.filename) {
      const existsInDb = db.prepare('SELECT 1 FROM files WHERE stored_name = ?').get(req.file.filename);
      if (!existsInDb) {
        const p = path.join(UPLOAD_DIR, req.file.filename);
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    }
    if (error instanceof multer.MulterError) {
      const msg =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'حجم فایل بیش از حد مجاز (۲۰۰ مگابایت) است.'
          : 'خطا در بارگذاری فایل.';
      return res.status(400).json({ error: msg });
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message || 'خطای سرور' });
  });

  return api;
};
