'use strict';

/* ═══════════════════════════════════════════════════════════════════
   ماژول تماس صوتی همتابه‌همتا (WebRTC P2P Voice Call)
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  // تنظیمات بهینه STUN/TURN با پشتیبانی از کاندیداهای پیش‌جمع‌آوری‌شده و مالتی‌پلکس صوتی
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };

  /* ── دریافت پیکربندی بهینه STUN/TURN از سرور در صورت وجود TURN اختصاصی ── */
  async function loadRTCConfig() {
    try {
      const token = (typeof state !== 'undefined' && state && state.token) || localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/rtc-config', { headers });
      if (res.ok) {
        const data = await res.json();
        const cfg = data.rtc_config || data;
        if (cfg && cfg.iceServers && cfg.iceServers.length > 0) {
          RTC_CONFIG.iceServers = cfg.iceServers;
          if (cfg.iceCandidatePoolSize) RTC_CONFIG.iceCandidatePoolSize = cfg.iceCandidatePoolSize;
          if (cfg.bundlePolicy) RTC_CONFIG.bundlePolicy = cfg.bundlePolicy;
          if (cfg.rtcpMuxPolicy) RTC_CONFIG.rtcpMuxPolicy = cfg.rtcpMuxPolicy;
        }
      }
    } catch {}
  }
  loadRTCConfig();

  /* ── بهینه‌سازی پارامترهای Opus در SDP (FEC, DTX, Bitrate, Stereo=0) ── */
  function optimizeAudioSDP(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    // پیدا کردن شناسه پی‌لود کدک صوتی Opus (معمولاً 111)
    const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
    if (!opusMatch) return sdp;

    const pt = opusMatch[1];
    const targetParams = 'useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;cng=1;minptime=10;ptime=20';
    const fmtpRegex = new RegExp(`^a=fmtp:${pt}\\s+(.*)$`, 'm');

    if (fmtpRegex.test(sdp)) {
      return sdp.replace(fmtpRegex, (line, existing) => {
        let cleaned = existing;
        ['useinbandfec', 'usedtx', 'stereo', 'sprop-stereo', 'maxaveragebitrate', 'cng', 'minptime', 'ptime'].forEach((param) => {
          cleaned = cleaned.replace(new RegExp(`(^|;)${param}=\\d+`, 'gi'), '');
        });
        cleaned = cleaned.replace(/^;+|;+$/g, '').trim();
        return `a=fmtp:${pt} ${cleaned ? cleaned + ';' : ''}${targetParams}`;
      });
    } else {
      return sdp.replace(
        new RegExp(`(a=rtpmap:${pt}\\s+opus\\/48000\\/2\\r?\\n)`, 'i'),
        `$1a=fmtp:${pt} ${targetParams}\r\n`
      );
    }
  }

  /* ── تنظیم اولویت شبکه و بیت‌ریت اختصاصی فرستنده RTP ── */
  async function setSenderOptimalParameters(pc) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'audio') {
          const params = sender.getParameters();
          if (params && params.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = 32000; // 32kbps شفاف‌ترین کیفیت صوتی با حداقل پهنای باند
            params.encodings[0].priority = 'high';
            params.encodings[0].networkPriority = 'high';
            await sender.setParameters(params);
          }
        }
      }
    } catch {}
  }

  /* ── محدودیت‌های کیفیت استودیویی صدا (Studio Audio Constraints) ── */
  const AUDIO_CONSTRAINTS = {
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      latency: { ideal: 0.01 },
      googEchoCancellation: { ideal: true },
      googAutoGainControl: { ideal: true },
      googNoiseSuppression: { ideal: true },
      googHighpassFilter: { ideal: true },
      googAudioMirroring: { ideal: false },
    },
    video: false,
  };

  async function acquireMicrophoneStream() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        throw new Error('SECURE_CONTEXT_REQUIRED');
      }
      throw new Error('MEDIA_DEVICES_NOT_SUPPORTED');
    }
    try {
      return await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    } catch (e) {
      console.warn('[Call] Advanced mic constraints failed, falling back to standard audio:', e);
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    }
  }

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
    iceRestartTimer: null,
    isIceRestarting: false,
    vadContext: null,
    vadSource: null,
    vadAnalyser: null,
    vadAnimationId: null,
    qualityInterval: null,
    lastStats: null,
  };

  /* ── ارجاعات عناصر صفحه ── */
  const DOM = {
    chatCallBtn: null,
    activeModal: null,
    incomingModal: null,
    floatingPill: null,
    remoteAudio: null,

    // جزئیات تماس فعال
    callAvatarContainer: null,
    callAvatar: null,
    callUserName: null,
    callStatus: null,
    callTimer: null,
    callQualityBadge: null,
    callQualityDot: null,
    callQualityText: null,
    callVoiceMeter: null,
    callVoiceBars: null,
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
    fcpQualityDot: null,
    fcpExpandBtn: null,
    fcpEndBtn: null,
  };

  function initDOM() {
    DOM.chatCallBtn = document.getElementById('chat-call-btn');
    DOM.activeModal = document.getElementById('active-call-modal');
    DOM.incomingModal = document.getElementById('incoming-call-modal');
    DOM.floatingPill = document.getElementById('floating-call-pill');
    DOM.remoteAudio = document.getElementById('remote-call-audio');

    DOM.callAvatarContainer = document.getElementById('call-avatar-container');
    DOM.callAvatar = document.getElementById('call-user-avatar');
    DOM.callUserName = document.getElementById('call-user-name');
    DOM.callStatus = document.getElementById('call-status');
    DOM.callTimer = document.getElementById('call-timer');
    DOM.callQualityBadge = document.getElementById('call-quality-badge');
    DOM.callQualityDot = document.getElementById('call-quality-dot');
    DOM.callQualityText = document.getElementById('call-quality-text');
    DOM.callVoiceMeter = document.getElementById('call-voice-meter');
    DOM.callVoiceBars = document.querySelectorAll('#call-voice-meter .call-voice-bar');

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
    DOM.fcpQualityDot = document.getElementById('fcp-quality-dot');
    DOM.fcpExpandBtn = document.getElementById('fcp-expand-btn');
    DOM.fcpEndBtn = document.getElementById('fcp-end-btn');

    if (DOM.remoteAudio) {
      DOM.remoteAudio.autoplay = true;
      DOM.remoteAudio.playsInline = true;
    }

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
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) {
      return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
    }
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${String(h).padStart(2, '0')}:${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
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

  /* ── آشکارساز فعالیت صوتی و جلوه بصری صحبت (VAD) ── */
  function startVoiceActivityDetector(stream) {
    stopVoiceActivityDetector();
    if (!stream) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      callState.vadContext = ctx;

      const source = ctx.createMediaStreamSource(stream);
      callState.vadSource = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      callState.vadAnalyser = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      if (DOM.callVoiceMeter) {
        DOM.callVoiceMeter.classList.remove('hidden');
      }

      const checkVolume = () => {
        if (!callState.vadAnalyser) return;
        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        const normalized = Math.min(1, average / 60);

        // هاله دور آواتار هنگام صحبت
        if (DOM.callAvatarContainer) {
          if (average > 14) {
            DOM.callAvatarContainer.classList.add('is-speaking');
          } else {
            DOM.callAvatarContainer.classList.remove('is-speaking');
          }
        }

        // انیمیشن میله‌های فرکانس صوت
        if (DOM.callVoiceBars && DOM.callVoiceBars.length > 0) {
          const numActive = Math.round(normalized * DOM.callVoiceBars.length);
          DOM.callVoiceBars.forEach((bar, idx) => {
            if (idx < numActive) {
              bar.classList.add('active');
              const h = Math.max(6, Math.round(normalized * 24 + (idx % 2 === 0 ? 4 : 0)));
              bar.style.height = `${h}px`;
            } else {
              bar.classList.remove('active');
              bar.style.height = '6px';
            }
          });
        }

        callState.vadAnimationId = requestAnimationFrame(checkVolume);
      };

      callState.vadAnimationId = requestAnimationFrame(checkVolume);
    } catch (e) {
      console.warn('[Call] VAD initialization failed:', e);
    }
  }

  function stopVoiceActivityDetector() {
    if (callState.vadAnimationId) {
      cancelAnimationFrame(callState.vadAnimationId);
      callState.vadAnimationId = null;
    }
    if (DOM.callAvatarContainer) {
      DOM.callAvatarContainer.classList.remove('is-speaking');
    }
    if (DOM.callVoiceBars) {
      DOM.callVoiceBars.forEach((bar) => {
        bar.classList.remove('active');
        bar.style.height = '6px';
      });
    }
    if (DOM.callVoiceMeter) {
      DOM.callVoiceMeter.classList.add('hidden');
    }
    if (callState.vadSource) {
      try { callState.vadSource.disconnect(); } catch {}
      callState.vadSource = null;
    }
    if (callState.vadAnalyser) {
      try { callState.vadAnalyser.disconnect(); } catch {}
      callState.vadAnalyser = null;
    }
    if (callState.vadContext) {
      try { callState.vadContext.close(); } catch {}
      callState.vadContext = null;
    }
  }

  /* ── پایش و ارزیابی کیفیت زنده تماس (Quality Monitor) ── */
  function updateQualityBadge(level, text) {
    if (DOM.callQualityBadge) {
      DOM.callQualityBadge.classList.remove('hidden');
    }
    if (DOM.callQualityDot) {
      DOM.callQualityDot.className = `quality-dot ${level}`;
    }
    if (DOM.fcpQualityDot) {
      DOM.fcpQualityDot.className = `quality-dot ${level}`;
    }
    if (DOM.callQualityText) {
      DOM.callQualityText.textContent = text;
    }
  }

  function startQualityMonitor() {
    stopQualityMonitor();
    callState.lastStats = null;
    updateQualityBadge('good', 'کیفیت عالی');

    callState.qualityInterval = setInterval(async () => {
      const pc = callState.peerConnection;
      if (!pc || (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected')) return;

      try {
        const stats = await pc.getStats();
        let inboundAudio = null;
        let roundTripTime = null;

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            inboundAudio = report;
          } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              roundTripTime = report.currentRoundTripTime * 1000;
            }
          }
        });

        if (inboundAudio) {
          const packetsLost = inboundAudio.packetsLost || 0;
          const packetsReceived = inboundAudio.packetsReceived || 0;
          const jitter = (inboundAudio.jitter || 0) * 1000;

          let lossRate = 0;
          if (callState.lastStats) {
            const deltaLost = Math.max(0, packetsLost - callState.lastStats.packetsLost);
            const deltaReceived = Math.max(0, packetsReceived - callState.lastStats.packetsReceived);
            const total = deltaLost + deltaReceived;
            if (total > 0) {
              lossRate = deltaLost / total;
            }
          }

          callState.lastStats = { packetsLost, packetsReceived };

          if (lossRate > 0.08 || (roundTripTime && roundTripTime > 500) || jitter > 80) {
            updateQualityBadge('poor', 'کیفیت ضعیف');
          } else if (lossRate > 0.02 || (roundTripTime && roundTripTime > 250) || jitter > 40) {
            updateQualityBadge('medium', 'کیفیت متوسط');
          } else {
            updateQualityBadge('good', 'کیفیت عالی');
          }
        }
      } catch (err) {
        console.warn('[Call] Stats error:', err);
      }
    }, 2500);
  }

  function stopQualityMonitor() {
    if (callState.qualityInterval) {
      clearInterval(callState.qualityInterval);
      callState.qualityInterval = null;
    }
    callState.lastStats = null;
    if (DOM.callQualityBadge) DOM.callQualityBadge.classList.add('hidden');
  }

  /* ── بازیابی خودکار اتصال و ICE Restart ── */
  function handleConnectionDegraded() {
    if (callState.status !== 'connected' && callState.status !== 'connecting') return;
    if (DOM.callStatus) DOM.callStatus.textContent = 'در حال تلاش برای اتصال مجدد...';
    updateQualityBadge('poor', 'اتصال ناپایدار');

    if (!callState.iceRestartTimer) {
      callState.iceRestartTimer = setTimeout(() => {
        callState.iceRestartTimer = null;
        triggerIceRestart();
      }, 2000);
    }
  }

  async function triggerIceRestart() {
    const pc = callState.peerConnection;
    if (!pc || !callState.isCaller || callState.isIceRestarting || !callState.callId) return;

    try {
      console.log('[Call] Triggering ICE restart for recovery...');
      callState.isIceRestarting = true;
      const offer = await pc.createOffer({ iceRestart: true });
      offer.sdp = optimizeAudioSDP(offer.sdp);
      await pc.setLocalDescription(offer);

      if (state.socket) {
        state.socket.emit('call:signal', {
          call_id: callState.callId,
          signal: { type: 'offer', sdp: offer, isRestart: true }
        });
      }
    } catch (err) {
      console.warn('[Call] ICE restart error:', err);
    } finally {
      setTimeout(() => {
        callState.isIceRestarting = false;
      }, 5000);
    }
  }

  function onCallConnected() {
    if (callState.status === 'connected') return;
    callState.status = 'connected';
    callState.isIceRestarting = false;
    if (callState.iceRestartTimer) {
      clearTimeout(callState.iceRestartTimer);
      callState.iceRestartTimer = null;
    }
    soundSynth.stopAll();
    if (DOM.callStatus) DOM.callStatus.textContent = 'متصل شد';
    startDurationTimer();
    startQualityMonitor();
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

    // دریافت ترک صوتی طرف مقابل با بازگشایی خودکار قفل Autoplay
    pc.ontrack = (event) => {
      if (DOM.remoteAudio && event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        DOM.remoteAudio.srcObject = remoteStream;

        const playPromise = DOM.remoteAudio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('[Call] Autoplay blocked, listening for gesture:', err);
            const unlock = () => {
              DOM.remoteAudio.play().catch(() => {});
              window.removeEventListener('click', unlock);
              window.removeEventListener('touchstart', unlock);
            };
            window.addEventListener('click', unlock, { once: true });
            window.addEventListener('touchstart', unlock, { once: true });
          });
        }

        startVoiceActivityDetector(remoteStream);
      }
    };

    // وضعیت اتصال کلی
    pc.onconnectionstatechange = () => {
      if (!callState.peerConnection) return;
      const cState = pc.connectionState;
      if (cState === 'connected') {
        onCallConnected();
      } else if (cState === 'disconnected' || cState === 'failed') {
        handleConnectionDegraded();
      } else if (cState === 'closed') {
        cleanupCall();
      }
    };

    // وضعیت اتصال ICE
    pc.oniceconnectionstatechange = () => {
      if (!callState.peerConnection) return;
      const iceState = pc.iceConnectionState;
      if (iceState === 'connected' || iceState === 'completed') {
        onCallConnected();
      } else if (iceState === 'disconnected' || iceState === 'failed') {
        handleConnectionDegraded();
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

    callState.status = 'requesting';
    DOM.chatCallBtn?.setAttribute('disabled', 'disabled');

    // درخواست دسترسی به میکروفون با پردازش بهینه‌سازی صوتی
    try {
      soundSynth.init();
      const stream = await acquireMicrophoneStream();
      callState.localStream = stream;
    } catch (err) {
      console.error('[Call] Mic permission denied:', err);
      cleanupCall();
      if (err.message === 'SECURE_CONTEXT_REQUIRED') {
        alert('⚠️ تماس صوتی و دسترسی به میکروفون در کروم گوشی نیازمند محیط امن (HTTPS) است.\n\nبرای تست با آدرس IP محلی در کروم گوشی:\n۱. به صفحه chrome://flags بروید\n۲. عبارت unsafely-treat-insecure-origin-as-secure را جستجو کنید\n۳. آدرس سرور (مثلاً http://192.168.1.5:3000) را وارد و Enabled کنید.');
      } else if (typeof showToast === 'function') {
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
    if (state.socket && state.socket.connected) {
      state.socket.emit('call:request', {
        to_user_id: peer.id,
        chat_id: chat.id
      });
    } else {
      showToast('اتصال با سرور برقرار نیست');
      cleanupCall();
    }
  }

  /* ── پاسخ دادن به تماس ورودی ── */
  async function acceptCall() {
    if (callState.status !== 'ringing') return;
    callState.status = 'connecting';
    DOM.icAcceptBtn?.setAttribute('disabled', 'disabled');

    soundSynth.stopAll();
    DOM.incomingModal?.classList.add('hidden');

    try {
      soundSynth.init();
      const stream = await acquireMicrophoneStream();
      callState.localStream = stream;
    } catch (err) {
      console.error('[Call] Callee mic permission failed:', err);
      if (err.message === 'SECURE_CONTEXT_REQUIRED') {
        alert('⚠️ تماس صوتی و دسترسی به میکروفون در کروم گوشی نیازمند محیط امن (HTTPS) است.\n\nبرای تست با آدرس IP محلی در کروم گوشی:\n۱. به صفحه chrome://flags بروید\n۲. عبارت unsafely-treat-insecure-origin-as-secure را جستجو کنید\n۳. آدرس سرور را وارد و Enabled کنید.');
      } else if (typeof showToast === 'function') {
        showToast('دسترسی به میکروفون امکان‌پذیر نشد.');
      }
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
    stopQualityMonitor();
    stopVoiceActivityDetector();

    if (callState.iceRestartTimer) {
      clearTimeout(callState.iceRestartTimer);
      callState.iceRestartTimer = null;
    }
    callState.isIceRestarting = false;

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

    DOM.chatCallBtn?.removeAttribute('disabled');
    DOM.icAcceptBtn?.removeAttribute('disabled');
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
  async function toggleSpeaker() {
    callState.isSpeaker = !callState.isSpeaker;
    if (DOM.remoteAudio) {
      DOM.remoteAudio.volume = callState.isSpeaker ? 1.0 : 0.65;

      if (typeof DOM.remoteAudio.setSinkId === 'function' && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
          if (audioOutputs.length > 0) {
            const speaker = audioOutputs.find((d) => /speaker|بلندگو|اسپیکر/i.test(d.label)) || audioOutputs[0];
            await DOM.remoteAudio.setSinkId(callState.isSpeaker ? speaker.deviceId : '');
          }
        } catch (e) {
          console.warn('[Call] setSinkId error:', e);
        }
      }
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

  /* ── نمایش مودال تماس ورودی (از سوکت یا سرویس‌ورکر) ── */
  function handleIncomingCall({ call_id, chat_id, caller }) {
    if (callState.status !== 'idle') {
      if (typeof state !== 'undefined' && state && state.socket) {
        state.socket.emit('call:reject', { call_id, reason: 'busy' });
      }
      return;
    }

    callState.callId = call_id;
    callState.chatId = chat_id;
    callState.peerUser = caller || { id: 0, display_name: 'کاربر' };
    callState.isCaller = false;
    callState.status = 'ringing';

    if (DOM.icCallerName) {
      DOM.icCallerName.textContent = callState.peerUser.display_name || callState.peerUser.username || 'کاربر';
    }
    renderAvatar(DOM.icAvatar, callState.peerUser);

    DOM.incomingModal?.classList.remove('hidden');
    soundSynth.playRingtone();
  }

  /* ── ثبت لیسنرهای رویدادهای تماس از سوکت ── */
  function registerSocketListeners(socket) {
    if (!socket) return;

    // مخاطب: تماس ورودی دریافت شد
    socket.on('call:incoming', ({ call_id, chat_id, caller }) => {
      handleIncomingCall({ call_id, chat_id, caller });
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
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          voiceActivityDetection: true
        });
        offer.sdp = optimizeAudioSDP(offer.sdp);
        await pc.setLocalDescription(offer);
        await setSenderOptimalParameters(pc);

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
          const sdpDesc = new RTCSessionDescription({
            type: 'offer',
            sdp: optimizeAudioSDP(signal.sdp.sdp || signal.sdp)
          });
          await pc.setRemoteDescription(sdpDesc);
          await processPendingCandidates();

          const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            voiceActivityDetection: true
          });
          answer.sdp = optimizeAudioSDP(answer.sdp);
          await pc.setLocalDescription(answer);
          await setSenderOptimalParameters(pc);

          socket.emit('call:signal', {
            call_id,
            signal: { type: 'answer', sdp: answer }
          });
        } else if (signal.type === 'answer') {
          if (!pc) return;
          const sdpDesc = new RTCSessionDescription({
            type: 'answer',
            sdp: optimizeAudioSDP(signal.sdp.sdp || signal.sdp)
          });
          await pc.setRemoteDescription(sdpDesc);
          await processPendingCandidates();
          await setSenderOptimalParameters(pc);
        } else if (signal.type === 'candidate' && signal.candidate) {
          const cand = signal.candidate;
          // رد کاندیداهای خالی
          if (!cand.candidate && typeof cand !== 'string') {
            return;
          }

          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } else {
            callState.pendingCandidates.push(cand);
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

    // قطع زنگ در تب‌های دیگر وقتی تماس پاسخ داده یا رد شده است
    socket.on('call:dismiss-incoming', ({ call_id }) => {
      if (callState.callId === call_id && callState.status === 'ringing' && !callState.isCaller) {
        soundSynth.stopAll();
        DOM.incomingModal?.classList.add('hidden');
        cleanupCall();
      }
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

  // تلاش برای بازیابی خودکار هنگام بازگشت اتصال اینترنت کاربر
  window.addEventListener('online', () => {
    if (callState.status === 'connected' && callState.peerConnection) {
      console.log('[Call] Online event detected, verifying connection health...');
      handleConnectionDegraded();
    }
  });

  // راه‌اندازی پس از بارگذاری DOM و سوکت
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initDOM();
    });
  } else {
    initDOM();
  }

  // دریافت پیام از سرویس‌ورکر (کلیک روی اعلان تماس یا پیام تماس در پس‌زمینه)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'INCOMING_CALL_PUSH') {
        if (callState.status === 'idle') {
          handleIncomingCall({
            call_id: msg.callId,
            chat_id: msg.chatId,
            caller: {
              display_name: msg.callerName,
              avatar_url: msg.callerAvatar
            }
          });
        }
      } else if (msg.type === 'ANSWER_CALL') {
        if (msg.callId) {
          callState.callId = msg.callId;
          callState.chatId = msg.chatId;
          acceptIncomingCall();
        }
      }
    });
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
