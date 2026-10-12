'use strict';

/* ═══════════════ ماژول پیام‌های صوتی (Voice Player & Recorder) ═══════════════ */

const WAVE_PATTERN = [
  3, 3, 3, 5, 8, 20, 22, 24, 22, 16, 10, 6, 8, 4, 4, 14, 20, 24, 18, 22, 24, 18, 12,
  8, 16, 22, 16, 8, 14, 8, 16, 22, 16, 20, 8, 4, 4, 4, 18, 24, 14, 6, 4, 4
];

function voicePlayerHTML(m, file) {
  const url = furl(file.id);
  const bars = WAVE_PATTERN.map((h) => `<span class="vp-bar" style="height:${h}px"></span>`).join('');
  return `
  <div class="voice-player" data-mid="${m.id || 0}" data-src="${esc(url)}">
    <button type="button" class="vp-play-btn" title="پخش / توقف">
      <svg class="vp-play-icon" viewBox="0 0 24 24"><path d="M9 7.5v9l7.5-4.5z"/></svg>
      <svg class="vp-pause-icon hidden" viewBox="0 0 24 24"><path d="M7 6.5h3.5v11H7zm6.5 0H17v11h-3.5z"/></svg>
    </button>
    <div class="vp-body">
      <div class="vp-wave" title="برای تغییر زمان کلیک کنید">
        ${bars}
      </div>
      <div class="vp-time-row">
        <span class="vp-time">0:00</span>
      </div>
    </div>
    <audio class="vp-audio hidden" src="${esc(url)}" preload="metadata"></audio>
  </div>`;
}

function bindVoicePlayers(root = document) {
  $$('.voice-player', root).forEach((player) => {
    if (player.dataset.bound) return;
    player.dataset.bound = '1';

    const audio = player.querySelector('audio');
    const playBtn = player.querySelector('.vp-play-btn');
    const playIcon = player.querySelector('.vp-play-icon');
    const pauseIcon = player.querySelector('.vp-pause-icon');
    const timeEl = player.querySelector('.vp-time');
    const wave = player.querySelector('.vp-wave');
    const bars = player.querySelectorAll('.vp-bar');

    if (!audio) return;

    const updateDuration = () => {
      if (audio.duration && Number.isFinite(audio.duration)) {
        if (audio.paused && audio.currentTime === 0) {
          timeEl.textContent = fmtDuration(audio.duration);
        }
      } else if (audio.duration === Infinity) {
        audio.currentTime = 1e101;
        audio.ontimeupdate = function() {
          this.ontimeupdate = null;
          audio.currentTime = 0;
          if (Number.isFinite(audio.duration) && audio.paused) {
            timeEl.textContent = fmtDuration(audio.duration);
          }
        };
      }
    };

    if (audio.readyState >= 1) {
      updateDuration();
    }
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('durationchange', updateDuration);

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audio.paused) {
        $$('audio').forEach((a) => {
          if (a !== audio) a.pause();
        });
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    });

    if (wave) {
      wave.addEventListener('click', (e) => {
        e.stopPropagation();
        const dur = (audio.duration && Number.isFinite(audio.duration)) ? audio.duration : 0;
        if (!dur) return;
        const rect = wave.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * dur;
        const activeCount = Math.round(ratio * bars.length);
        bars.forEach((b, idx) => b.classList.toggle('active', idx < activeCount));
        timeEl.textContent = fmtDuration(audio.currentTime);
        if (audio.paused) {
          $$('audio').forEach((a) => { if (a !== audio) a.pause(); });
          audio.play().catch(() => {});
        }
      });
    }

    audio.addEventListener('play', () => {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    });

    audio.addEventListener('pause', () => {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      if (audio.currentTime === 0 && Number.isFinite(audio.duration)) {
        timeEl.textContent = fmtDuration(audio.duration);
      }
    });

    audio.addEventListener('ended', () => {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      audio.currentTime = 0;
      bars.forEach((b) => b.classList.remove('active'));
      if (Number.isFinite(audio.duration)) {
        timeEl.textContent = fmtDuration(audio.duration);
      }
    });

    audio.addEventListener('timeupdate', () => {
      timeEl.textContent = fmtDuration(audio.currentTime);
      const dur = (audio.duration && Number.isFinite(audio.duration)) ? audio.duration : 0;
      if (dur > 0) {
        const progress = audio.currentTime / dur;
        const activeCount = Math.round(progress * bars.length);
        bars.forEach((b, idx) => {
          b.classList.toggle('active', idx < activeCount);
        });
      }
    });
  });
}

/* ═══════════════ ضبط پیام صوتی (Voice Recorder) ═══════════════ */

async function startVoiceRecording() {
  if (!state.activeChatId) {
    showToast('ابتدا یک گفتگو را انتخاب کنید');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('مرورگر شما ضبط صدا را پشتیبانی نمی‌کند');
    return;
  }
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    stopVoiceRecording(true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.voiceStream = stream;
    state.voiceChunks = [];
    state.voiceSeconds = 0;

    let mimeType = 'audio/webm';
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) mimeType = 'audio/ogg;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
    }

    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.mediaRecorder = mr;

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.voiceChunks.push(e.data);
    };

    mr.start(100);

    const bar = $('#record-bar');
    bar.innerHTML = `
      <span class="rec-dot"></span>
      <span class="rec-timer" id="rec-timer">۰۰:۰۰</span>
      <span style="font-size:13px;color:var(--text-secondary)">در حال ضبط صدا...</span>
      <div class="rec-actions">
        <button id="rec-cancel" class="btn-ghost sm" type="button">لغو</button>
        <button id="rec-send" class="btn-primary sm" type="button">ارسال ویس</button>
      </div>
    `;
    bar.classList.remove('hidden');

    $('#rec-cancel').onclick = () => stopVoiceRecording(false);
    $('#rec-send').onclick = () => stopVoiceRecording(true);

    clearInterval(state.voiceTimer);
    state.voiceTimer = setInterval(() => {
      state.voiceSeconds++;
      const timerEl = $('#rec-timer');
      if (timerEl) timerEl.textContent = fmtDuration(state.voiceSeconds);
    }, 1000);
  } catch (err) {
    showToast('دسترسی به میکروفون داده نشد یا خطا رخ داد');
  }
}

async function stopVoiceRecording(send) {
  clearInterval(state.voiceTimer);
  const bar = $('#record-bar');
  if (bar) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }

  // آزادسازی قطعی میکروفون
  if (state.voiceStream) {
    state.voiceStream.getTracks().forEach((track) => track.stop());
    state.voiceStream = null;
  }

  const mr = state.mediaRecorder;
  state.mediaRecorder = null;
  if (!mr || mr.state === 'inactive') return;

  mr.addEventListener('stop', async () => {
    if (!send || !state.voiceChunks.length) return;
    const cleanMime = (mr.mimeType || 'audio/webm').split(';')[0];
    const ext = cleanMime.includes('ogg') ? 'ogg' : cleanMime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(state.voiceChunks, { type: cleanMime });
    const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: cleanMime });

    const chatId = state.activeChatId;
    if (!chatId) return;

    const fd = new FormData();
    fd.set('file', file);
    fd.set('is_voice', '1');
    if (state.replyTo) fd.set('reply_to_id', state.replyTo.id);
    if (state.activeTopicId) fd.set('topic_id', String(state.activeTopicId));
    cancelReply();

    try {
      const m = await api(`/chats/${chatId}/messages`, { method: 'POST', formData: fd });
      onIncomingMessage(m);
    } catch (e) {
      showToast(e.message);
    }
  });

  if (mr.state === 'recording') {
    mr.stop();
  }
}
