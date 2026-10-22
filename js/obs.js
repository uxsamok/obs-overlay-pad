import { t } from './i18n.js';
// Минимальный клиент obs-websocket v5 (без зависимостей)
async function sha256b64(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d)));
}
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
