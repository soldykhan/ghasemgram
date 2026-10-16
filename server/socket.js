'use strict';

function initSocket(io, db) {
  // نگاشت شناسه کاربر به مجموعه سوکت‌های فعالش
  const socketsByUser = new Map();
  // نگاشت توکن نشست به مجموعه سوکت‌های فعالش
  const socketsByToken = new Map();

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const row = token ? db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) : null;
    if (!row) return next(new Error('unauthorized'));
    const user = db.prepare('SELECT status, banned_until FROM users WHERE id = ?').get(row.user_id);
    if (user && user.status === 'banned') return next(new Error('banned'));
    if (user && user.status === 'temp_banned' && user.banned_until && user.banned_until > Date.now()) {
      return next(new Error('banned'));
    }
    socket.data.userId = Number(row.user_id);
    socket.data.token = token;
    next();
  });

  function emitToUser(userId, event, payload) {
    const set = socketsByUser.get(userId);
    if (set) for (const sid of set) io.to(sid).emit(event, payload);
  }

  function isOnline(userId) {
    return socketsByUser.has(userId);
  }

  function disconnectSession(token, reason = 'نشست شما پایان یافت.') {
    const set = socketsByToken.get(token);
    if (set) {
      for (const sid of set) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('session-terminated', { reason });
          setTimeout(() => {
            try { s.disconnect(true); } catch {}
          }, 300);
        }
      }
      socketsByToken.delete(token);
    }
  }

  function disconnectUser(userId, reason = 'حساب کاربری شما مسدود شده است.') {
    const set = socketsByUser.get(userId);
    if (set) {
      for (const sid of set) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('session-terminated', { reason });
          setTimeout(() => {
            try { s.disconnect(true); } catch {}
          }, 300);
        }
      }
      socketsByUser.delete(userId);
    }
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const token = socket.data.token;
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId).add(socket.id);

    if (token) {
      if (!socketsByToken.has(token)) socketsByToken.set(token, new Set());
      socketsByToken.get(token).add(socket.id);
    }
    io.emit('presence', { user_id: userId, online: true });

    // نشانگر «در حال نوشتن…»
    socket.on('typing', ({ chat_id, is_typing } = {}) => {
      const chatId = Number(chat_id);
      if (!chatId) return;
      const member = db.prepare('SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
      if (!member) return;
      const u = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId);
      const others = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, userId);
      for (const row of others) {
        emitToUser(row.user_id, 'typing', {
          chat_id: chatId,
          user: { id: u.id, display_name: u.display_name },
          is_typing: !!is_typing,
        });
      }
    });

    socket.on('disconnect', () => {
      const set = socketsByUser.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          socketsByUser.delete(userId);
          const ts = Date.now();
          db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, userId);
          const u = db.prepare('SELECT privacy_last_seen FROM users WHERE id = ?').get(userId);
          const hideLastSeen = u && u.privacy_last_seen === 'nobody';
          io.emit('presence', { user_id: userId, online: false, last_seen_at: hideLastSeen ? null : ts });
        }
      }
      if (token) {
        const tokenSet = socketsByToken.get(token);
        if (tokenSet) {
          tokenSet.delete(socket.id);
          if (tokenSet.size === 0) socketsByToken.delete(token);
        }
      }
    });
  });

  return { emitToUser, isOnline, disconnectSession, disconnectUser };
}

module.exports = { initSocket };
