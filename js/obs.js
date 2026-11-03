import { t } from './i18n.js';
// Минимальный клиент obs-websocket v5 (без зависимостей)
// crypto.subtle есть только в безопасном контексте (https/localhost).
// Пад открывается по http с другого устройства, поэтому нужен запасной SHA-256 на чистом JS.
function sha256js(bytes) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = bytes.length, n = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
  m.set(bytes); m[len] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(n - 4, len * 8); dv.setUint32(n - 8, Math.floor(len / 0x20000000));
  const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i-15], 7) ^ r(w[i-15], 18) ^ (w[i-15] >>> 3), s1 = r(w[i-2], 17) ^ r(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32), od = new DataView(out.buffer);
  H.forEach((v, i) => od.setUint32(i * 4, v >>> 0));
  return out;
}
async function sha256b64(s) {
  const bytes = new TextEncoder().encode(s);
  const d = globalThis.crypto && crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256js(bytes);
  return btoa(String.fromCharCode(...d));
}
export { sha256js };
export class ObsClient extends EventTarget {
  constructor() { super(); this.ws = null; this.pending = new Map(); this.seq = 0; this.identified = false; this.wantConnect = false; this.retry = null; }
  connect(host, port, password) {
    this.cfg = { host, port, password }; this.wantConnect = true; this._open();
  }
  disconnect() { this.wantConnect = false; clearTimeout(this.retry); if (this.ws) this.ws.close(); }
  _status(s, detail) { this.status = s; this.dispatchEvent(new CustomEvent('status', { detail: { status: s, detail } })); }
  _open() {
    clearTimeout(this.retry);
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch {} }
    this._status('connecting');
    let ws;
    try { ws = new WebSocket(`ws://${this.cfg.host}:${this.cfg.port}`); } catch (e) { this._status('error', String(e)); return this._schedule(); }
    this.ws = ws; this.identified = false;
    ws.onmessage = (m) => this._onMsg(JSON.parse(m.data));
    ws.onclose = (e) => {
      this.identified = false;
      for (const p of this.pending.values()) p.reject(new Error(t('err.connClosed')));
      this.pending.clear();
      this._status('disconnected', e.reason || '');
      this._schedule();
    };
    ws.onerror = () => {};
  }
  _schedule() { if (this.wantConnect) this.retry = setTimeout(() => this._open(), 3000); }
  async _onMsg(msg) {
    const { op, d } = msg;
    if (op === 0) { // Hello
      const ident = { rpcVersion: 1, eventSubscriptions: (1 << 11) - 1 }; // All (без high-volume)
      if (d.authentication) {
        const secret = await sha256b64((this.cfg.password || '') + d.authentication.salt);
        ident.authentication = await sha256b64(secret + d.authentication.challenge);
      }
      this.ws.send(JSON.stringify({ op: 1, d: ident }));
    } else if (op === 2) { this.identified = true; this._status('connected'); }
    else if (op === 5) { this.dispatchEvent(new CustomEvent('event', { detail: d })); this.dispatchEvent(new CustomEvent(d.eventType, { detail: d.eventData || {} })); }
    else if (op === 7) {
      const p = this.pending.get(d.requestId); if (!p) return; this.pending.delete(d.requestId);
      if (d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error(`${d.requestType}: ${d.requestStatus.comment || d.requestStatus.code}`));
    }
  }
  call(requestType, requestData = {}) {
    if (!this.identified) return Promise.reject(new Error(t('err.noObs')));
    const requestId = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => { if (this.pending.delete(requestId)) reject(new Error(t('err.timeout', { req: requestType }))); }, 8000);
    });
  }
  // v2: команды для локальных Browser Source страниц
  broadcast(eventData) { return this.call('BroadcastCustomEvent', { eventData }); }
}
