// 화면과 상관없는 계산들 (날짜·요일, 풍납동 경계 판정, 분류, 파일 이름, ZIP 만들기)
// 브라우저와 node 테스트에서 함께 쓴다.

import { PUNGNAP_AREAS } from './pungnap.js';

export const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

/* ───────── 날짜·요일 ───────── */

// EXIF 시각 문자열 "2026:03:18 19:30:05" 을 그대로 쪼갠다. 시간대 변환을 하지 않는다.
export function parseExifDateTime(value) {
  if (value == null) return null;
  let s = value;
  if (value instanceof Date) {
    // reviveValues:false 로 읽으므로 보통 여기 오지 않지만, 혹시 오면 기기 현지 시각으로 읽는다
    if (isNaN(value)) return null;
    s = `${value.getFullYear()}:${value.getMonth() + 1}:${value.getDate()} ${value.getHours()}:${value.getMinutes()}:${value.getSeconds()}`;
  }
  s = String(s).trim();
  const m = s.match(/^(\d{4})[:\-\/.](\d{1,2})[:\-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, se = m[6] ? +m[6] : 0;
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 요일: 날짜 숫자만으로 계산 (UTC 기준 달력 계산이라 시간대 영향 없음)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return {
    y, mo, d, h, mi, se, dow,
    date: `${y}-${pad(mo)}-${pad(d)}`,      // 2026-03-18
    hhmm: `${pad(h)}${pad(mi)}`,             // 1930
    sortKey: `${y}${pad(mo)}${pad(d)}${pad(h)}${pad(mi)}${pad(se)}`,
  };
}

export function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { text: `${m}월 ${d}일 (${DOW_KO[dow]})`, dow };
}

/* ───────── GPS ───────── */

function dmsToDeg(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const [d = 0, m = 0, s = 0] = Array.from(v).map(Number);
    return d + m / 60 + s / 3600;
  }
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// exifr 결과에서 위도·경도를 꺼낸다. 없거나 엉터리면 null
export function extractGps(meta) {
  if (!meta) return null;
  let lat = null, lon = null;
  if (meta.GPSLatitude != null && meta.GPSLongitude != null) {
    lat = dmsToDeg(meta.GPSLatitude);
    lon = dmsToDeg(meta.GPSLongitude);
    if (lat != null && /S/i.test(String(meta.GPSLatitudeRef || ''))) lat = -Math.abs(lat);
    if (lon != null && /W/i.test(String(meta.GPSLongitudeRef || ''))) lon = -Math.abs(lon);
  } else if (typeof meta.latitude === 'number' && typeof meta.longitude === 'number') {
    lat = meta.latitude; lon = meta.longitude;
  }
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null; // 0,0 은 위치 없음으로 본다
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function pickDateTime(meta) {
  if (!meta) return null;
  return parseExifDateTime(meta.DateTimeOriginal)
    || parseExifDateTime(meta.CreateDate)
    || parseExifDateTime(meta.DateTimeDigitized)
    || parseExifDateTime(meta.DateTime)
    || parseExifDateTime(meta.ModifyDate);
}

/* ───────── 풍납동 경계 판정 ───────── */

// 풍납동 근처에서 위도·경도를 미터 평면으로 바꾼다 (수백 m~수 km 범위에서 오차 1% 미만)
const LAT0 = 37.533, LON0 = 127.112;
const MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const MY = 110574;
const toXY = (lon, lat) => [(lon - LON0) * MX, (lat - LAT0) * MY];

const AREAS_XY = PUNGNAP_AREAS.map(a => ({
  name: a.name,
  rings: a.rings.map(r => r.map(([lon, lat]) => toXY(lon, lat))),
}));

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

// 결과: { inside: '풍납1동' | null, distance: 경계까지 m (안이면 0) }
export function locate(lat, lon) {
  const [x, y] = toXY(lon, lat);
  let best = Infinity, bestName = null;
  for (const a of AREAS_XY) {
    // rings[0] = 바깥 경계, 나머지 = 구멍 (현재 데이터엔 없음)
    const [outer, ...holes] = a.rings;
    if (pointInRing(x, y, outer) && !holes.some(h => pointInRing(x, y, h))) {
      return { inside: a.name, nearest: a.name, distance: 0 };
    }
    for (const ring of a.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = distToSegment(x, y, ring[j], ring[i]);
        if (d < best) { best = d; bestName = a.name; }
      }
    }
  }
  return { inside: null, nearest: bestName, distance: best };
}

export function isInPungnap(lat, lon, bufferM = 0) {
  return locate(lat, lon).distance <= bufferM;
}

/* ───────── 분류 ───────── */

// 각 사진을 한 칸에 넣는다.
// 'nodate' 날짜 없음 → 'range' 기간 밖 → 'otherday' 다른 요일 → 'nogps' 위치 없음 → 'in' 풍납동 / 'out' 다른 동네
export function classify(photo, settings) {
  if (!photo.dt) return 'nodate';
  const { date, dow } = photo.dt;
  if ((settings.from && date < settings.from) || (settings.to && date > settings.to)) return 'range';
  if (!settings.days.includes(dow)) return 'otherday';
  if (!photo.gps) return 'nogps';
  const dist = photo.dist ?? locate(photo.gps.lat, photo.gps.lon).distance;
  return dist <= settings.buffer ? 'in' : 'out';
}

// 기본으로 고른 상태인가: 풍납동 사진은 기본 포함, 나머지는 사용자가 직접 넣어야 포함
export function isPicked(cat, override) {
  if (override === true || override === false) return override;
  return cat === 'in';
}

/* ───────── 파일 이름 ───────── */

export function safeName(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '').slice(0, 20) || '이름없음';
}

export function extOf(filename, mime) {
  const m = String(filename || '').match(/\.([A-Za-z0-9]{2,5})$/);
  if (m) {
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  }
  if (/heic|heif/i.test(mime || '')) return 'heic';
  if (/png/i.test(mime || '')) return 'png';
  return 'jpg';
}

export function folderName(dateStr) {
  const { dow } = dateLabel(dateStr);
  return `${dateStr}_${DOW_KO[dow]}`;
}

// 날짜별로 시간 순서대로 번호를 매겨 이름을 만든다
// photos: [{ dt, name, type, ... }] (같은 날짜든 아니든 상관없음)
// 결과: Map(photo → { folder, filename })
export function buildExportNames(photos, person) {
  const who = safeName(person);
  const byDate = new Map();
  for (const p of photos) {
    if (!byDate.has(p.dt.date)) byDate.set(p.dt.date, []);
    byDate.get(p.dt.date).push(p);
  }
  const out = new Map();
  for (const [date, list] of byDate) {
    list.sort((a, b) => a.dt.sortKey.localeCompare(b.dt.sortKey) || String(a.name).localeCompare(String(b.name)));
    const folder = folderName(date);
    list.forEach((p, i) => {
      const n = String(i + 1).padStart(3, '0');
      out.set(p, { folder, filename: `${folder}_${p.dt.hhmm}_${who}_${n}.${extOf(p.name, p.type)}` });
    });
  }
  return out;
}

/* ───────── ZIP (압축 없이 원본 그대로 담기) ─────────
 * 사진 파일 내용을 메모리에 쌓아두지 않는다.
 * CRC 계산 때 한 장씩 읽고 버리며, 최종 Blob 은 원본 File 을 그대로 이어 붙인다.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosTime(dt) {
  const t = ((dt?.h || 0) << 11) | ((dt?.mi || 0) << 5) | ((dt?.se || 0) >> 1);
  const d = (((dt?.y || 2026) - 1980) << 9) | ((dt?.mo || 1) << 5) | (dt?.d || 1);
  return [t & 0xffff, d & 0xffff];
}

// entries: [{ path: '2026-03-18_수/파일.jpg', blob: File|Blob, dt }]
// onProgress(done, total)
export async function makeZip(entries, onProgress, BlobCtor = Blob) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const total = entries.length;
  const MAX = 0xffffffff;
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    const nameBytes = enc.encode(e.path);
    const data = new Uint8Array(await e.blob.arrayBuffer());
    const crc = crc32(data);
    const size = data.length;
    if (offset + size + 30 + nameBytes.length + 9 + nameBytes.length > MAX) throw new Error('ZIP_TOO_BIG');
    const [time, date] = dosTime(e.dt);
    // Info-ZIP 유니코드 경로 정보 (UTF-8 표시를 모르는 옛 프로그램용)
    const extra = new DataView(new ArrayBuffer(9 + nameBytes.length));
    extra.setUint16(0, 0x7075, true);
    extra.setUint16(2, 5 + nameBytes.length, true);
    extra.setUint8(4, 1);
    extra.setUint32(5, crc32(nameBytes), true);
    new Uint8Array(extra.buffer, 9).set(nameBytes);
    const exLen = extra.byteLength;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // 파일 이름 UTF-8 (한글 깨짐 방지)
    lh.setUint16(8, 0, true);      // 압축 안 함
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, exLen, true);
    parts.push(lh.buffer, nameBytes, extra.buffer, e.blob);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, exLen, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes, extra.buffer);

    offset += 30 + nameBytes.length + exLen + size;
    if (onProgress) await onProgress(i + 1, total);
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, total, true);
  end.setUint16(10, total, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new BlobCtor([...parts, ...central, end.buffer], { type: 'application/zip' });
}
