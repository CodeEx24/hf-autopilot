/* MAIN-world interceptor, registered to run at document_start.

   Two properties make this survive what the old version didn't:
   1. It is a REGISTERED content script (world:MAIN, runAt:document_start), so
      Chrome re-injects it on every page load, reload and SPA navigation.
      The old one-shot executeScript died the moment the page reloaded.
   2. It does not store anything in the page. Each captured call is posted out
      immediately via window.postMessage, so a reload loses nothing.

   Secrets are redacted here, at the point of capture, before they leave. */

(() => {
  if (window.__hfArmed) return;
  window.__hfArmed = true;

  const TAG = '__HF_CAPTURE__';
  const SECRET = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|refresh|access|session)/i;
  const SKIP = /\.(png|jpe?g|webp|gif|svg|woff2?|css|ico|mp4|m3u8|json\.map)(\?|$)|segment|sentry|posthog|analytics|datadog|intercom|hotjar|gtag|doubleclick|googletag|clarity/i;
  const KEEP = /\/api\/|\/v\d+\/|graphql|trpc|\/rest\/|fnf-api-gw|higgsfield\.ai/i;

  /* Next.js Server Actions POST to the CURRENT PAGE URL with no API path at all,
     so a path-based filter misses them entirely. Keep every mutating request
     regardless of URL shape — that is where "submit a generation" almost
     certainly lives. */
  const isMutation = (m) => m && m !== 'GET' && m !== 'HEAD';

  const redact = (v) => {
    if (typeof v !== 'string') return v;
    const m = v.match(/^(Bearer|Basic|Token)\s+(.*)$/i);
    return m ? `${m[1]} <redacted len=${m[2].length}>` : `<redacted len=${v.length}>`;
  };
  const hdrs = (h) => {
    const out = {};
    try {
      if (!h) return out;
      const list = [];
      if (h.forEach) h.forEach((v, k) => list.push([k, v]));
      else if (Array.isArray(h)) list.push(...h);
      else for (const [k, v] of Object.entries(h)) list.push([k, v]);
      for (const [k, v] of list) out[String(k)] = SECRET.test(String(k)) ? redact(String(v)) : String(v);
    } catch {}
    return out;
  };
  /* Bodies can carry raw JWTs (Clerk posts the current token as a form field,
     and returns a new one in the response). Header redaction alone was not
     enough — scrub token-shaped strings out of bodies too. */
  const scrubTokens = (str) => String(str)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<JWT redacted>')
    .replace(/(sess|user|client)_[A-Za-z0-9]{20,}/g, (m) => m.split('_')[0] + '_<redacted>');

  const trim = (s, n) => {
    if (s == null) return null;
    if (typeof s !== 'string') {
      if (s instanceof FormData) { const o = {}; for (const [k, v] of s) o[k] = typeof v === 'string' ? v : '<file>'; s = JSON.stringify(o); }
      else { try { s = JSON.stringify(s); } catch { s = String(s); } }
    }
    s = scrubTokens(s);
    return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s;
  };

  const emit = (rec) => {
    const u = String(rec.url || '');
    if (SKIP.test(u)) return;
    if (!isMutation(rec.method) && !KEEP.test(u)) return;   // keep ALL mutations
    try { window.postMessage({ source: TAG, rec }, '*'); } catch {}
  };

  // ── fetch ────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    init = init || {};
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
    let reqBody = init.body ?? null;
    if (!reqBody && isReq) { try { reqBody = await input.clone().text(); } catch {} }

    const res = await origFetch.apply(this, arguments);
    try {
      const txt = await res.clone().text().catch(() => '');
      emit({ via: 'fetch', method, url, status: res.status,
             requestHeaders: hdrs(init.headers || (isReq ? input.headers : null)),
             requestBody: trim(reqBody, 3000), responseBody: trim(txt, 1500) });
    } catch {}
    return res;
  };

  // ── XHR ──────────────────────────────────────────────────────────────────
  const O = XMLHttpRequest.prototype.open, S = XMLHttpRequest.prototype.send,
        H = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__hf = { method: m, url: u, headers: {} }; return O.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__hf) this.__hf.headers[String(k)] = SECRET.test(String(k)) ? redact(String(v)) : String(v);
    return H.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__hf) this.addEventListener('load', () => {
      emit({ via: 'xhr', method: String(this.__hf.method).toUpperCase(), url: String(this.__hf.url),
             status: this.status, requestHeaders: this.__hf.headers,
             requestBody: trim(b, 3000), responseBody: trim(this.responseText, 1500) });
    });
    return S.apply(this, arguments);
  };

  /* Job completion may be pushed over a socket rather than polled. If so, there
     is no "jobStatus" endpoint to find and the runner needs a different design —
     so it matters that we can tell the difference. */
  try {
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      emit({ via: 'websocket-open', method: 'WS', url: String(url), status: 0,
             requestHeaders: {}, requestBody: null, responseBody: null });
      let n = 0;
      ws.addEventListener('message', (e) => {
        if (n++ > 8) return;   // a sample is enough to see the shape
        emit({ via: 'websocket-msg', method: 'WS', url: String(url), status: 0,
               requestHeaders: {}, requestBody: null, responseBody: trim(e.data, 1200) });
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, OrigWS);
  } catch {}

  try {
    const OrigES = window.EventSource;
    if (OrigES) {
      window.EventSource = function (url, cfg) {
        const es = new OrigES(url, cfg);
        emit({ via: 'eventsource-open', method: 'SSE', url: String(url), status: 0,
               requestHeaders: {}, requestBody: null, responseBody: null });
        let n = 0;
        es.addEventListener('message', (e) => {
          if (n++ > 8) return;
          emit({ via: 'eventsource-msg', method: 'SSE', url: String(url), status: 0,
                 requestHeaders: {}, requestBody: null, responseBody: trim(e.data, 1200) });
        });
        return es;
      };
      window.EventSource.prototype = OrigES.prototype;
    }
  } catch {}

  // Announce storage key shapes once per load (values are length-only).
  try {
    const shape = (st) => { const o = {}; for (let i = 0; i < st.length; i++) { const k = st.key(i); o[k] = `<len=${(st.getItem(k) || '').length}>`; } return o; };
    window.postMessage({ source: TAG, meta: {
      origin: location.origin, href: location.href,
      storageKeys: { localStorage: shape(localStorage), sessionStorage: shape(sessionStorage) }
    } }, '*');
  } catch {}

  console.log('%c[HF Autopilot] capture armed (survives reloads)', 'color:#c8f235');
})();
