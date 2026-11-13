// 모음함: 폰 안(IndexedDB)에 사진 원본을 모아 두고, 받은 ZIP 을 풀어 합친다.
// 어디로도 보내지 않는다. 밖으로 나가는 건 사용자가 '보내기/저장'을 누를 때뿐.

const DB_NAME = 'cyn-box';
const STORE = 'items';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(st)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const boxAll = () => tx('readonly', st => reqP(st.getAll()));
// item: { key, person, name, type, size, crc, dt, blob, thumb, addedAt, from }
export const boxPut = (item) => tx('readwrite', st => { st.put(item); });
export const boxDelete = (keys) => tx('readwrite', st => { for (const k of keys) st.delete(k); });
export const boxClear = () => tx('readwrite', st => { st.clear(); });

export async function askPersist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* 무시 */ }
}

/* ───────── 내보낸 파일 이름 읽기 ───────── */
// 2026-03-18_수_1930_김민지_001.jpg → { date, hhmm, person, n, ext }
const NAME_RE = /^(\d{4}-\d{2}-\d{2})_[일월화수목금토]_(\d{4})_(.+)_(\d{3,})\.([A-Za-z0-9]{2,5})$/;
// 날짜없음_김민지_001.jpg → { date: null, person, n, ext }
const NODATE_RE = /^날짜없음_(.+)_(\d{3,})\.([A-Za-z0-9]{2,5})$/;
export function parseExportName(path) {
  const base = String(path).split('/').pop();
  const nd = base.match(NODATE_RE);
  if (nd) return { date: null, hhmm: null, person: nd[1], n: Number(nd[2]), ext: nd[3].toLowerCase(), base };
  const m = base.match(NAME_RE);
  if (!m) return null;
  return { date: m[1], hhmm: m[2], person: m[3], n: Number(m[4]), ext: m[5].toLowerCase(), base };
}

/* ───────── ZIP 읽기 ─────────
 * 파일 전체를 메모리에 올리지 않고, 목록(끝부분)만 읽은 뒤 각 사진을 잘라서(slice) 꺼낸다.
 * 압축 안 함(이 앱이 만든 ZIP)과 일반 압축(deflate) 둘 다 읽는다.
 */
export async function readZipEntries(file) {
  const tailLen = Math.min(file.size, 65557);
  const tailStart = file.size - tailLen;
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('NOT_ZIP');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64');
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let euckr = null;
  try { euckr = new TextDecoder('euc-kr'); } catch { euckr = null; }
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const compSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const xlen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen);
    let path;
    try { path = utf8.decode(nameBytes); } catch { path = euckr ? euckr.decode(nameBytes) : new TextDecoder().decode(nameBytes); }
    entries.push({ path, method, crc, compSize, size, localOffset, encrypted: !!(flags & 1), dir: path.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export async function entryBlob(file, e, type = '') {
  const lh = new DataView(await file.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('BAD_ENTRY');
  const start = e.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = file.slice(start, start + e.compSize, type);
  if (e.method === 0) return raw;
  if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
    const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    return out.slice(0, out.size, type);
  }
  throw new Error('UNSUPPORTED');
}
