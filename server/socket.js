'use strict';

function initSocket(io, db) {
  // نگاشت شناسه کاربر به مجموعه سوکت‌های فعالش
  const socketsByUser = new Map();
  // نگاشت توکن نشست به مجموعه سوکت‌های فعالش
  const socketsByToken = new Map();

  // وضعیت تماس‌های فعال صوتی
  const activeCalls = new Map(); // callId -> callObj
  const userCallMap = new Map(); // userId -> callId

  let postServiceMsg = null;
  function setPostServiceMessage(fn) {
    postServiceMsg = fn;
  }

  function emitToUser(userId, event, payload) {
    const set = socketsByUser.get(userId);
    if (set) for (const sid of set) io.to(sid).emit(event, payload);
  }

  function isOnline(userId) {
    return socketsByUser.has(userId);
  }

  function recordCallLog(chatId, callerId, calleeId, text) {
    try {
      if (typeof postServiceMsg === 'function') {
        postServiceMsg(chatId, callerId, text);
        return;
      }
      const now = Date.now();
      const info = db.prepare('INSERT INTO messages (chat_id, sender_id, text, is_service, created_at) VALUES (?, ?, ?, 1, ?)').run(chatId, callerId, text, now);
      const msgId = Number(info.lastInsertRowid);
      const sender = db.prepare('SELECT id, display_name, username, avatar_file_id FROM users WHERE id = ?').get(callerId);
      const payload = {
        id: msgId,
        chat_id: chatId,
        sender: {
          id: sender ? sender.id : callerId,
          display_name: sender ? sender.display_name : '',
          username: sender ? sender.username : '',
          avatar_url: sender && sender.avatar_file_id ? `/api/files/${sender.avatar_file_id}` : null,
        },
        text,
        is_service: 1,
        created_at: now,
        reactions: []
      };
      emitToUser(callerId, 'message', payload);
      emitToUser(calleeId, 'message', payload);
    } catch (e) {
      console.error('[Call Log Error]', e);
    }
  }

  function handleCallTimeout(callId) {
    const call = activeCalls.get(callId);
    if (!call || call.status !== 'ringing') return;

    activeCalls.delete(callId);
    userCallMap.delete(call.callerId);
    userCallMap.delete(call.calleeId);

    emitToUser(call.callerId, 'call:timeout', { call_id: callId });
    emitToUser(call.calleeId, 'call:timeout', { call_id: callId });

    recordCallLog(call.chatId, call.callerId, call.calleeId, '📞 تماس صوتی بی‌پاسخ');
  }

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

    /* ═══════════════ تماس صوتی همتابه‌همتا (WebRTC Call) ═══════════════ */

    // درخواست آغاز تماس
    socket.on('call:request', ({ to_user_id, chat_id } = {}) => {
      const callerId = userId;
      const calleeId = Number(to_user_id);
      const chatId = Number(chat_id);

      if (!calleeId || !chatId) {
        return socket.emit('call:error', { message: 'اطلاعات تماس نامعتبر است.' });
      }

      if (callerId === calleeId) {
        return socket.emit('call:error', { message: 'امکان تماس با خودتان وجود ندارد.' });
      }

      if (userCallMap.has(callerId)) {
        return socket.emit('call:error', { message: 'شما در حال حاضر در یک تماس دیگر هستید.' });
      }

      const callee = db.prepare('SELECT id, username, display_name, avatar_file_id, status FROM users WHERE id = ?').get(calleeId);
      if (!callee || callee.status === 'banned') {
        return socket.emit('call:error', { message: 'کاربر مورد نظر در دسترس نیست.' });
      }

      if (callee.username === 'safir') {
        return socket.emit('call:error', { message: 'امکان برقراری تماس صوتی با ربات پشتیبان وجود ندارد.' });
      }

      // بررسی مسدودی
      const isBlocked = db.prepare('SELECT 1 FROM blocked_users WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(callerId, calleeId, calleeId, callerId);
      if (isBlocked) {
        return socket.emit('call:error', { message: 'امکان برقراری تماس با این کاربر وجود ندارد.' });
      }

      // بررسی اشتغال خط مخاطب
      if (userCallMap.has(calleeId)) {
        socket.emit('call:busy', { callee_id: calleeId, message: 'کاربر در حال مکالمه است.' });
        recordCallLog(chatId, callerId, calleeId, '📞 تماس صوتی ناموفق (کاربر پشت خط/مشغول)');
        return;
      }

      // بررسی آنلاین بودن
      if (!isOnline(calleeId)) {
        socket.emit('call:offline', { callee_id: calleeId, message: 'کاربر در حال حاضر آنلاین نیست.' });
        recordCallLog(chatId, callerId, calleeId, '📞 تماس از دست رفته (کاربر آفلاین)');
        return;
      }

      const caller = db.prepare('SELECT id, username, display_name, avatar_file_id FROM users WHERE id = ?').get(callerId);
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // مهلت ۴۵ ثانیه‌ای زنگ خوردن
      const timeoutId = setTimeout(() => {
        handleCallTimeout(callId);
      }, 45000);

      const callObj = {
        id: callId,
        callerId,
        calleeId,
        chatId,
        status: 'ringing',
        startTime: null,
        timeoutId,
      };

      activeCalls.set(callId, callObj);
      userCallMap.set(callerId, callId);
      userCallMap.set(calleeId, callId);

      // اطلاع‌رسانی به مخاطب
      emitToUser(calleeId, 'call:incoming', {
        call_id: callId,
        chat_id: chatId,
        caller: {
          id: caller.id,
          display_name: caller.display_name,
          username: caller.username,
          avatar_url: caller.avatar_file_id ? `/api/files/${caller.avatar_file_id}` : null,
        }
      });

      // تأیید آغاز زنگ برای تماس‌گیرنده
      socket.emit('call:ringing', {
        call_id: callId,
        chat_id: chatId,
        callee: {
          id: callee.id,
          display_name: callee.display_name,
          username: callee.username,
          avatar_url: callee.avatar_file_id ? `/api/files/${callee.avatar_file_id}` : null,
        }
      });
    });

    // پذیرش تماس توسط مخاطب
    socket.on('call:accept', ({ call_id } = {}) => {
      const call = activeCalls.get(call_id);
      if (!call || call.calleeId !== userId || call.status !== 'ringing') return;

      if (call.timeoutId) {
        clearTimeout(call.timeoutId);
        call.timeoutId = null;
      }
      call.status = 'connected';
      call.startTime = Date.now();

      emitToUser(call.callerId, 'call:accepted', { call_id });
      socket.emit('call:connected', { call_id });
    });

    // رد تماس (توسط مخاطب یا لغو توسط تماس‌گیرنده پیش از پاسخ)
    socket.on('call:reject', ({ call_id, reason = 'declined' } = {}) => {
      const call = activeCalls.get(call_id);
      if (!call) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;

      if (call.timeoutId) {
        clearTimeout(call.timeoutId);
        call.timeoutId = null;
      }
      activeCalls.delete(call_id);
      userCallMap.delete(call.callerId);
      userCallMap.delete(call.calleeId);

      const otherId = (call.callerId === userId) ? call.calleeId : call.callerId;
      emitToUser(otherId, 'call:rejected', { call_id, reason });

      const logText = (userId === call.callerId) ? '📞 تماس لغو شد' : '📞 تماس صوتی رد شد';
      recordCallLog(call.chatId, call.callerId, call.calleeId, logText);
    });

    // تبادل سیگنال WebRTC (Offer, Answer, ICE Candidates)
    socket.on('call:signal', ({ call_id, signal } = {}) => {
      const call = activeCalls.get(call_id);
      if (!call) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;

      const targetId = (call.callerId === userId) ? call.calleeId : call.callerId;
      emitToUser(targetId, 'call:signal', { call_id, signal, from_user_id: userId });
    });

    // پایان تماس
    socket.on('call:end', ({ call_id } = {}) => {
      const call = activeCalls.get(call_id);
      if (!call) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;

      if (call.timeoutId) {
        clearTimeout(call.timeoutId);
        call.timeoutId = null;
      }
      const duration = call.startTime ? Math.floor((Date.now() - call.startTime) / 1000) : 0;
      const wasConnected = call.status === 'connected';

      activeCalls.delete(call_id);
      userCallMap.delete(call.callerId);
      userCallMap.delete(call.calleeId);

      const otherId = (call.callerId === userId) ? call.calleeId : call.callerId;
      emitToUser(otherId, 'call:ended', { call_id, duration, ended_by: userId });
      socket.emit('call:ended', { call_id, duration, ended_by: userId });

      let logText = '📞 تماس صوتی پایان یافت';
      if (wasConnected && duration > 0) {
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const timeStr = mins > 0 ? `${mins} دقیقه و ${secs} ثانیه` : `${secs} ثانیه`;
        logText = `📞 تماس صوتی (${timeStr})`;
      } else {
        logText = '📞 تماس بی‌پاسخ';
      }
      recordCallLog(call.chatId, call.callerId, call.calleeId, logText);
    });

    socket.on('disconnect', () => {
      // بررسی تماس در حال انجام کاربر قطع‌شده
      if (userCallMap.has(userId)) {
        const callId = userCallMap.get(userId);
        const call = activeCalls.get(callId);
        if (call) {
          if (call.timeoutId) clearTimeout(call.timeoutId);
          const duration = call.startTime ? Math.floor((Date.now() - call.startTime) / 1000) : 0;
          const wasConnected = call.status === 'connected';
          const otherId = (call.callerId === userId) ? call.calleeId : call.callerId;

          activeCalls.delete(callId);
          userCallMap.delete(call.callerId);
          userCallMap.delete(call.calleeId);

          emitToUser(otherId, 'call:ended', { call_id: callId, duration, reason: 'disconnected' });

          if (wasConnected && duration > 0) {
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const timeStr = mins > 0 ? `${mins} دقیقه و ${secs} ثانیه` : `${secs} ثانیه`;
            recordCallLog(call.chatId, call.callerId, call.calleeId, `📞 تماس صوتی (${timeStr})`);
          } else {
            recordCallLog(call.chatId, call.callerId, call.calleeId, '📞 تماس صوتی قطع شد');
          }
        }
      }

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

  return { emitToUser, isOnline, disconnectSession, disconnectUser, setPostServiceMessage };
}

module.exports = { initSocket };
