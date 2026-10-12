'use strict';

function initSocket(io, db) {
  // نگاشت شناسه کاربر به مجموعه سوکت‌های فعالش
  const socketsByUser = new Map();

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const row = token ? db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) : null;
    if (!row) return next(new Error('unauthorized'));
    socket.data.userId = Number(row.user_id);
    next();
  });

  function emitToUser(userId, event, payload) {
    const set = socketsByUser.get(userId);
    if (set) for (const sid of set) io.to(sid).emit(event, payload);
  }

  function isOnline(userId) {
    return socketsByUser.has(userId);
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId).add(socket.id);
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
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        socketsByUser.delete(userId);
        const ts = Date.now();
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, userId);
        const u = db.prepare('SELECT privacy_last_seen FROM users WHERE id = ?').get(userId);
        const hideLastSeen = u && u.privacy_last_seen === 'nobody';
        io.emit('presence', { user_id: userId, online: false, last_seen_at: hideLastSeen ? null : ts });
      }
    });
  });

  return { emitToUser, isOnline };
}

module.exports = { initSocket };
