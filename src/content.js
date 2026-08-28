/* Runs inside higgsfield.ai. Because it shares the page's cookies, every
   fetch with credentials:'include' is authenticated as the logged-in user.
   This is why the extension needs no API key. */

(function () {
  const S = globalThis.HF_SELECTORS;

  async function authedFetch(cfg, spec, { body, subst, bearer } = {}) {
    let path = spec.path;
    if (subst) for (const [k, v] of Object.entries(subst)) path = path.replace('{' + k + '}', v);

    const headers = { 'Content-Type': 'application/json', ...(cfg.extraHeaders ?? {}) };
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;

    let res;
    try {
      res = await fetch(cfg.apiOrigin + path, {
        method: spec.method,
        credentials: 'include',
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      // A thrown fetch means DNS/CORS/offline — NOT a bad path and NOT a login issue.
      return { ok: false, fetchThrew: true, error: `fetch to ${cfg.apiOrigin + path} threw: ${e.message}` };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, authError: true, status: res.status };
    }
    /* Read the body once as text, then try JSON. A 4xx from this API carries the
       reason in the body — throwing it away is what leaves a bare "400". */
    let raw = '', data = null;
    try { raw = await res.text(); } catch {}
    if (raw) { try { data = JSON.parse(raw); } catch { /* not JSON — keep raw */ } }
    const retryAfter = res.headers.get('retry-after');
    return { ok: res.ok, status: res.status, data,
             raw: res.ok ? undefined : raw.slice(0, 1200),
             retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : null };
  }

  /* DOM fallback for filing an element into a folder — used only when the
     folder API returns 404. Opens the ⋯ menu, clicks "Move to", picks a folder. */
  async function moveToFolderViaDom(elementName, folderName) {
    const card = await globalThis.hfWaitFor(() => {
      for (const el of document.querySelectorAll('[data-element-name], [title], img[alt]')) {
        const label = el.getAttribute('data-element-name') || el.getAttribute('title') || el.getAttribute('alt');
        if (label && label.trim() === elementName) return el.closest('[class*="card" i]') || el.parentElement;
      }
      return null;
    });

    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const dots = await globalThis.hfWaitFor(() =>
      card.querySelector('button[aria-haspopup], button[aria-label*="more" i], button[aria-label*="options" i]')
    );
    dots.click();

    const moveTo = await globalThis.hfWaitFor(() => globalThis.hfByText(S.text.moveTo));
    moveTo.click();

    const target = await globalThis.hfWaitFor(() => globalThis.hfByText(folderName));
    target.click();
    return { ok: true, via: 'dom' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            sendResponse({ ok: true, url: location.href });
            break;
          case 'FETCH':
            sendResponse(await authedFetch(msg.cfg, msg.spec, msg.opts));
            break;
          case 'MOVE_TO_FOLDER_DOM':
            sendResponse(await moveToFolderViaDom(msg.elementName, msg.folderName));
            break;
          default:
            sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // keep the channel open for the async reply
  });

  /* Relay captures from the MAIN-world interceptor. The interceptor cannot talk
     to chrome.* APIs, and this script cannot see the page's fetch — so they meet
     here via postMessage. */
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== '__HF_CAPTURE__') return;
    try { chrome.runtime.sendMessage({ type: 'CAPTURE_PUSH', rec: d.rec, meta: d.meta }); } catch {}
  });

  console.log('[HF Autopilot] content script ready');
})();
