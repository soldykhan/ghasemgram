'use strict';

/* ═══════════════════════════════════════════════════════════════════
   ماژول تماس صوتی همتابه‌همتا (WebRTC P2P Voice Call)
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  // تنظیمات STUN سرورها
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
    ]
  };

  /* ── مولد اصوات تماس با Web Audio API ── */
  class CallSoundSynthesizer {
    constructor() {
      this.ctx = null;
      this.activeOscillators = [];
      this.loopTimer = null;
    }

    init() {
      if (!this.ctx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          this.ctx = new AudioContext();
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    stopAll() {
      if (this.loopTimer) {
        clearInterval(this.loopTimer);
        this.loopTimer = null;
      }
      for (const node of this.activeOscillators) {
        try {
          node.stop();
          node.disconnect();
        } catch {}
      }
      this.activeOscillators = [];
    }

    // نوای بوق آزاد برای تماس‌گیرنده (Ringback Tone)
    playRingback() {
      this.init();
      if (!this.ctx) return;
      this.stopAll();

      const playTone = () => {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc1 = this.ctx.createOscillator();
        const osc2 = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc1.frequency.setValueAtTime(440, now);
        osc2.frequency.setValueAtTime(480, now);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
        gain.gain.setValueAtTime(0.12, now + 1.2);
        gain.gain.linearRampToValueAtTime(0, now + 1.25);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 1.25);
        osc2.stop(now + 1.25);

        this.activeOscillators.push(osc1, osc2);
      };

      playTone();
      this.loopTimer = setInterval(playTone, 4000);
    }

    // زنگ تماس ورودی ملایم و جذاب برای مخاطب (Incoming Ringtone Melody)
    playRingtone() {
      this.init();
      if (!this.ctx) return;
      this.stopAll();

      const notes = [659.25, 783.99, 880.00, 1046.50]; // E5, G5, A5, C6
      const playChimeSequence = () => {
        if (!this.ctx) return;
        const start = this.ctx.currentTime;

        notes.forEach((freq, idx) => {
          const t = start + idx * 0.16;
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);

          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

          osc.connect(gain);
          gain.connect(this.ctx.destination);

          osc.start(t);
          osc.stop(t + 0.36);
          this.activeOscillators.push(osc);
        });
      };

      playChimeSequence();
      this.loopTimer = setInterval(playChimeSequence, 2400);
    }

    // صدای بوق قطع تماس یا خط مشغول
    playEndTone() {
      this.init();
      if (!this.ctx) return;
      this.stopAll();

      const start = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const t = start + i * 0.22;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.frequency.setValueAtTime(425, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
        gain.gain.setValueAtTime(0.15, t + 0.14);
        gain.gain.linearRampToValueAtTime(0, t + 0.16);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(t);
        osc.stop(t + 0.17);
        this.activeOscillators.push(osc);
      }
    }
  }

  const soundSynth = new CallSoundSynthesizer();

  /* ── وضعیت محلی تماس ── */
  const callState = {
    callId: null,
    peerUser: null,       // { id, display_name, username, avatar_url }
    chatId: null,
    isCaller: false,
    status: 'idle',       // 'idle' | 'ringing' | 'connecting' | 'connected'
    localStream: null,
    peerConnection: null,
    pendingCandidates: [],
    timerInterval: null,
    durationSeconds: 0,
    isMuted: false,
    isSpeaker: false,
    isMinimized: false,
  };

  /* ── ارجاعات عناصر صفحه ── */
  const DOM = {
    chatCallBtn: null,
    activeModal: null,
    incomingModal: null,
    floatingPill: null,
    remoteAudio: null,

    // جزئیات تماس فعال
    callAvatar: null,
    callUserName: null,
    callStatus: null,
    callTimer: null,
    muteBtn: null,
    muteLabel: null,
    micIconOn: null,
    micIconOff: null,
    speakerBtn: null,
    speakerLabel: null,
    spkIconOn: null,
    spkIconOff: null,
    endBtn: null,
    minimizeBtn: null,

    // جزئیات تماس ورودی
    icAvatar: null,
    icCallerName: null,
    icAcceptBtn: null,
    icRejectBtn: null,

    // جزئیات نوار شناور
    fcpAvatar: null,
    fcpName: null,
    fcpTimer: null,
    fcpExpandBtn: null,
    fcpEndBtn: null,
  };

  function initDOM() {
    DOM.chatCallBtn = document.getElementById('chat-call-btn');
    DOM.activeModal = document.getElementById('active-call-modal');
    DOM.incomingModal = document.getElementById('incoming-call-modal');
    DOM.floatingPill = document.getElementById('floating-call-pill');
    DOM.remoteAudio = document.getElementById('remote-call-audio');

    DOM.callAvatar = document.getElementById('call-user-avatar');
    DOM.callUserName = document.getElementById('call-user-name');
    DOM.callStatus = document.getElementById('call-status');
    DOM.callTimer = document.getElementById('call-timer');
    DOM.muteBtn = document.getElementById('call-mute-btn');
    DOM.muteLabel = document.getElementById('call-mute-label');
    DOM.micIconOn = document.getElementById('call-mic-icon-on');
    DOM.micIconOff = document.getElementById('call-mic-icon-off');
    DOM.speakerBtn = document.getElementById('call-speaker-btn');
    DOM.speakerLabel = document.getElementById('call-speaker-label');
    DOM.spkIconOn = document.getElementById('call-spk-icon-on');
    DOM.spkIconOff = document.getElementById('call-spk-icon-off');
    DOM.endBtn = document.getElementById('call-end-btn');
    DOM.minimizeBtn = document.getElementById('call-minimize-btn');

    DOM.icAvatar = document.getElementById('ic-avatar');
    DOM.icCallerName = document.getElementById('ic-caller-name');
    DOM.icAcceptBtn = document.getElementById('ic-accept-btn');
    DOM.icRejectBtn = document.getElementById('ic-reject-btn');

    DOM.fcpAvatar = document.getElementById('fcp-avatar');
    DOM.fcpName = document.getElementById('fcp-name');
    DOM.fcpTimer = document.getElementById('fcp-timer');
    DOM.fcpExpandBtn = document.getElementById('fcp-expand-btn');
    DOM.fcpEndBtn = document.getElementById('fcp-end-btn');

    bindEvents();
  }

  /* ── رندر تصویر یا حروف اول آواتار ── */
  function renderAvatar(container, user) {
    if (!container || !user) return;
    const name = user.display_name || user.username || 'کاربر';
    if (user.avatar_url) {
      container.innerHTML = `<img src="${user.avatar_url}" alt="${name}" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'avatar-text\\'>${name.charAt(0)}</div>'">`;
    } else {
      container.innerHTML = `<div class="avatar-text">${name.charAt(0)}</div>`;
    }
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function startDurationTimer() {
    stopDurationTimer();
    callState.durationSeconds = 0;
    if (DOM.callTimer) {
      DOM.callTimer.textContent = '00:00';
      DOM.callTimer.classList.remove('hidden');
    }
    if (DOM.fcpTimer) DOM.fcpTimer.textContent = '00:00';

    callState.timerInterval = setInterval(() => {
      callState.durationSeconds++;
      const timeStr = formatDuration(callState.durationSeconds);
      if (DOM.callTimer) DOM.callTimer.textContent = timeStr;
      if (DOM.fcpTimer) DOM.fcpTimer.textContent = timeStr;
    }, 1000);
  }

  function stopDurationTimer() {
    if (callState.timerInterval) {
      clearInterval(callState.timerInterval);
      callState.timerInterval = null;
    }
  }

  /* ── مقداردهی RTCPeerConnection ── */
  function createPeerConnection() {
    if (callState.peerConnection) {
      try { callState.peerConnection.close(); } catch {}
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    callState.peerConnection = pc;

    // افزودن ترک صوتی محلی به ارتباط
    if (callState.localStream) {
      for (const track of callState.localStream.getAudioTracks()) {
        pc.addTrack(track, callState.localStream);
      }
    }

    // ارسال ICE Candidate تولیدشده به طرف مقابل
    pc.onicecandidate = (event) => {
      if (event.candidate && callState.callId && state.socket) {
        state.socket.emit('call:signal', {
          call_id: callState.callId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    // دریافت ترک صوتی طرف مقابل
    pc.ontrack = (event) => {
      if (DOM.remoteAudio && event.streams && event.streams[0]) {
        DOM.remoteAudio.srcObject = event.streams[0];
        DOM.remoteAudio.play().catch((err) => {
          console.warn('[Call] Auto-play remote stream prevented:', err);
        });
      }
    };

    // وضعیت اتصال
    pc.onconnectionstatechange = () => {
      if (!callState.peerConnection) return;
      const cState = pc.connectionState;
      if (cState === 'connected') {
        callState.status = 'connected';
        soundSynth.stopAll();
        if (DOM.callStatus) DOM.callStatus.textContent = 'متصل شد';
        startDurationTimer();
      } else if (cState === 'disconnected' || cState === 'failed') {
        if (callState.status === 'connected') {
          if (DOM.callStatus) DOM.callStatus.textContent = 'در حال تلاش برای اتصال مجدد...';
        }
      } else if (cState === 'closed') {
        cleanupCall();
      }
    };

    return pc;
  }

  /* ── آغاز تماس از سمت تماس‌گیرنده ── */
  async function initiateCall() {
    if (!state.activeChatId) return;
    const chat = state.chats.get(state.activeChatId);
    if (!chat || chat.type !== 'private' || !chat.peer) {
      if (typeof showToast === 'function') showToast('تماس صوتی فقط در چت‌های دو‌نفره ممکن است.');
      return;
    }

    if (chat.peer.username === 'safir' || chat.peer.is_safir) {
      if (typeof showToast === 'function') showToast('امکان برقراری تماس با ربات پشتیبان وجود ندارد.');
      return;
    }

    if (callState.status !== 'idle') {
      if (typeof showToast === 'function') showToast('شما در حال حاضر در یک تماس دیگر هستید.');
      return;
    }

    // درخواست دسترسی به میکروفون
    try {
      soundSynth.init();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false
      });
      callState.localStream = stream;
    } catch (err) {
      console.error('[Call] Mic permission denied:', err);
      if (typeof showToast === 'function') {
        showToast('لطفاً دسترسی به میکروفون را برای برقراری تماس صوتی مجاز کنید.');
      } else {
        alert('دسترسی به میکروفون مجاز نشد.');
      }
      return;
    }

    const peer = {
      id: chat.peer.id,
      display_name: chat.peer.display_name,
      username: chat.peer.username,
      avatar_url: chat.peer.avatar_url,
    };

    callState.peerUser = peer;
    callState.chatId = chat.id;
    callState.isCaller = true;
    callState.status = 'ringing';
    callState.isMuted = false;
    callState.isSpeaker = false;
    callState.isMinimized = false;

    // به‌روزرسانی UI
    if (DOM.callUserName) DOM.callUserName.textContent = peer.display_name || peer.username || 'کاربر';
    if (DOM.callStatus) DOM.callStatus.textContent = 'در حال برقراری تماس...';
    if (DOM.callTimer) DOM.callTimer.classList.add('hidden');
    renderAvatar(DOM.callAvatar, peer);
    renderAvatar(DOM.fcpAvatar, peer);
    if (DOM.fcpName) DOM.fcpName.textContent = peer.display_name || peer.username || 'کاربر';

    updateMuteUI();
    updateSpeakerUI();

    DOM.activeModal?.classList.remove('hidden');
    soundSynth.playRingback();

    // ارسال درخواست به سرور
    state.socket.emit('call:request', {
      to_user_id: peer.id,
      chat_id: chat.id
    });
  }

  /* ── پاسخ دادن به تماس ورودی ── */
  async function acceptCall() {
    soundSynth.stopAll();
    DOM.incomingModal?.classList.add('hidden');

    try {
      soundSynth.init();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false
      });
      callState.localStream = stream;
    } catch (err) {
      console.error('[Call] Callee mic permission failed:', err);
      if (typeof showToast === 'function') showToast('دسترسی به میکروفون امکان‌پذیر نشد.');
      rejectCall('mic_error');
      return;
    }

    callState.status = 'connecting';
    callState.isMuted = false;
    callState.isSpeaker = false;

    if (DOM.callUserName) DOM.callUserName.textContent = callState.peerUser?.display_name || 'کاربر';
    if (DOM.callStatus) DOM.callStatus.textContent = 'در حال اتصال...';
    if (DOM.callTimer) DOM.callTimer.classList.add('hidden');
    renderAvatar(DOM.callAvatar, callState.peerUser);
    renderAvatar(DOM.fcpAvatar, callState.peerUser);
    if (DOM.fcpName) DOM.fcpName.textContent = callState.peerUser?.display_name || 'کاربر';

    updateMuteUI();
    updateSpeakerUI();

    DOM.activeModal?.classList.remove('hidden');

    createPeerConnection();

    // ارسال پذیرش به سرور
    state.socket.emit('call:accept', { call_id: callState.callId });

    // اعمال کاندیداهای معلق دریافت شده پیش از پذیرش
    processPendingCandidates();
  }

  /* ── رد تماس یا لغو ── */
  function rejectCall(reason = 'declined') {
    soundSynth.stopAll();
    DOM.incomingModal?.classList.add('hidden');

    if (callState.callId && state.socket) {
      state.socket.emit('call:reject', { call_id: callState.callId, reason });
    }
    cleanupCall();
  }

  /* ── قطع تماس فعال ── */
  function endCall() {
    soundSynth.stopAll();
    soundSynth.playEndTone();

    if (callState.callId && state.socket) {
      state.socket.emit('call:end', { call_id: callState.callId });
    }
    cleanupCall();
  }

  /* ── پاک‌سازی و ریست وضعیت تماس ── */
  function cleanupCall() {
    stopDurationTimer();

    if (callState.localStream) {
      try {
        callState.localStream.getTracks().forEach((track) => track.stop());
      } catch {}
      callState.localStream = null;
    }

    if (callState.peerConnection) {
      try {
        callState.peerConnection.close();
      } catch {}
      callState.peerConnection = null;
    }

    if (DOM.remoteAudio) {
      DOM.remoteAudio.srcObject = null;
    }

    callState.callId = null;
    callState.peerUser = null;
    callState.chatId = null;
    callState.isCaller = false;
    callState.status = 'idle';
    callState.pendingCandidates = [];
    callState.isMinimized = false;

    DOM.activeModal?.classList.add('hidden');
    DOM.incomingModal?.classList.add('hidden');
    DOM.floatingPill?.classList.add('hidden');
  }

  /* ── پردازش کاندیداهای معلق ── */
  async function processPendingCandidates() {
    if (!callState.peerConnection || !callState.peerConnection.remoteDescription) return;
    while (callState.pendingCandidates.length > 0) {
      const candidate = callState.pendingCandidates.shift();
      try {
        await callState.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[Call] Error adding queued ICE candidate:', e);
      }
    }
  }

  /* ── تغییر وضعیت بی‌صدا (Mute) ── */
  function toggleMute() {
    if (!callState.localStream) return;
    callState.isMuted = !callState.isMuted;
    callState.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !callState.isMuted;
    });
    updateMuteUI();
  }

  function updateMuteUI() {
    if (!DOM.muteBtn) return;
    if (callState.isMuted) {
      DOM.muteBtn.classList.add('active');
      DOM.micIconOn?.classList.add('hidden');
      DOM.micIconOff?.classList.remove('hidden');
      if (DOM.muteLabel) DOM.muteLabel.textContent = 'وصل صدا';
    } else {
      DOM.muteBtn.classList.remove('active');
      DOM.micIconOn?.classList.remove('hidden');
      DOM.micIconOff?.classList.add('hidden');
      if (DOM.muteLabel) DOM.muteLabel.textContent = 'بی‌صدا';
    }
  }

  /* ── تغییر وضعیت بلندگو / اسپیکر ── */
  function toggleSpeaker() {
    callState.isSpeaker = !callState.isSpeaker;
    if (DOM.remoteAudio) {
      DOM.remoteAudio.volume = callState.isSpeaker ? 1.0 : 0.65;
    }
    updateSpeakerUI();
  }

  function updateSpeakerUI() {
    if (!DOM.speakerBtn) return;
    if (callState.isSpeaker) {
      DOM.speakerBtn.classList.add('active');
      DOM.spkIconOn?.classList.add('hidden');
      DOM.spkIconOff?.classList.remove('hidden');
      if (DOM.speakerLabel) DOM.speakerLabel.textContent = 'گوشی';
    } else {
      DOM.speakerBtn.classList.remove('active');
      DOM.spkIconOn?.classList.remove('hidden');
      DOM.spkIconOff?.classList.add('hidden');
      if (DOM.speakerLabel) DOM.speakerLabel.textContent = 'بلندگو';
    }
  }

  /* ── کوچک‌سازی به نوار شناور و بزرگ‌نمایی ── */
  function minimizeCall() {
    callState.isMinimized = true;
    DOM.activeModal?.classList.add('hidden');
    DOM.floatingPill?.classList.remove('hidden');
  }

  function expandCall() {
    callState.isMinimized = false;
    DOM.floatingPill?.classList.add('hidden');
    DOM.activeModal?.classList.remove('hidden');
  }

  /* ── اتصال کلیک دکمه‌ها ── */
  function bindEvents() {
    DOM.chatCallBtn?.addEventListener('click', () => {
      initiateCall();
    });

    DOM.icAcceptBtn?.addEventListener('click', () => {
      acceptCall();
    });

    DOM.icRejectBtn?.addEventListener('click', () => {
      rejectCall('declined');
    });

    DOM.endBtn?.addEventListener('click', () => {
      endCall();
    });

    DOM.muteBtn?.addEventListener('click', () => {
      toggleMute();
    });

    DOM.speakerBtn?.addEventListener('click', () => {
      toggleSpeaker();
    });

    DOM.minimizeBtn?.addEventListener('click', () => {
      minimizeCall();
    });

    DOM.fcpExpandBtn?.addEventListener('click', () => {
      expandCall();
    });

    DOM.fcpEndBtn?.addEventListener('click', () => {
      endCall();
    });
  }

  /* ── ثبت لیسنرهای رویدادهای تماس از سوکت ── */
  function registerSocketListeners(socket) {
    if (!socket) return;

    // مخاطب: تماس ورودی دریافت شد
    socket.on('call:incoming', ({ call_id, chat_id, caller }) => {
      // اگر کاربر در حال مکالمه است، به سرور رد تماس سریع با وضعیت مشغول اعلام کن
      if (callState.status !== 'idle') {
        socket.emit('call:reject', { call_id, reason: 'busy' });
        return;
      }

      callState.callId = call_id;
      callState.chatId = chat_id;
      callState.peerUser = caller;
      callState.isCaller = false;
      callState.status = 'ringing';

      if (DOM.icCallerName) DOM.icCallerName.textContent = caller.display_name || caller.username || 'کاربر';
      renderAvatar(DOM.icAvatar, caller);

      DOM.incomingModal?.classList.remove('hidden');
      soundSynth.playRingtone();
    });

    // تماس‌گیرنده: زنگ در حال پخش است
    socket.on('call:ringing', ({ call_id }) => {
      if (callState.callId === null) callState.callId = call_id;
      if (DOM.callStatus) DOM.callStatus.textContent = 'در حال زنگ خوردن...';
    });

    // تماس‌گیرنده: مخاطب تماس را پذیرفت
    socket.on('call:accepted', async ({ call_id }) => {
      if (callState.callId !== call_id) return;
      soundSynth.stopAll();
      if (DOM.callStatus) DOM.callStatus.textContent = 'در حال اتصال...';

      const pc = createPeerConnection();
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:signal', {
          call_id,
          signal: { type: 'offer', sdp: offer }
        });
      } catch (err) {
        console.error('[Call] Error creating WebRTC offer:', err);
        endCall();
      }
    });

    // دریافت تبادل سیگنالینگ WebRTC
    socket.on('call:signal', async ({ call_id, signal }) => {
      if (!signal || callState.callId !== call_id) return;
      const pc = callState.peerConnection;

      try {
        if (signal.type === 'offer') {
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await processPendingCandidates();

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socket.emit('call:signal', {
            call_id,
            signal: { type: 'answer', sdp: answer }
          });
        } else if (signal.type === 'answer') {
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await processPendingCandidates();
        } else if (signal.type === 'candidate' && signal.candidate) {
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            callState.pendingCandidates.push(signal.candidate);
          }
        }
      } catch (err) {
        console.warn('[Call] WebRTC signal error:', err);
      }
    });

    // تماس رد شد
    socket.on('call:rejected', ({ reason }) => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      const msg = reason === 'busy' ? 'کاربر در حال مکالمه دیگری است.' : 'تماس رد شد.';
      if (typeof showToast === 'function') showToast(msg);
      cleanupCall();
    });

    // پایان تماس توسط طرف مقابل
    socket.on('call:ended', ({ duration, reason }) => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      let msg = 'تماس پایان یافت.';
      if (reason === 'disconnected') {
        msg = 'ارتباط مخاطب قطع شد.';
      } else if (duration > 0) {
        msg = `تماس پایان یافت (${formatDuration(duration)})`;
      }
      if (typeof showToast === 'function') showToast(msg);
      cleanupCall();
    });

    // خطای زمانی (عدم پاسخ بعد از ۴۵ ثانیه)
    socket.on('call:timeout', () => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      if (typeof showToast === 'function') showToast('تماس بی‌پاسخ ماند.');
      cleanupCall();
    });

    // مخاطب مشغول است
    socket.on('call:busy', ({ message }) => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      if (typeof showToast === 'function') showToast(message || 'کاربر در حال مکالمه است.');
      cleanupCall();
    });

    // مخاطب آفلاین است
    socket.on('call:offline', ({ message }) => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      if (typeof showToast === 'function') showToast(message || 'کاربر در حال حاضر آنلاین نیست.');
      cleanupCall();
    });

    // خطای عمومی تماس
    socket.on('call:error', ({ message }) => {
      soundSynth.stopAll();
      soundSynth.playEndTone();
      if (typeof showToast === 'function') showToast(message || 'خطا در برقراری تماس.');
      cleanupCall();
    });
  }

  // راه‌اندازی پس از بارگذاری DOM و سوکت
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initDOM();
    });
  } else {
    initDOM();
  }

  // عمومی‌سازی تابع ثبت لیسنر برای استفاده در app.js
  window.initCallSignaling = function (socket) {
    registerSocketListeners(socket);
  };

  // در صورتی که سوکت پیش از این فایل آماده شده باشد
  if (typeof state !== 'undefined' && state && state.socket) {
    registerSocketListeners(state.socket);
  }
})();
