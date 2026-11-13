import {
  DOW_KO, extractGps, locate, classify, isPicked, parseExifDateTime, findDate,
  dateLabel, buildExportNames, makeZip, safeName, crc32,
} from './core.js';
import {
  boxAll, boxPut, boxDelete, boxClear, askPersist, parseExportName, readZipEntries, entryBlob,
} from './collection.js';

/* ───────── 상태 ───────── */

const DEFAULTS = { from: '2026-01-01', to: '2026-12-31', days: [3, 6, 0], buffer: 50 };
const LS = { settings: 'cyn.settings.v1', name: 'cyn.name' };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작 */ } },
};

function loadSettings() {
  try {
    const s = JSON.parse(store.get(LS.settings) || 'null');
    if (s && Array.isArray(s.days)) return { ...DEFAULTS, ...s };
  } catch { /* 무시 */ }
  return { ...DEFAULTS, days: [...DEFAULTS.days] };
}

const state = {
  // 내 사진 정리: { id, file, name, type, dt, dtSource, gps, dist, area, cat, thumb, thumbBlob, thumbFail, converted }
  photos: [],
  seen: new Set(),       // 이름|크기|수정시각
  seen2: new Set(),      // 이름|크기|촬영시각 (아이폰에서 같은 사진을 다시 고를 때)
  stats: { selected: 0, dup: 0, ignored: 0 },
  failed: [],            // { name, reason }
  overrides: new Map(),  // id → true(넣기) / false(빼기)
  settings: loadSettings(),
  person: store.get(LS.name) || '',
  tab: 'in',
  busy: false,
  mode: 'mine',
  selecting: false,      // '날짜 없음' 묶음에서 여러 장 고르기
  selected: new Set(),
  box: [],               // 모음함: { key, person, name, type, size, crc, dt, dtSource, blob, thumb, addedAt, from, file }
  boxFilter: '',
  prepared: new Map(),   // 보내기용으로 만들어 둔 ZIP (키 → File)
};
let nextId = 1;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const nextFrame = () => new Promise(r => setTimeout(r, 0));
const hm = (hhmm) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
const SRC_LABEL = { exif: '촬영 정보', name: '파일 이름', manual: '직접 정함' };

function fmtSize(b) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)}MB`;
  return `${Math.max(1, Math.round(b / 1e3))}KB`;
}

/* ───────── 이름 ───────── */

function updateNameBtn() {
  $('nameBtn').textContent = state.person ? `${state.person} ✎` : '이름 입력';
}
function askName() {
  $('nameInput').value = state.person;
  if (!$('nameDlg').open) $('nameDlg').showModal();
  setTimeout(() => $('nameInput').focus(), 50);
}
$('nameForm').addEventListener('submit', () => {
  const v = safeName($('nameInput').value);
  if (v && v !== '이름없음') {
    state.person = v;
    store.set(LS.name, v);
    updateNameBtn();
  }
});
$('nameBtn').addEventListener('click', askName);

/* ───────── 사진 불러오기 (대기열, 동시에 3장씩) ───────── */

const IMG_EXT = /\.(jpe?g|heic|heif|png|webp|gif|dng|tiff?|bmp|avif)$/i;
const isImageName = (name) => IMG_EXT.test(name);
const looksImage = (f) => (f.type && f.type.startsWith('image/')) || isImageName(f.name);
const isHeic = (p) => /heic|heif/i.test(p.type || '') || /\.(heic|heif)$/i.test(p.name || '');
const mimeOf = (name) => {
  const e = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic', heif: 'image/heif', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[e] || 'application/octet-stream';
};

// EXIF 는 필요한 항목만 골라 앞부분만 읽는다
const EXIF_OPTS = {
  tiff: true, ifd0: true, exif: true, gps: true,
  ifd1: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, makerNote: false, userComment: false,
  pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'DateTime', 'ModifyDate',
    'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
  reviveValues: false,     // 날짜를 문자열 그대로 받는다 (시간대 변환 X)
  translateValues: false,
  mergeOutput: true,
};

async function readMeta(file) {
  try {
    return await window.exifr.parse(file, EXIF_OPTS);
  } catch {
    return null;
  }
}

// 파일 앞 16바이트로 사진인지 확인한다
const IMAGE_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/;
function sniff(b) {
  if (b.length < 4) return 'unknown';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'image';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image';
  const ascii = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image';
  if (ascii(4, 4) === 'ftyp') return IMAGE_BRANDS.test(ascii(8, 4)) ? 'image' : 'video';
  return 'unknown';
}

async function readOne(f) {
  if (!f.size) return { fail: '빈 파일이에요' };
  let head;
  try {
    head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
  } catch {
    return { fail: '파일을 열 수 없어요 (아이클라우드에서 아직 안 받은 사진일 수 있어요)' };
  }
  const kind = sniff(head);
  if (kind === 'video') return { fail: '동영상이에요 (사진만 불러와요)' };
  if (kind === 'unknown') return { fail: looksImage(f) ? '사진 형식을 알 수 없어요 (파일이 깨졌을 수 있어요)' : '사진 파일이 아니에요' };
  const meta = await readMeta(f);
  const { dt, source } = findDate(meta, f.name);
  const gps = extractGps(meta);
  const loc = gps ? locate(gps.lat, gps.lon) : null;
  return {
    photo: {
      id: nextId++, file: f, name: f.name, type: f.type || mimeOf(f.name),
      dt, dtSource: source, gps, dist: loc ? loc.distance : null, area: loc ? (loc.inside || loc.nearest) : null,
      cat: null, thumb: null, thumbBlob: null, thumbFail: false, converted: null,
    },
  };
}

function setProgress(prefix, show, text, ratio) {
  $(prefix).hidden = !show;
  if (text != null) $(prefix + 'Text').textContent = text;
  if (ratio != null) $(prefix + 'Bar').style.width = `${Math.round(ratio * 100)}%`;
}

const LOAD_WORKERS = 3;

// fromFolder: 폴더째 고르기·끌어다 놓기에서는 사진이 아닌 파일(.txt 등)을 조용히 건너뛴다
async function addFiles(fileList, fromFolder = false) {
  let all = Array.from(fileList || []);
  if (fromFolder) {
    const before = all.length;
    all = all.filter(f => looksImage(f) && !f.name.startsWith('.'));
    state.stats.ignored += before - all.length;
  }
  if (!all.length) { toast('사진 파일이 없어요.'); return; }
  state.busy = true;
  const batch = { selected: all.length, ok: 0, dup: 0, failed: 0 };
  state.stats.selected += all.length;

  const queue = [];
  for (const f of all) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (state.seen.has(key)) { batch.dup++; continue; }
    state.seen.add(key);
    queue.push(f);
  }
  let done = batch.dup, last = 0;
  const tick = async () => {
    const now = performance.now();
    if (now - last > 120 || done === all.length) {
      last = now;
      setProgress('progress', true, `불러오는 중 ${done} / ${all.length}`, done / all.length);
      await nextFrame();
    }
  };
  setProgress('progress', true, `불러오는 중 ${done} / ${all.length}`, done / all.length);

  let qi = 0;
  const worker = async () => {
    while (qi < queue.length) {
      const f = queue[qi++];
      let r;
      try { r = await readOne(f); } catch (err) { r = { fail: `읽다가 문제가 생겼어요 (${err?.name || '알 수 없음'})` }; }
      if (r.fail) {
        batch.failed++;
        state.failed.push({ name: f.name || '(이름 없음)', reason: r.fail });
      } else {
        const p = r.photo;
        const key2 = p.dt ? `${p.name}|${p.file.size}|${p.dt.sortKey}` : null;
        if (key2 && state.seen2.has(key2)) {
          batch.dup++;
        } else {
          if (key2) state.seen2.add(key2);
          state.photos.push(p);
          batch.ok++;
        }
      }
      done++;
      await tick();
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOAD_WORKERS, queue.length || 1) }, worker));

  state.stats.dup += batch.dup;
  state.busy = false;
  setProgress('progress', false);
  showBatchMessage(batch);
  render();
}

function showBatchMessage(b) {
  const box = $('batchMsg');
  box.hidden = false;
  box.className = 'batch-msg ' + (b.failed ? 'bad' : 'ok');
  box.textContent = `선택한 사진 ${b.selected}장 중 ${b.ok + b.dup}장 인식`;
  const notes = [];
  if (b.dup) notes.push(`이미 불러온 ${b.dup}장은 겹쳐서 한 번만 넣었어요`);
  if (b.failed) notes.push(`${b.failed}장은 불러오지 못했어요 (아래 목록)`);
  if (notes.length) box.appendChild(el('small', '', notes.join(' · ')));
  if (b.failed) $('failBox').open = true;
}

for (const id of ['pickPhotos', 'pickFiles', 'pickFolder']) {
  $(id).addEventListener('change', async (e) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = ''; // 같은 사진을 다시 골라도 알 수 있게 비운다
    if (state.busy) { toast('지금 사진을 읽는 중이에요. 끝나면 다시 골라 주세요.'); return; }
    await addFiles(files, id === 'pickFolder');
  });
}

$('clearBtn').addEventListener('click', () => {
  if (!confirm('불러온 사진을 모두 지울까요? (폰 사진첩과 모음함의 사진은 그대로 있어요)')) return;
  for (const p of state.photos) if (p.thumb) URL.revokeObjectURL(p.thumb);
  state.photos = [];
  state.seen.clear();
  state.seen2.clear();
  state.stats = { selected: 0, dup: 0, ignored: 0 };
  state.failed = [];
  state.overrides.clear();
  state.selecting = false;
  state.selected.clear();
  thumbQueue.length = 0;
  $('batchMsg').hidden = true;
  render();
});

/* ───────── 끌어다 놓기 (컴퓨터) ───────── */

async function filesFromDrop(dt) {
  const items = Array.from(dt.items || []);
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) { try { await walk(e); } catch { /* 못 읽은 항목은 건너뜀 */ } }
  return out;
}

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('dropCover').hidden = false;
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropCover').hidden = true; } });
document.addEventListener('dragover', (e) => { if (e.dataTransfer) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropCover').hidden = true;
  if (!e.dataTransfer) return;
  const files = await filesFromDrop(e.dataTransfer);
  if (state.mode === 'box') { await importReceived(files); return; }
  if (state.busy) { toast('지금 사진을 읽는 중이에요.'); return; }
  await addFiles(files, true);
});

/* ───────── 이미지 열기·미리보기 ───────── */

const THUMB = 300; // 긴 변
const thumbQueue = [];
let thumbWorkers = 0;
let heicLib = null;

function loadHeicLib() {
  if (!heicLib) {
    heicLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/heic2any.min.js';
      s.onload = () => resolve(window.heic2any);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return heicLib;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// p: { file(Blob), name, type, converted }
// 브라우저가 못 여는 HEIC(안드로이드 등)는 JPEG 로 바꿔서 보여준다 (보기용, 저장은 원본)
async function openImage(p) {
  const url = URL.createObjectURL(p.converted || p.file);
  try {
    return { img: await loadImage(url), url };
  } catch (err) {
    URL.revokeObjectURL(url);
    if (!isHeic(p) || p.converted) throw err;
    const heic2any = await loadHeicLib();
    const out = await heic2any({ blob: p.file, toType: 'image/jpeg', quality: 0.8 });
    p.converted = Array.isArray(out) ? out[0] : out;
    const url2 = URL.createObjectURL(p.converted);
    try { return { img: await loadImage(url2), url: url2 }; } catch (e) { URL.revokeObjectURL(url2); throw e; }
  }
}

async function thumbBlob(p) {
  const { img, url } = await openImage(p);
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, THUMB / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
    c.width = c.height = 0;
    if (!blob) throw new Error('thumb');
    return blob;
  } finally {
    URL.revokeObjectURL(url);       // 원본 이미지는 바로 놓아준다
    img.removeAttribute('src');
    p.converted = null;             // 바꾼 HEIC 도 버린다
  }
}

const VISIBLE = ['in', 'nodate', 'nogps', 'out'];
function queueThumbs() {
  const order = { in: 0, nodate: 1, nogps: 2, out: 3 };
  const onTab = (p) => (tabCats(state.tab).includes(p.cat) ? 0 : 1);
  const want = state.photos
    .filter(p => VISIBLE.includes(p.cat) && !p.thumb && !p.thumbFail)
    .sort((a, b) => onTab(a) - onTab(b) || order[a.cat] - order[b.cat]);
  thumbQueue.length = 0;
  thumbQueue.push(...want);
  while (thumbWorkers < 2 && thumbQueue.length) runThumbs();
}

async function runThumbs() {
  thumbWorkers++;
  try {
    while (thumbQueue.length) {
      const p = thumbQueue.shift();
      if (p.thumb || p.thumbFail || p.thumbBusy || !state.photos.includes(p)) continue;
      p.thumbBusy = true;
      try { p.thumbBlob = await thumbBlob(p); p.thumb = URL.createObjectURL(p.thumbBlob); } catch { p.thumbFail = true; }
      p.thumbBusy = false;
      const tile = document.querySelector(`#groups .tile[data-id="${p.id}"]`);
      if (tile) fillTile(tile, p);
      await nextFrame();
    }
  } finally {
    thumbWorkers--;
  }
}

/* ───────── 거르는 조건 화면 ───────── */

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월~일

function saveSettings() {
  store.set(LS.settings, JSON.stringify(state.settings));
}

function renderFilters() {
  const s = state.settings;
  const days = $('days');
  days.textContent = '';
  for (const d of DAY_ORDER) {
    const b = el('button', 'day' + (s.days.includes(d) ? ' on' : ''), DOW_KO[d]);
    b.type = 'button';
    b.dataset.day = d;
    b.setAttribute('aria-pressed', s.days.includes(d));
    if (s.days.includes(d)) b.style.background = `var(--d${d})`;
    days.appendChild(b);
  }
  $('fromDate').value = s.from || '';
  $('toDate').value = s.to || '';
  $('buffer').value = s.buffer;
  const dayText = DAY_ORDER.filter(d => s.days.includes(d)).map(d => DOW_KO[d]).join('·') || '요일 없음';
  $('filterBrief').textContent = `${dayText} · ${s.from || '처음'}~${s.to || '끝'} · 여유 ${s.buffer}m`;
}

$('days').addEventListener('click', (e) => {
  const b = e.target.closest('.day');
  if (!b) return;
  const d = +b.dataset.day;
  const days = new Set(state.settings.days);
  days.has(d) ? days.delete(d) : days.add(d);
  state.settings.days = [...days];
  saveSettings();
  render();
});
$('fromDate').addEventListener('change', (e) => { state.settings.from = e.target.value; saveSettings(); render(); });
$('toDate').addEventListener('change', (e) => { state.settings.to = e.target.value; saveSettings(); render(); });
function setBuffer(v) {
  v = Math.round(Number(v));
  if (!isFinite(v)) v = DEFAULTS.buffer;
  state.settings.buffer = Math.max(0, Math.min(1000, v));
  saveSettings();
  render();
}
$('buffer').addEventListener('change', (e) => setBuffer(e.target.value));
document.querySelectorAll('.stepper button').forEach(b =>
  b.addEventListener('click', () => setBuffer(state.settings.buffer + Number(b.dataset.step))));
$('resetFilters').addEventListener('click', () => {
  state.settings = { ...DEFAULTS, days: [...DEFAULTS.days] };
  saveSettings();
  render();
});

/* ───────── 내 사진 목록 ───────── */

const TABS = [
  { key: 'in', cats: ['in', 'nodate'], label: '풍납동', hint: '풍납동에서 찍은 사진과 날짜를 모르는 사진이에요. 처음엔 모두 골라져 있어요. 빼고 싶은 사진의 ✓ 를 누르세요.' },
  { key: 'nogps', cats: ['nogps'], label: '위치 정보 없음', hint: '위치가 지워진 사진이에요. 교회에서 찍은 사진만 ＋ 를 눌러 넣어 주세요.' },
  { key: 'out', cats: ['out'], label: '다른 동네', hint: '풍납동 밖에서 찍힌 사진이에요. 교회 사진이 섞여 있으면 ＋ 를 눌러 넣으세요.' },
];
const tabCats = (key) => TABS.find(t => t.key === key).cats;

const pickedOf = (p) => VISIBLE.includes(p.cat) && isPicked(p.cat, state.overrides.get(p.id));

function render() {
  for (const p of state.photos) p.cat = classify(p, state.settings);
  const has = state.photos.length > 0 || state.failed.length > 0;
  $('summary').hidden = !has;
  $('listArea').hidden = !state.photos.length;
  $('clearBtn').hidden = !has;
  updateBars();
  renderFilters();
  if (has) renderSummary();
  if (!state.photos.length) { $('groups').textContent = ''; return; }
  renderTabs();
  renderGroups();
  updatePickedCount();
  queueThumbs();
}

function count(cat) { return state.photos.filter(p => p.cat === cat).length; }

function renderSummary() {
  const stats = $('stats');
  stats.textContent = '';
  const add = (n, label, cls, onClick) => {
    const b = el(onClick ? 'button' : 'div', 'stat' + (cls ? ' ' + cls : ''));
    if (onClick) { b.type = 'button'; b.addEventListener('click', onClick); }
    b.append(el('div', 'n', String(n)), el('div', 'l', label));
    stats.appendChild(b);
  };
  const goTab = (tab) => () => { state.tab = tab; render(); $('tabs').scrollIntoView({ behavior: 'smooth' }); };
  const recognized = state.photos.length + state.stats.dup;
  add(state.stats.selected, '선택');
  add(recognized, '인식', recognized === state.stats.selected ? 'good' : 'bad');
  add(count('in'), '풍납동', 'good', goTab('in'));
  add(count('nodate'), '날짜 없음', '', () => {
    state.tab = 'in'; render();
    document.querySelector('.group.nodate')?.scrollIntoView({ behavior: 'smooth' });
  });
  add(count('nogps'), '위치 없음', '', goTab('nogps'));
  add(count('out'), '다른 동네', '', goTab('out'));
  add(count('otherday'), '다른 요일');
  const range = count('range');
  if (range) add(range, '기간 밖');
  add(state.failed.length, '실패', state.failed.length ? 'bad' : '', state.failed.length ? () => { $('failBox').open = true; $('failBox').scrollIntoView({ behavior: 'smooth' }); } : null);

  // 실패 목록
  const fb = $('failBox');
  fb.hidden = !state.failed.length;
  $('failTitle').textContent = `불러오지 못한 사진 ${state.failed.length}장 (눌러서 보기)`;
  const ul = $('failList');
  ul.textContent = '';
  for (const f of state.failed) {
    const li = el('li');
    li.append(el('b', '', f.name), ` — ${f.reason}`);
    ul.appendChild(li);
  }

  // 위치가 지워진 것 같으면 알려 준다
  const dated = state.photos.filter(p => p.dt);
  const noGps = dated.filter(p => !p.gps).length;
  const warn = $('gpsWarn');
  if (dated.length >= 3 && noGps / dated.length >= 0.6) {
    warn.hidden = false;
    warn.textContent = '';
    warn.append(`날짜가 있는 사진 ${dated.length}장 중 ${noGps}장에 위치 정보가 없어요. 폰이 사진을 넘길 때 위치를 지웠을 수 있어요. `);
    const b = el('button', '', '위치 살리는 방법 보기');
    b.type = 'button';
    b.addEventListener('click', openHelp);
    warn.appendChild(b);
  } else {
    warn.hidden = true;
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  for (const t of TABS) {
    const n = state.photos.filter(p => t.cats.includes(p.cat)).length;
    const b = el('button', 'tab' + (state.tab === t.key ? ' on' : ''), `${t.label} ${n}`);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { state.tab = t.key; state.selecting = false; state.selected.clear(); render(); });
    tabs.appendChild(b);
  }
  $('tabHint').textContent = TABS.find(t => t.key === state.tab).hint;
}

// 날짜 없는 사진('')은 맨 아래로
function groupByDate(list, sortKeyOf) {
  const map = new Map();
  for (const p of list) {
    const d = p.dt ? p.dt.date : '';
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(p);
  }
  const out = [...map.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || a[0].localeCompare(b[0]));
  for (const [, l] of out) l.sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)));
  return out;
}
const sortKeyMine = (p) => (p.dt ? p.dt.sortKey : '') + p.name;

function groupSection(date, extraText) {
  const g = el('section', 'group' + (date ? '' : ' nodate'));
  const head = el('div', 'group-head');
  const title = el('div', 'group-title');
  if (date) {
    const { text, dow } = dateLabel(date);
    g.style.setProperty('--dc', `var(--d${dow})`);
    const [md, dw] = text.split(' (');
    title.append(`${md} `, el('span', 'dow', `(${dw}`), el('span', 'cnt', extraText));
  } else {
    title.append('날짜 없음', el('span', 'cnt', extraText));
  }
  g.dataset.date = date;
  head.appendChild(title);
  const grid = el('div', 'grid');
  g.append(head, grid);
  return { g, head, grid };
}

let viewList = []; // 크게 보기에서 앞뒤로 넘길 순서

function renderGroups() {
  const root = $('groups');
  root.textContent = '';
  const cats = tabCats(state.tab);
  const groups = groupByDate(state.photos.filter(p => cats.includes(p.cat)), sortKeyMine);
  viewList = groups.flatMap(([, list]) => list);
  if (!groups.length) {
    root.appendChild(el('div', 'empty card', state.tab === 'in' ? '풍납동에서 찍은 사진이 아직 없어요.' : '해당하는 사진이 없어요.'));
    return;
  }
  for (const [date, list] of groups) {
    const { g, head, grid } = groupSection(date, ` · ${list.length}장`);
    const allBtn = el('button', 'group-all');
    allBtn.type = 'button';
    head.appendChild(allBtn);
    if (!date && state.tab === 'in') g.appendChild(nodateTools(list));
    g.appendChild(grid); // 도구 아래로 격자 옮김
    for (const p of list) {
      const t = el('button', 'tile');
      t.type = 'button';
      t.dataset.id = p.id;
      fillTile(t, p);
      grid.appendChild(t);
    }
    root.appendChild(g);
    updateGroupButton(g);
  }
}

// '날짜 없음' 묶음: 여러 장 골라 날짜 정하기
function nodateTools(list) {
  const box = el('div', 'group-tools');
  const btn = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); box.appendChild(b); return b; };
  if (!state.selecting) {
    btn('여러 장 골라 날짜 정하기', '', () => { state.selecting = true; state.selected.clear(); renderGroups(); });
  } else {
    const n = [...state.selected].filter(id => list.some(p => p.id === id)).length;
    btn('모두 고르기', '', () => { list.forEach(p => state.selected.add(p.id)); renderGroups(); });
    btn(`고른 ${n}장 날짜 정하기`, 'primary', () => {
      const chosen = list.filter(p => state.selected.has(p.id));
      if (!chosen.length) { toast('날짜를 정할 사진을 먼저 눌러 고르세요.'); return; }
      askDate(chosen);
    });
    btn('그만 고르기', '', () => { state.selecting = false; state.selected.clear(); renderGroups(); });
  }
  return box;
}

function fillTile(t, p) {
  const picked = pickedOf(p);
  t.classList.toggle('picked', picked);
  t.classList.toggle('sel', state.selecting && state.selected.has(p.id));
  t.setAttribute('aria-label', `${p.dt ? hm(p.dt.hhmm) : '날짜 없는'} 사진, ${picked ? '고름' : '안 고름'}`);
  t.textContent = '';
  if (p.thumb) {
    const img = el('img');
    img.src = p.thumb;
    img.alt = '';
    t.appendChild(img);
  } else {
    t.appendChild(el('div', 'ph', p.thumbFail ? '미리보기 없음' : '…'));
  }
  if (p.dt) t.appendChild(el('span', 'time', p.dtSource === 'manual' ? '직접 정함' : hm(p.dt.hhmm)));
  if (!(state.selecting && !p.dt)) t.appendChild(el('span', 'badge', picked ? '✓' : '＋'));
}

function updateGroupButton(g) {
  const ids = [...g.querySelectorAll('.tile')].map(t => +t.dataset.id);
  const list = state.photos.filter(p => ids.includes(p.id));
  const n = list.filter(pickedOf).length;
  const btn = g.querySelector('.group-all');
  btn.textContent = n ? (g.dataset.date ? '이 날 모두 빼기' : '모두 빼기') : (g.dataset.date ? '이 날 모두 넣기' : '모두 넣기');
  btn.dataset.mode = n ? 'out' : 'in';
  g.querySelector('.cnt').textContent = n === list.length || n === 0
    ? ` · ${list.length}장${n ? '' : ' (안 고름)'}`
    : ` · ${n} / ${list.length}장 고름`;
}

function togglePhoto(p, value) {
  const v = value ?? !pickedOf(p);
  if (v === isPicked(p.cat, undefined)) state.overrides.delete(p.id); else state.overrides.set(p.id, v);
  const t = document.querySelector(`#groups .tile[data-id="${p.id}"]`);
  if (t) { fillTile(t, p); updateGroupButton(t.closest('.group')); }
  updatePickedCount();
}

$('groups').addEventListener('click', (e) => {
  const allBtn = e.target.closest('.group-all');
  if (allBtn) {
    const v = allBtn.dataset.mode === 'in';
    allBtn.closest('.group').querySelectorAll('.tile').forEach(t => togglePhoto(state.photos.find(p => p.id === +t.dataset.id), v));
    return;
  }
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const p = state.photos.find(x => x.id === +tile.dataset.id);
  if (!p) return;
  if (state.selecting && !p.dt) {
    state.selected.has(p.id) ? state.selected.delete(p.id) : state.selected.add(p.id);
    renderGroups();
    return;
  }
  if (e.target.closest('.badge')) togglePhoto(p);
  else openViewer(p, 'mine');
});

function pickedPhotos() { return state.photos.filter(pickedOf); }
function updatePickedCount() {
  const n = pickedPhotos().length;
  $('pickedCount').textContent = n;
  $('saveBtn').disabled = n === 0;
}

/* ───────── 날짜 직접 정하기 ───────── */

let dateTargets = [];
let lastManualDate = '';
function askDate(photos) {
  dateTargets = photos;
  $('dateDesc').textContent = photos.length > 1
    ? `고른 사진 ${photos.length}장에 같은 날짜를 정해요. 정하면 그 날짜 묶음으로 옮겨가요.`
    : '이 사진의 날짜를 정해요. 정하면 그 날짜 묶음으로 옮겨가요.';
  $('dateInput').value = (photos.length === 1 && photos[0].dtSource === 'manual' ? photos[0].dt.date : '') || lastManualDate;
  $('dateClear').hidden = !photos.some(p => p.dtSource === 'manual');
  $('dateDlg').returnValue = '';
  $('dateDlg').showModal();
}
$('dateDlg').addEventListener('close', () => {
  const v = $('dateDlg').returnValue;
  if (v === 'ok') {
    const d = $('dateInput').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    lastManualDate = d;
    const dt = parseExifDateTime(`${d.replace(/-/g, ':')} 00:00:00`);
    for (const p of dateTargets) { p.dt = { ...dt }; p.dtSource = 'manual'; }
    toast(`${dateTargets.length}장의 날짜를 ${dateLabel(d).text}로 정했어요.`);
  } else if (v === 'clear') {
    for (const p of dateTargets) if (p.dtSource === 'manual') { p.dt = null; p.dtSource = null; }
    toast('날짜를 지웠어요. 날짜 없음 묶음으로 돌아가요.');
  } else {
    return;
  }
  state.selecting = false;
  state.selected.clear();
  render();
  if (!$('viewer').hidden) {
    const p = dateTargets[0];
    vIndex = viewList.indexOf(p);
    if (vIndex < 0) closeViewer(); else showViewerPhoto();
  }
});

/* ───────── 모음함에 담기 ───────── */

// 같은 사진인지: 크기 + 내용 CRC (누가 담았든, 몇 번 받았든 한 장만 남긴다)
const contentKey = (size, crc) => `${size}-${crc.toString(16)}`;
const boxKeys = () => new Set(state.box.map(i => i.key));

async function fileCrc(blob) {
  return crc32(new Uint8Array(await blob.arrayBuffer()));
}

async function saveToBox(item) {
  const { file, ...rest } = item; // file 은 화면용 별칭이라 저장하지 않는다
  try {
    await boxPut(rest);
  } catch (err) {
    throw new Error(err && err.name === 'QuotaExceededError' ? 'QUOTA' : 'DB');
  }
  item.file = item.blob;
  state.box.push(item);
}

let boxBusy = false;
async function addPickedToBox() {
  if (boxBusy) return;
  if (!state.person) { toast('먼저 이름을 알려 주세요.'); askName(); return; }
  const photos = pickedPhotos().sort((a, b) => sortKeyMine(a).localeCompare(sortKeyMine(b)));
  if (!photos.length) return;
  boxBusy = true;
  $('saveBtn').disabled = true;
  await askPersist();
  const have = boxKeys();
  let added = 0, same = 0;
  try {
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      setProgress('progress', true, `모음함에 담는 중 ${i + 1} / ${photos.length}`, (i + 1) / photos.length);
      const crc = await fileCrc(p.file);
      const key = contentKey(p.file.size, crc);
      if (have.has(key)) { same++; continue; }
      have.add(key);
      await saveToBox({
        key, person: state.person, name: p.name, type: p.file.type || mimeOf(p.name), size: p.file.size, crc,
        dt: p.dt, dtSource: p.dtSource, blob: p.file, thumb: p.thumbBlob || null, addedAt: Date.now(), from: 'mine',
      });
      added++;
      if (i % 5 === 4) await nextFrame();
    }
    toast(`모음함에 ${added}장 담았어요.${same ? ` (이미 있던 ${same}장 제외)` : ''}`);
    setMode('box');
  } catch (err) {
    toast(err.message === 'QUOTA' ? `폰 저장 공간이 부족해요. ${added}장까지 담았어요.` : '모음함에 담지 못했어요. 다시 해 보세요.');
  } finally {
    setProgress('progress', false);
    boxBusy = false;
    state.prepared.clear();
    updatePickedCount();
    updateBoxCount();
  }
}
$('saveBtn').addEventListener('click', addPickedToBox);

/* ───────── 받은 파일 불러오기 (ZIP·사진) ───────── */

async function importReceived(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || boxBusy) return;
  boxBusy = true;
  await askPersist();
  const have = boxKeys();
  let added = 0, same = 0, skipped = 0, failed = 0;
  const jobs = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || /zip/i.test(f.type)) {
      try {
        for (const e of await readZipEntries(f)) {
          const base = e.path.split('/').pop();
          if (e.dir || e.encrypted || !isImageName(base) || base.startsWith('._') || e.path.includes('__MACOSX')) continue;
          jobs.push({ name: base, size: e.size, crc: e.crc, get: () => entryBlob(f, e, mimeOf(base)) });
        }
      } catch (err) {
        failed++;
        toast(err.message === 'ZIP64' ? `${f.name}: 너무 큰 ZIP이에요. 나눠서 받아 주세요.` : `${f.name}: ZIP을 열 수 없어요.`);
      }
    } else if (looksImage(f)) {
      jobs.push({ name: f.name, size: f.size, crc: null, get: async () => f });
    } else {
      skipped++;
    }
  }
  try {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      setProgress('boxProgress', true, `받은 사진 넣는 중 ${i + 1} / ${jobs.length}`, (i + 1) / jobs.length);
      try {
        if (j.crc != null && have.has(contentKey(j.size, j.crc))) { same++; continue; }
        const blob = await j.get();
        const crc = j.crc ?? await fileCrc(blob);
        const key = contentKey(blob.size, crc);
        if (have.has(key)) { same++; continue; }
        // 날짜·이름: 이 앱이 만든 파일 이름이면 거기서, 아니면 촬영 정보 → 파일 이름 순서
        const parsed = parseExportName(j.name);
        let dt = null, dtSource = null, person;
        if (parsed) {
          person = parsed.person;
          if (parsed.date) {
            dt = parseExifDateTime(`${parsed.date.replace(/-/g, ':')} ${parsed.hhmm.slice(0, 2)}:${parsed.hhmm.slice(2)}:00`);
            dtSource = 'name';
          }
        } else {
          ({ dt, source: dtSource } = findDate(await readMeta(blob), j.name));
          person = '이름모름';
        }
        const item = {
          key, person, name: j.name, type: blob.type || mimeOf(j.name), size: blob.size, crc, dt, dtSource, blob,
          thumb: null, addedAt: Date.now(), from: 'received',
        };
        try { item.thumb = await thumbBlob({ file: blob, name: j.name, type: item.type }); } catch { item.thumb = null; }
        await saveToBox(item);
        have.add(key);
        added++;
      } catch (err) {
        if (err.message === 'QUOTA') throw err;
        failed++;
      }
      await nextFrame();
    }
    const msg = [`받은 사진 ${added}장을 모음함에 넣었어요.`];
    if (same) msg.push(`이미 있던 ${same}장 제외.`);
    if (skipped) msg.push(`사진이 아닌 파일 ${skipped}개 건너뜀.`);
    if (failed) msg.push(`못 읽은 ${failed}개.`);
    toast(msg.join(' '));
  } catch {
    toast(`폰 저장 공간이 부족해요. ${added}장까지 넣었어요.`);
  } finally {
    setProgress('boxProgress', false);
    boxBusy = false;
    state.prepared.clear();
    renderBox();
  }
}
$('pickReceived').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  await importReceived(files);
});

/* ───────── 모음함 보기 ───────── */

const boxThumbUrls = new Map(); // key → blob URL
let boxViewList = [];

function boxThumbUrl(it) {
  if (!it.thumb) return null;
  if (!boxThumbUrls.has(it.key)) boxThumbUrls.set(it.key, URL.createObjectURL(it.thumb));
  return boxThumbUrls.get(it.key);
}

function shownBoxItems() {
  return state.box.filter(i => !state.boxFilter || i.person === state.boxFilter);
}

function updateBoxCount() {
  $('boxCount').textContent = state.box.length ? state.box.length : '';
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeNav button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('mineView').hidden = mode !== 'mine';
  $('boxView').hidden = mode !== 'box';
  updateBars();
  window.scrollTo(0, 0);
  if (mode === 'box') renderBox();
}
$('modeNav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

function updateBars() {
  $('savebar').hidden = state.mode !== 'mine' || !state.photos.length;
  $('boxbar').hidden = state.mode !== 'box' || !state.box.length;
}

const sortKeyBox = (i) => (i.dt ? i.dt.sortKey : '') + i.person + i.name;

function renderBox() {
  updateBoxCount();
  updateBars();
  const items = state.box;
  const people = new Map();
  for (const it of items) people.set(it.person, (people.get(it.person) || 0) + 1);
  if (state.boxFilter && !people.has(state.boxFilter)) state.boxFilter = '';
  const total = items.reduce((s, i) => s + i.size, 0);
  const dates = new Set(items.filter(i => i.dt).map(i => i.dt.date));
  const nodate = items.filter(i => !i.dt).length;
  $('boxTotal').textContent = items.length
    ? `${items.length}장 · ${dates.size}개 날짜${nodate ? ` + 날짜 없음 ${nodate}장` : ''} · ${people.size}명 · ${fmtSize(total)}`
    : '모음함이 비어 있어요';
  $('boxClear').hidden = !items.length;

  const chips = $('boxPeople');
  chips.textContent = '';
  if (people.size > 1) {
    const chip = (key, label) => {
      const b = el('button', state.boxFilter === key ? 'on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { state.boxFilter = key; renderBox(); });
      chips.appendChild(b);
    };
    chip('', `모두 ${items.length}`);
    for (const [name, n] of [...people.entries()].sort((a, b) => b[1] - a[1])) chip(name, `${name} ${n}`);
  }

  const shown = shownBoxItems();
  $('boxShown').textContent = shown.length;
  const groups = groupByDate(shown, sortKeyBox);
  boxViewList = groups.flatMap(([, l]) => l);
  const root = $('boxGroups');
  root.textContent = '';
  if (!groups.length) {
    root.appendChild(el('div', 'empty card',
      '아직 사진이 없어요. "내 사진 정리"에서 사진을 고른 뒤 "모음함에 담기"를 누르거나, 다른 임원에게 받은 ZIP을 불러오세요.'));
    return;
  }
  for (const [date, list] of groups) {
    const who = new Set(list.map(i => i.person)).size;
    const { g, grid } = groupSection(date, ` · ${list.length}장${people.size > 1 ? ` · ${who}명` : ''}`);
    for (const it of list) {
      const t = el('button', 'tile all-tile picked');
      t.type = 'button';
      t.dataset.key = it.key;
      const url = boxThumbUrl(it);
      if (url) { const img = el('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; t.appendChild(img); }
      else t.appendChild(el('div', 'ph', isHeic(it) ? 'HEIC' : '미리보기 없음'));
      if (people.size > 1) t.appendChild(el('span', 'who', it.person));
      if (it.dt) t.appendChild(el('span', 'time', it.dtSource === 'manual' ? '직접 정함' : hm(it.dt.hhmm)));
      grid.appendChild(t);
    }
    root.appendChild(g);
  }
}

$('boxGroups').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t) return;
  const it = boxViewList.find(i => i.key === t.dataset.key);
  if (it) openViewer(it, 'box');
});

async function removeFromBox(keys) {
  await boxDelete(keys);
  const set = new Set(keys);
  state.box = state.box.filter(i => !set.has(i.key));
  for (const k of keys) { const u = boxThumbUrls.get(k); if (u) URL.revokeObjectURL(u); boxThumbUrls.delete(k); }
  state.prepared.clear();
  renderBox();
}

$('boxClear').addEventListener('click', async () => {
  const who = state.boxFilter;
  const keys = shownBoxItems().map(i => i.key);
  if (!confirm(who ? `모음함에서 ${who}님 사진 ${keys.length}장을 모두 뺄까요?` : `모음함의 사진 ${keys.length}장을 모두 뺄까요?\n(폰 사진첩의 사진은 그대로예요)`)) return;
  if (who) await removeFromBox(keys);
  else { await boxClear(); for (const u of boxThumbUrls.values()) URL.revokeObjectURL(u); boxThumbUrls.clear(); state.box = []; state.prepared.clear(); renderBox(); }
});

/* ───────── 크게 보기 ───────── */
// vSource: 'mine' (내 사진 정리) / 'box' (모음함)
let vIndex = -1, vUrl = null, vToken = 0, vSource = 'mine';
const vList = () => (vSource === 'mine' ? viewList : boxViewList);

function setViewerImage(url, alt = '') {
  const img = $('vImg');
  if (url) img.src = url; else img.removeAttribute('src');
  img.alt = alt;
}

function dateLine(p) {
  if (!p.dt) return '날짜 없음';
  const { text } = dateLabel(p.dt.date);
  return p.dtSource === 'manual' ? text : `${text} ${hm(p.dt.hhmm)}`;
}

async function showViewerPhoto() {
  const list = vList();
  const p = list[vIndex];
  if (!p) return closeViewer();
  const token = ++vToken;
  $('vPrev').hidden = vIndex <= 0;
  $('vNext').hidden = vIndex >= list.length - 1;
  if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
  const info = $('vInfo');
  info.textContent = '';
  const src = p.dtSource ? `날짜: ${SRC_LABEL[p.dtSource]}에서` : '날짜를 못 찾음';
  const b = $('vToggle');
  b.hidden = false;
  if (vSource === 'box') {
    info.append(`${dateLine(p)} · ${vIndex + 1}/${list.length}`, el('small', '', `${p.person} · ${src} · ${p.name}`));
    b.textContent = '모음함에서 빼기';
    b.classList.remove('add');
    b.classList.add('danger');
    $('vDate').hidden = true;
    setViewerImage(boxThumbUrl(p), '불러오는 중…');
  } else {
    const where = p.gps ? (p.dist === 0 ? p.area : `${p.area} 경계에서 ${Math.round(p.dist)}m 밖`) : '위치 정보 없음';
    info.append(`${dateLine(p)} · ${vIndex + 1}/${list.length}`, el('small', '', `${src} · ${where} · ${p.name}`));
    b.classList.remove('danger');
    updateViewerToggle(p);
    const canDate = !p.dt || p.dtSource === 'manual';
    $('vDate').hidden = !canDate;
    $('vDate').textContent = p.dt ? '날짜 바꾸기' : '날짜 정하기';
    setViewerImage(p.thumb, '불러오는 중…');
  }
  try {
    const r = await openImage(p);
    if (token !== vToken) { URL.revokeObjectURL(r.url); return; }
    vUrl = r.url;
    setViewerImage(r.url);
  } catch {
    if (token === vToken && !$('vImg').getAttribute('src')) setViewerImage(null, '이 사진은 이 폰에서 크게 볼 수 없어요 (저장은 됩니다)');
  }
}

function updateViewerToggle(p) {
  const b = $('vToggle');
  const picked = pickedOf(p);
  b.textContent = picked ? '✓ 골랐어요 · 눌러서 빼기' : '＋ 넣기';
  b.classList.toggle('add', !picked);
}

function openViewer(p, source) {
  vSource = source;
  vIndex = vList().indexOf(p);
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  showViewerPhoto();
}
function closeViewer() {
  $('viewer').hidden = true;
  document.body.style.overflow = '';
  vToken++;
  if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
  setViewerImage(null);
  for (const p of state.photos) p.converted = null;
  for (const p of state.box) p.converted = null;
}
$('vClose').addEventListener('click', closeViewer);
$('vPrev').addEventListener('click', () => { if (vIndex > 0) { vIndex--; showViewerPhoto(); } });
$('vNext').addEventListener('click', () => { if (vIndex < vList().length - 1) { vIndex++; showViewerPhoto(); } });
$('vDate').addEventListener('click', () => { const p = vList()[vIndex]; if (p) askDate([p]); });
$('vToggle').addEventListener('click', async () => {
  const p = vList()[vIndex];
  if (!p) return;
  if (vSource === 'box') {
    if (!confirm('이 사진을 모음함에서 뺄까요? (폰 사진첩의 사진은 그대로예요)')) return;
    await removeFromBox([p.key]);
    if (!boxViewList.length) { closeViewer(); return; }
    vIndex = Math.min(vIndex, boxViewList.length - 1);
    showViewerPhoto();
    return;
  }
  togglePhoto(p);
  updateViewerToggle(p);
});
// 옆으로 밀어서 넘기기
let touchX = null;
$('viewer').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('viewer').addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 60) return;
  if (dx < 0) $('vNext').click(); else $('vPrev').click();
});
document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') $('vPrev').click();
  if (e.key === 'ArrowRight') $('vNext').click();
});

/* ───────── 보내기 · 저장 (카톡·메일·파일) ───────── */

const canShareFiles = (() => {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.zip', { type: 'application/zip' })] }));
  } catch { return false; }
})();

const SPLITS = {
  one: { note: '전부 ZIP 파일 하나로 묶어요. 파일이 크면 카톡·메일로 안 갈 수 있어요.' },
  month: { note: '한 달마다 ZIP 파일을 하나씩 만들어요. 안은 날짜 폴더로 나뉘어요. (날짜 없는 사진은 따로 하나)' },
  mail: { limit: 20e6, note: '메일 첨부 한도에 맞게 20MB씩 나눠요. 하나씩 차례로 보내 주세요.' },
  big: { limit: 200e6, note: '카톡 파일 보내기에 맞게 200MB씩 나눠요. 하나씩 차례로 보내 주세요.' },
};
let splitMode = 'one';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 사람마다 날짜·시간 순서로 번호를 다시 매긴다 (여러 번 받아 합쳐도 이름이 겹치지 않게)
// 날짜 없는 사진(날짜없음 폴더)은 맨 뒤
function exportEntries(items) {
  const byPerson = new Map();
  for (const it of items) {
    if (!byPerson.has(it.person)) byPerson.set(it.person, []);
    byPerson.get(it.person).push(it);
  }
  const out = [];
  for (const [person, list] of byPerson) {
    const names = buildExportNames(list, person);
    for (const it of list) out.push({ it, ...names.get(it) });
  }
  const fk = (e) => (e.it.dt ? '0' + e.folder : '1');
  return out.sort((a, b) => fk(a).localeCompare(fk(b)) || sortKeyBox(a.it).localeCompare(sortKeyBox(b.it)) || a.filename.localeCompare(b.filename));
}

// 2026-03 / 날짜 없는 사진은 '날짜없음'
const monthKey = (e) => (e.it.dt ? e.it.dt.date.slice(0, 7) : '날짜없음');
function monthText(e) {
  if (!e.it.dt) return '날짜 없음';
  const [y, m] = e.it.dt.date.split('-').map(Number);
  return `${y}년 ${m}월`;
}

function makeParts(items) {
  const entries = exportEntries(items);
  const parts = [];
  if (splitMode === 'one') parts.push(entries);
  else if (splitMode === 'month') {
    for (const e of entries) {
      const last = parts[parts.length - 1];
      if (last && monthKey(last[0]) === monthKey(e)) last.push(e); else parts.push([e]);
    }
  } else {
    const limit = SPLITS[splitMode].limit;
    let cur = [], size = 0;
    for (const e of entries) {
      if (cur.length && size + e.it.size > limit) { parts.push(cur); cur = []; size = 0; }
      cur.push(e); size += e.it.size;
    }
    if (cur.length) parts.push(cur);
  }
  const persons = new Set(items.map(i => i.person));
  const who = persons.size === 1 ? safeName([...persons][0]) : '모음';
  const lbl = (e) => (e.it.dt ? dateLabel(e.it.dt.date).text : '날짜 없음');
  return parts.map((list, i) => {
    const size = list.reduce((s, e) => s + e.it.size, 0);
    const first = lbl(list[0]), last = lbl(list[list.length - 1]);
    let range = first === last ? first : `${first} ~ ${last}`;
    if (splitMode === 'month') {
      const days = new Set(list.filter(e => e.it.dt).map(e => e.it.dt.date)).size;
      range = list[0].it.dt ? `${monthText(list[0])} · ${days}일` : '날짜 없음';
    }
    const suffix = splitMode === 'month' && parts.length > 1 ? `_${monthKey(list[0])}`
      : parts.length > 1 ? `_${i + 1}of${parts.length}` : '';
    return {
      key: `${splitMode}|${state.boxFilter}|${i}|${list.map(e => e.it.key).join(',')}`,
      fileName: `청년회의밤_${who}_${todayStr()}${suffix}.zip`,
      list, size, range, label: parts.length > 1 ? `${i + 1}/${parts.length}` : '전체',
    };
  });
}

let sending = false;
async function prepareZip(part) {
  if (state.prepared.has(part.key)) return state.prepared.get(part.key);
  setProgress('sendProgress', true, `ZIP 만드는 중 0 / ${part.list.length}`, 0);
  let last = 0;
  const blob = await makeZip(
    part.list.map(e => ({ path: `${e.folder}/${e.filename}`, blob: e.it.blob, dt: e.it.dt })),
    async (done, total) => {
      const now = performance.now();
      if (now - last > 120 || done === total) {
        last = now;
        setProgress('sendProgress', true, `ZIP 만드는 중 ${done} / ${total}`, done / total);
        await nextFrame();
      }
    },
  );
  const file = new File([blob], part.fileName, { type: 'application/zip' });
  state.prepared.set(part.key, file);
  setProgress('sendProgress', true, `준비됨 · ${part.fileName} (${fmtSize(file.size)})`, 1);
  return file;
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function sendPart(part, mode, btn) {
  if (sending) return;
  sending = true;
  try {
    const file = await prepareZip(part);
    if (mode === 'save') {
      download(file);
      btn.classList.add('done');
      toast('저장을 시작했어요. 아이폰은 "파일" 앱 → 다운로드 폴더를 보세요.');
      return;
    }
    try {
      await navigator.share({ files: [file], title: file.name });
      btn.classList.add('done');
      btn.textContent = '보냄 ✓';
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotAllowedError') {
        // ZIP 을 만드는 동안 시간이 지나 폰이 공유를 막은 경우: 한 번 더 누르면 바로 열린다
        btn.textContent = '준비됨 · 다시 누르기';
        toast('준비됐어요. 한 번 더 누르면 카톡·메일 고르는 창이 열려요.');
        return;
      }
      toast('보내지 못했어요. 더 작게 나눠서 해 보세요.');
    }
  } catch (err) {
    console.error(err);
    setProgress('sendProgress', false);
    toast(err && err.message === 'ZIP_TOO_BIG' ? '너무 커서 ZIP 하나로 못 만들어요(4GB 넘음). 나눠서 해 주세요.' : 'ZIP을 만들지 못했어요. 나눠서 다시 해 보세요.');
  } finally {
    sending = false;
  }
}

function renderParts() {
  document.querySelectorAll('#splitOpts button').forEach(b => b.classList.toggle('on', b.dataset.split === splitMode));
  $('splitNote').textContent = SPLITS[splitMode].note;
  const box = $('parts');
  box.textContent = '';
  for (const part of makeParts(shownBoxItems())) {
    const row = el('div', 'pd-row');
    row.style.setProperty('--dc', 'var(--primary)');
    const label = el('div', 'pd-label', `${part.label} `);
    label.append(el('small', '', `${part.range} · ${part.list.length}장 · ${fmtSize(part.size)}`));
    row.appendChild(label);
    if (canShareFiles) {
      const go = el('button', 'go', '보내기');
      go.type = 'button';
      go.addEventListener('click', () => sendPart(part, 'share', go));
      row.appendChild(go);
    }
    const sv = el('button', '', '저장');
    sv.type = 'button';
    sv.addEventListener('click', () => sendPart(part, 'save', sv));
    row.appendChild(sv);
    box.appendChild(row);
  }
}

$('splitOpts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-split]');
  if (!b) return;
  splitMode = b.dataset.split;
  setProgress('sendProgress', false);
  renderParts();
});

$('sendBtn').addEventListener('click', () => {
  const items = shownBoxItems();
  if (!items.length) return;
  const total = items.reduce((s, i) => s + i.size, 0);
  const who = state.boxFilter ? `${state.boxFilter}님 사진 ` : '';
  $('sendSummary').textContent = `${who}${items.length}장 · 약 ${fmtSize(total)} · 원본 화질 그대로, 날짜 폴더로 묶어요.`
    + (canShareFiles ? ' "보내기"를 누르면 카톡·메일 등을 고를 수 있어요.' : ' 이 기기는 바로 보내기가 안 돼서 "저장" 후 보내 주세요.');
  if (splitMode === 'one' && total > SPLITS.big.limit) splitMode = 'big';
  setProgress('sendProgress', false);
  renderParts();
  $('sendDlg').showModal();
});

/* ───────── 도움말 ───────── */

const HELP_HTML = `
<h2>쓰는 방법</h2>
<ol>
  <li><b>사진 고르기</b>를 누르고 올해 사진을 한꺼번에 고르세요. 수백 장도 괜찮고, 여러 번 나눠 골라도 이어서 쌓여요.</li>
  <li>다 불러오면 <b>"선택한 사진 N장 중 N장 인식"</b>이 나와요. 숫자가 다르면 아래 실패 목록에서 이유를 볼 수 있어요.</li>
  <li>풍납동에서 수·토·일에 찍은 사진이 <b>날짜별로</b> 모여요. 날짜를 모르는 사진(카톡으로 받은 사진, 스크린샷 등)은 맨 아래 <b>날짜 없음</b>에 모여요.</li>
  <li>사진을 누르면 크게 보여요. 오른쪽 위 <b>✓</b> 를 누르면 빠지고, <b>＋</b> 를 누르면 다시 들어가요.</li>
  <li><b>날짜 없음</b> 사진은 크게 보기에서 <b>날짜 정하기</b>를 누르거나, <b>여러 장 골라 날짜 정하기</b>로 한꺼번에 날짜를 정할 수 있어요. 안 정해도 그대로 저장돼요.</li>
  <li><b>위치 정보 없음</b> 칸도 꼭 보고, 교회 사진은 ＋ 로 넣어 주세요.</li>
  <li>아래 <b>모음함에 담기</b>를 누르면 고른 사진이 이 앱의 <b>모음함</b>에 모여요.</li>
</ol>

<h3>날짜는 어디서 찾나요?</h3>
<p>① 사진 속 촬영 정보 → ② 파일 이름(예: KakaoTalk_20260318_…, Screenshot_2026-03-18-…) 순서로 찾아요. 크게 보기에서 어디서 찾았는지 작게 보여요. 파일을 고른 시각은 날짜로 쓰지 않아요.</p>

<h3>모음함 · 보내기</h3>
<ul>
  <li><b>임원</b>: 모음함에서 <b>보내기 · 저장 → 보내기</b>를 누르고 카톡이나 메일을 고르세요. 영상 만드는 사람에게 ZIP 파일로 보내져요.</li>
  <li><b>영상 만드는 사람</b>: 받은 ZIP을 폰에 저장한 뒤(카톡은 파일을 눌러 저장), 모음함의 <b>받은 파일 불러오기</b>로 넣으세요. 모든 임원의 사진이 날짜별로 합쳐지고, 누가 찍었는지도 표시돼요.</li>
  <li>같은 사진은 몇 번을 받아도 한 장만 남아요.</li>
  <li>메일은 첨부 크기 한도가 있어서 <b>메일용(20MB씩)</b>으로 나눠 보내세요. 카톡은 <b>카톡용(200MB씩)</b>을 쓰세요.</li>
  <li>모음함은 이 폰 안에만 저장돼요. 앱을 지우거나 브라우저 데이터를 지우면 사라지니, 다 모은 뒤에는 <b>저장</b>으로 ZIP을 꼭 받아 두세요.</li>
</ul>

<h3>위치 정보가 지워지지 않게 고르는 법</h3>
<p>폰이 사진을 넘겨줄 때 위치를 지우는 경우가 많아요. 사진을 불러온 뒤 맨 위 숫자에서 <b>위치 없음</b>이 많으면 아래 방법을 써 보세요.</p>
<div class="tip">
  <p><b>아이폰</b></p>
  <ul>
    <li>사진 고르는 화면 위쪽의 <b>옵션</b>을 눌러 <b>위치</b>(위치 포함)를 켠 뒤 고르세요.</li>
    <li>그래도 안 되면 사진 앱에서 사진을 골라 <b>공유 → 파일에 저장</b>한 다음, 이 앱에서 <b>파일에서 고르기 → 파일 선택</b>으로 그 폴더의 사진을 고르세요.</li>
  </ul>
</div>
<div class="tip">
  <p><b>안드로이드</b></p>
  <ul>
    <li><b>파일에서 고르기</b>를 누르고, 사진 목록이 아닌 <b>내 파일 / 기기 저장공간 → DCIM → Camera</b> 폴더에서 고르세요.</li>
  </ul>
</div>
<p>방법을 바꿔 다시 불러오면 맨 위 <b>위치 없음</b> 숫자가 줄었는지로 바로 확인할 수 있어요. 위치가 끝내 안 살아나도 <b>위치 정보 없음</b> 칸에서 직접 골라 넣으면 됩니다.</p>

<h3>컴퓨터에서 쓸 때</h3>
<p>사진이나 폴더를 화면에 <b>끌어다 놓거나</b>, <b>폴더째 고르기</b>를 쓰면 돼요.</p>

<h3>개인정보</h3>
<p>사진을 고르고 모으는 일은 <b>이 폰 안에서만</b> 해요. 서버에 올리지 않아요. 풍납동 경계도 앱 안에 들어 있어서 인터넷 지도에 묻지 않아요. 사진은 내가 <b>보내기</b>를 눌러 고른 곳(카톡·메일 등)으로만 나가요.</p>

<h3>홈 화면에 추가</h3>
<ul>
  <li><b>아이폰 사파리</b>: 아래 가운데 공유 버튼 → <b>홈 화면에 추가</b></li>
  <li><b>안드로이드 크롬</b>: 오른쪽 위 ⋮ → <b>홈 화면에 추가</b> (또는 앱 설치)</li>
</ul>
`;
function openHelp() {
  $('helpBody').innerHTML = HELP_HTML;
  if (!$('helpDlg').open) $('helpDlg').showModal();
}
$('helpBtn').addEventListener('click', openHelp);

/* ───────── 알림 ───────── */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  // 창이 열려 있으면 창 안에 띄워야 보인다
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ───────── 시작 ───────── */

document.body.classList.add('has-modes');
updateNameBtn();
render();
if (!state.person) askName();

boxAll().then(items => {
  for (const it of items) it.file = it.blob;
  state.box = items;
  updateBoxCount();
  if (state.mode === 'box') renderBox();
}).catch(() => toast('이 브라우저에서는 모음함을 쓸 수 없어요. (사생활 보호 모드라면 꺼 주세요)'));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 테스트용
window.__app = { state, render, addFiles };
