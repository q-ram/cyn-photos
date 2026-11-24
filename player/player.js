// 청년회의 밤 음향 플레이어
// - BGM: 한 번에 한 곡. 곡을 바꾸면 서서히 넘어간다 (크로스페이드)
// - 효과음: 누르면 바로, BGM 위에 겹쳐서. 나오는 동안 BGM 을 잠깐 줄일 수 있다 (더킹)
// - 음원은 이 기기 안(IndexedDB)에만 저장한다. 어디로도 보내지 않는다.

/* ───────── 저장소 ───────── */

const DB_NAME = 'cyn-player';
const STORE = 'tracks';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let out;
    const r = fn(t.objectStore(STORE));
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  }));
}
const dbAll = () => tx('readonly', st => st.getAll());
// 사파리 사생활 보호 모드 등 파일(Blob) 저장이 막힌 곳에서는 내용(ArrayBuffer)으로 바꿔 저장한다
let memoryOnlyWarned = false;
async function dbPut(t) {
  const { url, memoryOnly, blob, ...rest } = t;
  if (t.storeAs !== 'buffer') {
    try { await tx('readwrite', st => st.put({ ...rest, blob })); return; } catch (err) {
      if (err && err.name === 'QuotaExceededError') throw err;
    }
  }
  try {
    const data = await blob.arrayBuffer();
    await tx('readwrite', st => st.put({ ...rest, storeAs: 'buffer', data }));
    t.storeAs = 'buffer';
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw err;
    t.memoryOnly = true;
    if (!memoryOnlyWarned) {
      memoryOnlyWarned = true;
      setTimeout(() => toast('이 브라우저(사생활 보호 모드 등)에서는 음원을 저장할 수 없어요. 지금은 쓸 수 있지만 새로고침하면 다시 넣어야 해요.', 8000), 3600);
    }
  }
}
const dbDel = (id) => tx('readwrite', st => st.delete(id));
const dbClear = () => tx('readwrite', st => st.clear());

const ls = {
  get(k, d) { try { const v = localStorage.getItem('cynp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cynp.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

/* ───────── 상태 ───────── */

const state = {
  tracks: [],                      // { id, kind:'bgm'|'sfx', name, memo, vol, start, loop, fadeIn, order, blob, type, size, duration }
  fadeSec: ls.get('fadeSec', 2),
  duck: ls.get('duck', true),
  autoNext: ls.get('autoNext', false),
  master: ls.get('master', 100),
  locked: ls.get('locked', false),
  cursor: -1,                      // 마지막으로 튼 BGM 의 순서 (다음 곡 계산용)
  talk: 'full',                    // BGM 크기: 'full' 크게 / 'bed' 잔잔하게 / 'auto' 말소리 따라(마이크)
  micSens: ls.get('micSens', 12),  // 말소리로 볼 기준: 주변 소리보다 몇 dB 커야 하는지
};
let voice = false;                 // 마이크에 말소리가 들리는 중

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const bgms = () => state.tracks.filter(t => t.kind === 'bgm').sort((a, b) => a.order - b.order);
const sfxs = () => state.tracks.filter(t => t.kind === 'sfx').sort((a, b) => a.order - b.order);
const byId = (id) => state.tracks.find(t => t.id === id);
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];

/* ───────── 소리 엔진 ───────── */

let ctx = null, masterGain, bgmBus, sfxBus, talkGain;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    masterGain = ctx.createGain();
    bgmBus = ctx.createGain();     // 더킹은 여기서
    sfxBus = ctx.createGain();
    talkGain = ctx.createGain();   // 크게/잔잔하게/말소리 따라
    talkGain.connect(bgmBus);
    bgmBus.connect(masterGain);
    sfxBus.connect(masterGain);
    masterGain.connect(ctx.destination);
    masterGain.gain.value = state.master / 100;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// 아이폰 무음 스위치가 켜져 있어도 소리가 나게 (지원하는 사파리에서만)
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 무시 */ }

function ramp(param, to, sec) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (sec <= 0) param.setValueAtTime(to, now);
  else param.linearRampToValueAtTime(to, now + sec);
}

/* BGM */
let cur = null; // { track, el, gain, url, fading }
const dying = new Set();

function makeBgmPlayer(track) {
  const a = new Audio();
  a.preload = 'auto';
  a.src = URL.createObjectURL(track.blob);
  a.loop = !!track.loop;
  const src = audio().createMediaElementSource(a);
  const gain = ctx.createGain();
  src.connect(gain).connect(talkGain);
  return { track, el: a, gain, url: a.src, fading: false, lowered: true };
}

function killPlayer(p) {
  try { p.el.pause(); } catch { /* 무시 */ }
  try { p.gain.disconnect(); } catch { /* 무시 */ }
  p.el.removeAttribute('src');
  try { p.el.load(); } catch { /* 무시 */ }
  URL.revokeObjectURL(p.url);
  dying.delete(p);
}

function fadeOutPlayer(p, sec) {
  if (!p) return;
  p.fading = true;
  dying.add(p);
  if (sec <= 0 || p.el.paused) { killPlayer(p); return; }
  ramp(p.gain.gain, 0, sec);
  setTimeout(() => killPlayer(p), sec * 1000 + 80);
}

async function playBgm(track, { userFade = true } = {}) {
  audio();
  const sec = userFade ? state.fadeSec : 0;
  const had = cur && !cur.el.paused;
  if (cur) fadeOutPlayer(cur, had ? sec : 0);
  const p = makeBgmPlayer(track);
  cur = p;
  state.cursor = bgms().indexOf(track);
  // 처음 소리: 크게 / 잔잔하게. '말소리 따라' 중이면 마이크가 계속 정한다
  if (state.talk !== 'auto') {
    state.talk = track.startBed ? 'bed' : 'full';
    applyTalk(Math.max(0.3, sec));
  } else {
    applyTalk(0.3);
  }
  p.lowered = !!track.startBed || !(track.lowerAfter > 0); // 저절로 잔잔해지기 예약
  const target = track.vol ?? 1;
  const fadeIn = track.fadeIn || had;
  p.gain.gain.value = fadeIn && sec > 0 ? 0 : target;
  p.el.addEventListener('ended', () => onBgmEnded(p));
  p.el.addEventListener('error', () => { if (cur === p) { toast(`"${track.name}"을(를) 재생할 수 없어요. 다른 형식(mp3·m4a)으로 넣어 주세요.`); stopBgm(0); } });
  try {
    if (track.start > 0) {
      await new Promise((res) => {
        if (p.el.readyState >= 1) res();
        else { p.el.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 1500); }
      });
      try { p.el.currentTime = Math.min(track.start, (p.el.duration || track.start + 1) - 0.5); } catch { /* 무시 */ }
    }
    if (cur !== p) return; // 그 사이 다른 곡을 눌렀으면 그만
    await p.el.play();
    if (fadeIn && sec > 0) ramp(p.gain.gain, target, sec);
  } catch (err) {
    if (cur === p) toast('재생하지 못했어요. 화면을 한 번 누른 뒤 다시 해 보세요.');
  }
  afterChange();
}

function onBgmEnded(p) {
  if (cur !== p) return;
  const list = bgms();
  const i = list.indexOf(p.track);
  if (state.autoNext && i >= 0 && i < list.length - 1) { playBgm(list[i + 1], { userFade: false }); return; }
  killPlayer(p);
  cur = null;
  afterChange();
}

function stopBgm(sec = state.fadeSec) {
  if (!cur) return;
  fadeOutPlayer(cur, sec);
  cur = null;
  afterChange();
}

function togglePause() {
  if (!cur) return;
  audio();
  if (cur.el.paused) cur.el.play().catch(() => {}); else cur.el.pause();
  afterChange();
}

function playNext() {
  const list = bgms();
  if (!list.length) { toast('먼저 BGM을 넣어 주세요.'); return; }
  const curIdx = cur ? list.indexOf(cur.track) : state.cursor;
  const next = curIdx + 1;
  if (next >= list.length) { toast('마지막 곡이에요.'); return; }
  playBgm(list[next]);
}

/* 효과음 */
const buffers = new Map();   // id → AudioBuffer
const decoding = new Map();  // id → Promise
const sfxPlaying = new Map(); // id → { src, gain, startedAt, offset, duration }

function decodeSfx(track) {
  if (buffers.has(track.id)) return Promise.resolve(buffers.get(track.id));
  if (decoding.has(track.id)) return decoding.get(track.id);
  const p = track.blob.arrayBuffer()
    .then(ab => new Promise((res, rej) => audio().decodeAudioData(ab, res, rej)))
    .then(buf => { buffers.set(track.id, buf); decoding.delete(track.id); return buf; })
    .catch(err => { decoding.delete(track.id); throw err; });
  decoding.set(track.id, p);
  return p;
}

async function playSfx(track) {
  audio();
  let buf;
  try { buf = await decodeSfx(track); } catch { toast(`"${track.name}"을(를) 재생할 수 없어요. mp3·m4a·wav로 넣어 주세요.`); return; }
  stopSfx(track.id); // 같은 효과음은 처음부터 다시
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = track.vol ?? 1;
  src.connect(gain).connect(sfxBus);
  const offset = Math.min(track.start || 0, Math.max(0, buf.duration - 0.05));
  const item = { src, gain, startedAt: ctx.currentTime, offset, duration: buf.duration - offset };
  sfxPlaying.set(track.id, item);
  src.onended = () => {
    if (sfxPlaying.get(track.id) === item) { sfxPlaying.delete(track.id); afterSfxChange(); }
  };
  src.start(0, offset);
  afterSfxChange();
}

function stopSfx(id) {
  const it = sfxPlaying.get(id);
  if (!it) return;
  sfxPlaying.delete(id);
  try { it.src.onended = null; it.src.stop(); } catch { /* 무시 */ }
  try { it.gain.disconnect(); } catch { /* 무시 */ }
}
function stopAllSfx() { for (const id of [...sfxPlaying.keys()]) stopSfx(id); afterSfxChange(); }

let ducked = false;
function afterSfxChange() {
  const want = state.duck && sfxPlaying.size > 0;
  if (ctx && want !== ducked) {
    ducked = want;
    ramp(bgmBus.gain, want ? 0.35 : 1, want ? 0.15 : 0.6);
  }
  updatePadStates();
  updateWakeLock();
}

function stopEverything() {
  if (cur) { killPlayer(cur); cur = null; }
  for (const p of [...dying]) killPlayer(p);
  stopAllSfx();
  stopPreview();
  afterChange();
}

/* ───────── BGM 크기: 크게 / 잔잔하게 / 말소리 따라 ───────── */

const bedLevel = () => (cur ? (cur.track.bed ?? 0.25) : 0.25);
function talkTarget() {
  if (state.talk === 'bed') return bedLevel();
  if (state.talk === 'auto') return voice ? bedLevel() : 1;
  return 1;
}
function applyTalk(sec = 1) {
  if (!ctx) return;
  ramp(talkGain.gain, talkTarget(), sec);
  renderTalk();
}

async function setTalk(mode) {
  audio();
  if (mode === 'auto' && state.talk !== 'auto') {
    const ok = await startMic();
    if (!ok) { renderTalk(); return; }
  }
  if (mode !== 'auto' && state.talk === 'auto') stopMic();
  state.talk = mode;
  if (cur) cur.lowered = true; // 손으로 바꾸면 '저절로 잔잔해지기' 예약은 취소
  applyTalk(mode === 'bed' ? 1.2 : 1.5);
}

// 마이크로 말소리 알아듣기
// - 말소리 대역(250~3500Hz)만 보고, 주변 소리(바닥 소음·스피커에서 새는 BGM)보다 '민감도'만큼 커지면 말소리로 본다
// - 말이 끝나고 1.3초 조용하면 다시 크게
let mic = null;
async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('이 브라우저에서는 마이크를 쓸 수 없어요. 🔉 잔잔하게 버튼을 써 주세요.');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    audio();
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* 무시 */ }
    const src = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500;
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    src.connect(hp).connect(lp).connect(an); // 스피커로는 보내지 않는다 (울림 방지)
    mic = { stream, src, an, buf: new Float32Array(an.fftSize), floor: -60, above: 0, lastVoice: 0, voiceSince: 0, settleUntil: performance.now() + 1500, db: -90 };
    mic.timer = setInterval(micTick, 50);
    toast('마이크로 말소리를 듣고 있어요. 리허설 때 꼭 한 번 맞춰 보세요.');
    return true;
  } catch (err) {
    toast(err && err.name === 'NotAllowedError'
      ? '마이크 사용이 막혀 있어요. 주소창 옆 설정에서 마이크를 허용해 주세요.'
      : '마이크를 켤 수 없어요. 🔉 잔잔하게 버튼을 써 주세요.');
    return false;
  }
}

function stopMic() {
  if (!mic) return;
  clearInterval(mic.timer);
  mic.stream.getTracks().forEach(t => t.stop());
  try { mic.src.disconnect(); } catch { /* 무시 */ }
  mic = null;
  voice = false;
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 무시 */ }
}

function micTick() {
  if (!mic) return;
  mic.an.getFloatTimeDomainData(mic.buf);
  let sum = 0;
  for (let i = 0; i < mic.buf.length; i++) sum += mic.buf[i] * mic.buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / mic.buf.length) + 1e-9);
  mic.db = db;
  const now = performance.now();
  // 주변 소리 기준: 내려갈 땐 빨리, 올라갈 땐 천천히 따라간다.
  // BGM 이 다시 커진 직후(settle)에는 스피커에서 새는 BGM 을 빨리 배워서 '말소리'로 착각하지 않게 한다
  if (db < mic.floor) mic.floor += (db - mic.floor) * 0.3;
  else if (!voice) mic.floor += (db - mic.floor) * (now < mic.settleUntil ? 0.25 : 0.01);
  else if (now - mic.voiceSince > 20000) mic.floor += (db - mic.floor) * 0.003; // 20초 넘게 계속이면 소음으로 보고 천천히 따라감
  mic.floor = Math.max(-90, Math.min(-15, mic.floor));
  const th = mic.floor + state.micSens;
  if (db > th && now >= mic.settleUntil) {
    if (++mic.above >= 3) { // 0.15초 이상 이어지면 말소리
      mic.lastVoice = now;
      if (!voice) { voice = true; mic.voiceSince = now; if (state.talk === 'auto') applyTalk(0.35); }
    }
  } else {
    mic.above = 0;
  }
  if (voice && now - mic.lastVoice > 1300) {
    voice = false;
    mic.settleUntil = now + 900;
    if (state.talk === 'auto') applyTalk(1.6);
  }
  // 소리 막대
  const pct = (v) => Math.max(0, Math.min(100, ((v + 80) / 70) * 100));
  $('micLevel').style.width = `${pct(db)}%`;
  $('micThresh').style.left = `${pct(th)}%`;
  $('micBox').classList.toggle('voice', voice);
}

let talkStatusAt = 0;
function renderTalk() {
  document.querySelectorAll('#talkSeg button').forEach(b => {
    const on = b.dataset.talk === state.talk;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('micBox').hidden = state.talk !== 'auto';
  const st = $('talkStatus');
  st.textContent = '';
  const pctBed = Math.round(bedLevel() * 100);
  if (state.talk === 'auto') {
    if (voice) st.append(el('span', 'voice', '말소리 들림'), ` → 잔잔하게 (${pctBed}%)`);
    else st.append('조용함 → 크게 · 말하면 저절로 작아져요');
  } else if (state.talk === 'bed') {
    st.append(el('b', '', `잔잔하게 ${pctBed}%`), ' · 말 밑에 깔리는 중');
  } else if (cur && !cur.lowered && cur.track.lowerAfter > 0) {
    const left = Math.max(0, Math.ceil(cur.track.lowerAfter - (cur.el.currentTime - (cur.track.start || 0))));
    st.append(el('b', '', '크게'), ` · ${left}초 뒤 저절로 잔잔하게`);
  } else {
    st.append(el('b', '', '크게'));
  }
}
$('talkSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-talk]');
  if (b) setTalk(b.dataset.talk);
});
const micSens = $('micSens');
micSens.value = state.micSens;
const sensText = () => { $('micSensVal').textContent = state.micSens <= 8 ? '예민하게' : state.micSens >= 20 ? '둔하게' : '보통'; };
sensText();
micSens.addEventListener('input', () => { state.micSens = +micSens.value; ls.set('micSens', state.micSens); sensText(); });

/* ───────── 화면: 지금 나오는 곡 ───────── */

function afterChange() {
  renderNow();
  renderBgmList();
  updateWakeLock();
  updateMediaSession();
}

function renderNow() {
  const now = $('now');
  const list = bgms();
  now.classList.toggle('playing', !!cur && !cur.el.paused);
  now.classList.toggle('paused', !!cur && cur.el.paused);
  $('nowTitle').textContent = cur ? cur.track.name : '재생 중인 곡 없음';
  $('nowMemo').textContent = cur ? (cur.track.memo || '') : '';
  $('pauseBtn').disabled = !cur;
  $('fadeBtn').disabled = !cur;
  const pb = $('pauseBtn');
  pb.querySelector('i').textContent = cur && cur.el.paused ? '▶' : '⏸';
  pb.querySelector('span').textContent = cur && cur.el.paused ? '계속' : '일시정지';
  const curIdx = cur ? list.indexOf(cur.track) : state.cursor;
  const next = list[curIdx + 1];
  const nu = $('nextUp');
  nu.textContent = '';
  if (next) nu.append('다음 곡: ', el('b', '', `${curIdx + 2}. ${next.name}`), next.memo ? ` · ${next.memo}` : '');
  else if (list.length) nu.textContent = '다음 곡 없음 (마지막)';
  $('nextCue').textContent = next && next.cue ? `▶ 틀 신호: ${next.cue}` : '';
  renderTalk();
  $('nextBtn').disabled = !next;
  if (!cur) { $('seekFill').style.width = '0%'; $('tNow').textContent = '0:00'; $('tLeft').textContent = '-0:00'; }
}

function tick() {
  if (cur) {
    const d = cur.el.duration, t = cur.el.currentTime;
    if (isFinite(d) && d > 0) {
      $('seekFill').style.width = `${(t / d) * 100}%`;
      $('tNow').textContent = fmt(t);
      $('tLeft').textContent = '-' + fmt(d - t);
      const row = document.querySelector(`.bgm[data-id="${cur.track.id}"] .prog`);
      if (row) row.style.width = `${(t / d) * 100}%`;
    }
    // 예약한 시간이 되면 저절로 잔잔하게 (MC 인사가 끝날 때쯤)
    if (!cur.lowered && state.talk === 'full' && cur.track.lowerAfter > 0 && t - (cur.track.start || 0) >= cur.track.lowerAfter) {
      cur.lowered = true;
      state.talk = 'bed';
      applyTalk(2.5);
    }
    const nowMs = performance.now();
    if (nowMs - talkStatusAt > 250) { talkStatusAt = nowMs; if (state.talk === 'full' && !cur.lowered) renderTalk(); }
  }
  if (sfxPlaying.size && ctx) {
    for (const [id, it] of sfxPlaying) {
      const pr = document.querySelector(`.pad[data-id="${id}"] .pprog`);
      if (pr) pr.style.width = `${Math.min(100, ((ctx.currentTime - it.startedAt) / it.duration) * 100)}%`;
    }
  }
  requestAnimationFrame(tick);
}

$('seek').addEventListener('click', (e) => {
  if (!cur || !isFinite(cur.el.duration)) return;
  const r = e.currentTarget.getBoundingClientRect();
  cur.el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * cur.el.duration;
});
$('pauseBtn').addEventListener('click', togglePause);
$('nextBtn').addEventListener('click', playNext);
$('fadeBtn').addEventListener('click', () => stopBgm());
$('stopAllBtn').addEventListener('click', stopEverything);
$('stopSfxBtn').addEventListener('click', stopAllSfx);

const master = $('master');
master.value = state.master;
$('masterVal').textContent = `${state.master}%`;
master.addEventListener('input', () => {
  state.master = +master.value;
  $('masterVal').textContent = `${state.master}%`;
  if (ctx) ramp(masterGain.gain, state.master / 100, 0.05);
  ls.set('master', state.master);
});

/* ───────── 화면: BGM 목록 ───────── */

function renderBgmList() {
  const list = bgms();
  const ol = $('bgmList');
  ol.textContent = '';
  $('bgmEmpty').hidden = list.length > 0;
  const curIdx = cur ? list.indexOf(cur.track) : state.cursor;
  list.forEach((t, i) => {
    const li = el('li', 'bgm' + (cur && cur.track === t ? ' current' : '') + (i === curIdx + 1 ? ' next' : ''));
    li.dataset.id = t.id;
    li.appendChild(el('span', 'num', String(i + 1)));
    const info = el('div', 'info');
    info.appendChild(el('div', 'name', t.name));
    const bits = [fmt(t.duration || 0)];
    if (t.memo) bits.unshift(t.memo);
    if (t.startBed) bits.push('잔잔하게 시작');
    else if (t.lowerAfter > 0) bits.push(`${t.lowerAfter}초 뒤 잔잔하게`);
    if (t.cue) bits.push(`신호: ${t.cue}`);
    if (t.loop) bits.push('반복');
    if (t.start > 0) bits.push(`${t.start}초부터`);
    if ((t.vol ?? 1) !== 1) bits.push(`음량 ${Math.round(t.vol * 100)}%`);
    info.appendChild(el('div', 'meta', bits.join(' · ')));
    li.appendChild(info);
    const more = el('button', 'more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', `${t.name} 설정`);
    li.appendChild(more);
    li.appendChild(el('div', 'prog'));
    ol.appendChild(li);
  });
}

$('bgmList').addEventListener('click', (e) => {
  const li = e.target.closest('.bgm');
  if (!li) return;
  const t = byId(li.dataset.id);
  if (!t) return;
  if (e.target.closest('.more')) { openTrack(t); return; }
  if (cur && cur.track === t) { togglePause(); return; } // 지금 곡을 누르면 일시정지/계속
  playBgm(t);
});

/* ───────── 화면: 효과음 패드 ───────── */

function renderPads() {
  const list = sfxs();
  const box = $('pads');
  box.textContent = '';
  $('sfxEmpty').hidden = list.length > 0;
  $('stopSfxBtn').hidden = !list.length;
  list.forEach((t, i) => {
    const b = el('button', 'pad');
    b.type = 'button';
    b.dataset.id = t.id;
    b.appendChild(el('span', 'key', PAD_KEYS[i] ? PAD_KEYS[i].toUpperCase() : '·'));
    b.appendChild(el('span', 'pname', t.name));
    b.appendChild(el('span', 'pmeta', [t.memo, t.cue, fmt(t.duration || 0)].filter(Boolean).join(' · ')));
    const more = el('span', 'more', '⋯');
    more.setAttribute('role', 'button');
    more.setAttribute('aria-label', `${t.name} 설정`);
    b.appendChild(more);
    b.appendChild(el('div', 'pprog'));
    box.appendChild(b);
  });
  updatePadStates();
}

function updatePadStates() {
  document.querySelectorAll('.pad').forEach(p => {
    const on = sfxPlaying.has(p.dataset.id);
    p.classList.toggle('playing', on);
    if (!on) { const pr = p.querySelector('.pprog'); if (pr) pr.style.width = '0'; }
  });
}

// 화면을 밀어 내리다 닿았을 때 잘못 나가지 않게, 눌렀다 뗄 때(click) 튼다
$('pads').addEventListener('click', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad) return;
  const t = byId(pad.dataset.id);
  if (!t) return;
  if (e.target.closest('.more')) openTrack(t); else playSfx(t);
});

/* ───────── 음원 넣기 ───────── */

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm|mp4|caf|aiff?)$/i;
const isAudio = (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);

function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(null);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

let adding = false;
async function addFiles(files, kind) {
  files = Array.from(files || []);
  if (!files.length || adding) return;
  adding = true;
  let ok = 0, bad = 0, skip = 0;
  try { await navigator.storage?.persist?.(); } catch { /* 무시 */ }
  let order = Math.max(0, ...state.tracks.filter(t => t.kind === kind).map(t => t.order + 1));
  for (const f of files) {
    if (!isAudio(f)) { skip++; continue; }
    toast(`음원 넣는 중… ${ok + bad + 1} / ${files.length}`, 60000);
    const duration = await probeDuration(f);
    if (duration === null) { bad++; continue; }
    const t = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind, name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), memo: '', vol: 1, start: 0,
      loop: false, fadeIn: false, order: order++, blob: f, type: f.type, size: f.size, duration,
    };
    try {
      await dbPut(t);
    } catch (err) {
      toast(err && err.name === 'QuotaExceededError' ? '기기 저장 공간이 부족해요.' : '음원을 저장하지 못했어요.');
      break;
    }
    state.tracks.push(t);
    ok++;
    if (kind === 'sfx') decodeSfx(t).catch(() => {});
  }
  adding = false;
  const msg = [`${kind === 'bgm' ? 'BGM' : '효과음'} ${ok}개를 넣었어요.`];
  if (bad) msg.push(`이 기기에서 재생할 수 없는 파일 ${bad}개는 뺐어요.`);
  if (skip) msg.push(`음악 파일이 아닌 ${skip}개는 건너뛰었어요.`);
  toast(msg.join(' '));
  renderAll();
}

$('addBgm').addEventListener('change', (e) => { const f = e.target.files; addFiles(f, 'bgm').finally(() => { e.target.value = ''; }); });
$('addSfx').addEventListener('change', (e) => { const f = e.target.files; addFiles(f, 'sfx').finally(() => { e.target.value = ''; }); });

// 끌어다 놓기: 효과음 칸에 놓으면 효과음, 나머지는 BGM
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (state.locked || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('dropCover').hidden = false;
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropCover').hidden = true; } });
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  const sfx = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('#sfxCard');
  $('dropCover').textContent = sfx ? '효과음으로 넣어요' : 'BGM으로 넣어요 (효과음은 효과음 칸에 놓기)';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropCover').hidden = true;
  if (state.locked || !e.dataTransfer) return;
  const sfx = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('#sfxCard');
  addFiles(e.dataTransfer.files, sfx ? 'sfx' : 'bgm');
});

/* ───────── 음원 설정 창 ───────── */

let editing = null;
let preview = null; // { el, url }
function stopPreview() {
  if (!preview) return;
  preview.el.pause();
  URL.revokeObjectURL(preview.url);
  preview = null;
  $('tdPreview').textContent = '▶ 미리 듣기';
}

function openTrack(t) {
  if (state.locked) return;
  editing = t;
  $('tdTitle').textContent = t.kind === 'bgm' ? 'BGM 설정' : '효과음 설정';
  $('tdName').value = t.name;
  $('tdMemo').value = t.memo || '';
  $('tdCue').value = t.cue || '';
  $('tdStartBed').value = t.startBed ? '1' : '0';
  $('tdLowerAfter').value = t.lowerAfter || 0;
  $('tdBed').value = Math.round((t.bed ?? 0.25) * 100);
  $('tdBedVal').textContent = `${$('tdBed').value}%`;
  $('tdVol').value = Math.round((t.vol ?? 1) * 100);
  $('tdVolVal').textContent = `${$('tdVol').value}%`;
  $('tdStart').value = t.start || 0;
  $('tdLoop').checked = !!t.loop;
  $('tdFadeIn').checked = !!t.fadeIn;
  document.querySelectorAll('#trackDlg .bgm-only').forEach(x => { x.hidden = t.kind !== 'bgm'; });
  $('tdKind').textContent = t.kind === 'bgm' ? '효과음으로 옮기기' : 'BGM으로 옮기기';
  $('trackDlg').returnValue = '';
  $('trackDlg').showModal();
}
$('tdBed').addEventListener('input', () => { $('tdBedVal').textContent = `${$('tdBed').value}%`; });
$('tdVol').addEventListener('input', () => { $('tdVolVal').textContent = `${$('tdVol').value}%`; if (preview) preview.el.volume = Math.min(1, $('tdVol').value / 100); });

$('tdPreview').addEventListener('click', () => {
  if (preview) { stopPreview(); return; }
  if (!editing) return;
  const a = new Audio();
  const url = URL.createObjectURL(editing.blob);
  a.src = url;
  a.volume = Math.min(1, $('tdVol').value / 100);
  a.currentTime = Number($('tdStart').value) || 0;
  a.onended = stopPreview;
  a.play().catch(() => toast('미리 듣기를 할 수 없어요.'));
  preview = { el: a, url };
  $('tdPreview').textContent = '■ 멈추기';
  toast('미리 듣기도 스피커로 나가요. 행사 중에는 조심하세요.');
});

async function moveTrack(dir) {
  if (!editing) return;
  const list = editing.kind === 'bgm' ? bgms() : sfxs();
  const i = list.indexOf(editing);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const other = list[j];
  [editing.order, other.order] = [other.order, editing.order];
  await Promise.all([dbPut(editing), dbPut(other)]);
  if (cur) state.cursor = bgms().indexOf(cur.track);
  renderAll();
  toast(dir < 0 ? '위로 옮겼어요.' : '아래로 옮겼어요.');
}
$('tdUp').addEventListener('click', () => moveTrack(-1));
$('tdDown').addEventListener('click', () => moveTrack(1));

$('tdKind').addEventListener('click', async () => {
  if (!editing) return;
  const t = editing;
  if (cur && cur.track === t) stopBgm(0);
  stopSfx(t.id);
  t.kind = t.kind === 'bgm' ? 'sfx' : 'bgm';
  t.order = Math.max(0, ...state.tracks.filter(x => x.kind === t.kind && x !== t).map(x => x.order + 1));
  await dbPut(t);
  if (t.kind === 'sfx') decodeSfx(t).catch(() => {});
  $('trackDlg').close('moved');
  renderAll();
  toast(t.kind === 'sfx' ? '효과음으로 옮겼어요.' : 'BGM으로 옮겼어요.');
});

$('tdDelete').addEventListener('click', async () => {
  if (!editing) return;
  const t = editing;
  if (!confirm(`"${t.name}"을(를) 지울까요? (원래 파일은 그대로예요)`)) return;
  if (cur && cur.track === t) stopBgm(0);
  stopSfx(t.id);
  await dbDel(t.id);
  state.tracks = state.tracks.filter(x => x !== t);
  buffers.delete(t.id);
  $('trackDlg').close('deleted');
  renderAll();
});

$('trackDlg').addEventListener('close', async () => {
  stopPreview();
  const t = editing;
  editing = null;
  if (!t || $('trackDlg').returnValue !== 'save') return;
  t.name = $('tdName').value.trim() || t.name;
  t.memo = $('tdMemo').value.trim();
  t.cue = $('tdCue').value.trim();
  if (t.kind === 'bgm') {
    t.startBed = $('tdStartBed').value === '1';
    t.lowerAfter = Math.max(0, Math.round(Number($('tdLowerAfter').value) || 0));
    t.bed = Math.max(5, Math.min(70, Number($('tdBed').value))) / 100;
  }
  t.vol = Math.max(0, Math.min(150, Number($('tdVol').value))) / 100;
  t.start = Math.max(0, Number($('tdStart').value) || 0);
  if (t.kind === 'bgm') { t.loop = $('tdLoop').checked; t.fadeIn = $('tdFadeIn').checked; }
  await dbPut(t);
  // 지금 나오는 곡이면 바로 반영
  if (cur && cur.track === t) { cur.el.loop = t.loop; ramp(cur.gain.gain, t.vol, 0.2); applyTalk(0.5); }
  renderAll();
});

/* ───────── 설정 ───────── */

$('fadeSec').value = String(state.fadeSec);
$('fadeSec').addEventListener('change', (e) => { state.fadeSec = Number(e.target.value); ls.set('fadeSec', state.fadeSec); });
$('duck').checked = state.duck;
$('duck').addEventListener('change', (e) => { state.duck = e.target.checked; ls.set('duck', state.duck); afterSfxChange(); });
$('autoNext').checked = state.autoNext;
$('autoNext').addEventListener('change', (e) => { state.autoNext = e.target.checked; ls.set('autoNext', state.autoNext); });
$('clearAll').addEventListener('click', async () => {
  if (!state.tracks.length) return;
  if (!confirm(`넣은 음원 ${state.tracks.length}개를 모두 지울까요? (원래 파일은 그대로예요)`)) return;
  stopEverything();
  await dbClear();
  state.tracks = [];
  buffers.clear();
  state.cursor = -1;
  renderAll();
});

function applyLock() {
  document.body.classList.toggle('locked', state.locked);
  const b = $('lockBtn');
  b.textContent = state.locked ? '🔒 공연 모드' : '편집 중';
  b.classList.toggle('locked', state.locked);
  b.setAttribute('aria-pressed', state.locked);
}
$('lockBtn').addEventListener('click', () => {
  state.locked = !state.locked;
  ls.set('locked', state.locked);
  applyLock();
  toast(state.locked ? '공연 모드: 실수로 지우거나 바꾸지 않게 편집 버튼을 숨겼어요.' : '편집할 수 있어요.');
});

async function renderUsage() {
  const total = state.tracks.reduce((s, t) => s + (t.size || 0), 0);
  let text = `넣은 음원 ${state.tracks.length}개 · ${(total / 1e6).toFixed(1)}MB · 이 기기·이 브라우저에만 저장돼요.`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.quota) text += ` (남은 공간 약 ${((est.quota - est.usage) / 1e9).toFixed(1)}GB)`;
  } catch { /* 무시 */ }
  $('usage').textContent = text;
}

function renderAll() {
  renderNow();
  renderBgmList();
  renderPads();
  renderUsage();
}

/* ───────── 키보드 ───────── */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'pagedown' || k === 'arrowright') { e.preventDefault(); playNext(); return; }
  if (k === 'k' || k === 'enter') { e.preventDefault(); togglePause(); return; }
  if (k === 'f') { stopBgm(); return; }
  if (k === 'escape') { stopEverything(); return; }
  if (k === 's') { stopAllSfx(); return; }
  if (k === 'd') { setTalk(state.talk === 'bed' ? 'full' : 'bed'); return; }
  if (k === 'm') { setTalk(state.talk === 'auto' ? 'full' : 'auto'); return; }
  const i = PAD_KEYS.indexOf(k);
  if (i >= 0) { const t = sfxs()[i]; if (t) { e.preventDefault(); playSfx(t); } }
});

/* ───────── 화면 꺼짐 막기 · 잠금 화면 조작 · 닫기 경고 ───────── */

let wake = null;
const anythingPlaying = () => (cur && !cur.el.paused) || sfxPlaying.size > 0;
async function updateWakeLock() {
  try {
    if (anythingPlaying() || state.tracks.length) {
      if (!wake && navigator.wakeLock && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    }
  } catch { wake = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });
window.addEventListener('beforeunload', (e) => { if (anythingPlaying()) { e.preventDefault(); e.returnValue = ''; } });

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = cur ? new MediaMetadata({ title: cur.track.name, artist: '청년회의 밤', album: cur.track.memo || 'BGM' }) : null;
    navigator.mediaSession.playbackState = cur ? (cur.el.paused ? 'paused' : 'playing') : 'none';
  } catch { /* 무시 */ }
}
if ('mediaSession' in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* 무시 */ } };
  set('play', () => { if (cur && cur.el.paused) togglePause(); });
  set('pause', () => { if (cur && !cur.el.paused) togglePause(); });
  set('nexttrack', playNext);
  set('stop', () => stopBgm());
}

/* ───────── 도움말 ───────── */

const HELP = `
<h2>쓰는 방법</h2>
<ol>
  <li><b>＋ BGM 넣기</b>로 음악을 PPT 순서대로 넣으세요. 순서는 ⋯ → ▲▼로 바꿔요.</li>
  <li><b>＋ 효과음 넣기</b>로 박수·환호 같은 짧은 소리를 넣으세요.</li>
  <li>⋯ 에서 <b>메모</b>(예: 슬라이드 3 · 입장할 때)를 적어 두면 목록과 위 화면에 보여요. 음량, 앞부분 건너뛰기, 반복도 여기서 정해요.</li>
  <li>준비가 끝나면 오른쪽 위 <b>편집 중</b>을 눌러 <b>🔒 공연 모드</b>로 바꾸세요. 실수로 지우거나 바꾸지 않게 돼요.</li>
</ol>

<h3>행사 때</h3>
<ul>
  <li><b>⏭ 다음 곡</b>: 목록 순서대로 다음 BGM을 틀어요. 지금 곡은 서서히 줄어들며 넘어가요.</li>
  <li>목록에서 곡을 누르면 그 곡으로 바로 넘어가요. 지금 나오는 곡을 다시 누르면 일시정지/계속이에요.</li>
  <li><b>🔉 서서히 끄기</b>: BGM만 부드럽게 꺼요. <b>⏹ 모두 끄기</b>: BGM과 효과음을 바로 다 꺼요.</li>
  <li>효과음 칸은 누르는 순간 바로 나와요. 같은 칸을 다시 누르면 처음부터 다시 나와요.</li>
  <li>남은 시간이 위에 크게 보여서 다음 곡 넘길 때를 맞추기 쉬워요.</li>
</ul>

<h3>말소리와 BGM 맞추기</h3>
<ul>
  <li><b>🔊 크게 / 🔉 잔잔하게</b>: MC가 말을 시작하면 🔉, 끝나면 🔊. 가장 확실한 방법이에요. (키보드 <kbd>D</kbd>)</li>
  <li><b>저절로 잔잔해지기</b>: 곡의 ⋯ 에서 "MC 등장곡을 크게 → 10초 뒤 잔잔하게"처럼 정해 두면, 인사가 끝날 때쯤 저절로 줄어요. 남은 초가 위에 보여요.</li>
  <li><b>잔잔하게 시작</b>: 처음부터 말 밑에 깔 BGM은 ⋯ 에서 "잔잔하게 시작"으로 정하세요. 잔잔할 때 크기(기본 25%)도 곡마다 정할 수 있어요.</li>
  <li><b>🎤 말소리 따라</b>: 이 기기 마이크로 말소리를 듣고, 말하는 동안 BGM을 줄였다가 말이 끝나면 다시 키워요. (키보드 <kbd>M</kbd>)
    <ul>
      <li>기기를 <b>MC 쪽(무대 가까이)</b>에, <b>스피커와는 멀리</b> 두세요. 스피커 소리를 말소리로 착각할 수 있어요.</li>
      <li>소리 막대의 노란 선이 기준이에요. 말할 때만 막대가 선을 넘게 <b>민감도</b>를 맞추세요.</li>
      <li>리허설에서 꼭 맞춰 보고, 흔들리면 🔊/🔉 버튼으로 바꾸세요.</li>
      <li>아이폰은 마이크를 켜면 소리가 나오는 곳이나 크기가 바뀔 수 있어요. 스피커를 연결한 상태로 미리 확인하세요.</li>
    </ul>
  </li>
  <li><b>틀 신호</b>: 곡마다 "MC가 '영상 보시죠' 하면"처럼 적어 두면, 위 화면에 <b>다음 곡의 신호</b>가 노란 글씨로 보여요. 대사–화면–음악 타이밍을 맞추기 쉬워요.</li>
</ul>

<h3>키보드 (컴퓨터)</h3>
<ul>
  <li><kbd>스페이스</kbd> 다음 곡 · <kbd>K</kbd> 일시정지/계속 · <kbd>F</kbd> 서서히 끄기 · <kbd>Esc</kbd> 모두 끄기 · <kbd>S</kbd> 효과음만 멈추기 · <kbd>D</kbd> 크게/잔잔하게 · <kbd>M</kbd> 말소리 따라</li>
  <li>효과음: 칸 왼쪽 위 글자 <kbd>1</kbd>~<kbd>0</kbd>, <kbd>Q</kbd>~<kbd>P</kbd></li>
</ul>

<h3>PPT와 함께 쓸 때 꼭 알아 두세요</h3>
<ul>
  <li>PPT 슬라이드 쇼가 켜진 컴퓨터에서는 키보드가 PPT로 가요. 그래서 <b>음향은 다른 기기(폰·태블릿·다른 노트북)</b>를 스피커에 연결해서 따로 누르는 게 가장 안전해요.</li>
  <li>같은 노트북을 써야 하면, 발표자 보기 화면 옆에 이 창을 띄워 두고 <b>마우스로</b> 누르세요.</li>
  <li><b>아이폰</b>: 옆면 무음 스위치를 꺼 두세요. 기종에 따라 무음일 때 소리가 안 날 수 있어요. 소리는 폰 옆 음량 버튼과 위 <b>전체 음량</b>을 함께 확인하세요.</li>
  <li>음원을 넣고 나면 인터넷이 없어도 재생돼요. 행사 전에 한 번 끝까지 리허설해 보세요.</li>
</ul>

<h3>저장</h3>
<p>음원은 <b>이 기기·이 브라우저 안에만</b> 저장되고 어디로도 보내지 않아요. 다른 기기나 다른 브라우저(예: 카톡 안 브라우저 ↔ 사파리)에서는 다시 넣어야 해요. 홈 화면에 추가해서 쓰면 편해요.</p>
`;
$('helpBtn').addEventListener('click', () => { $('helpBody').innerHTML = HELP; $('helpDlg').showModal(); });

/* ───────── 알림 ───────── */

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast');
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ───────── 시작 ───────── */

applyLock();
renderAll();
requestAnimationFrame(tick);
// 첫 터치 때 소리 장치를 깨운다 (폰 브라우저는 사용자가 눌러야 소리를 낼 수 있음)
document.addEventListener('pointerdown', () => audio(), { once: true, capture: true });

dbAll().then(items => {
  for (const it of items) {
    if (!it.blob && it.data) { it.blob = new Blob([it.data], { type: it.type || 'audio/mpeg' }); delete it.data; }
  }
  state.tracks = items.filter(it => it.blob);
  renderAll();
  // 효과음은 미리 풀어 둬서 처음 누를 때도 바로 나오게
  for (const t of sfxs()) decodeSfx(t).catch(() => {});
}).catch(() => toast('이 브라우저에서는 음원을 저장할 수 없어요. (사생활 보호 모드라면 꺼 주세요)'));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.__player = { get tgain() { return talkGain; }, state, playBgm, playSfx, playNext, stopEverything, get cur() { return cur; }, get sfx() { return sfxPlaying; }, get bus() { return bgmBus; } };
