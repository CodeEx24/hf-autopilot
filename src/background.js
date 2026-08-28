import { CONFIG, buildImageBody, buildVideoBody, buildElementBody, capsFor, elementName, nextElementName } from './config.js';
import { EMPTY, newProject, migrate, jobCounts } from './state.js';

/* ── Storage, serialised ─────────────────────────────────────────────────────
   Every write goes through one promise chain. Concurrent read-modify-write
   cycles were previously clobbering each other and losing job progress. */
let _chain = Promise.resolve();

async function readRaw() {
  const { state } = await chrome.storage.local.get('state');
  return migrate(state);
}
const get = () => readRaw();

function patch(fn) {
  _chain = _chain.then(async () => {
    const cur = await readRaw();
    const next = fn(structuredClone(cur)) ?? cur;
    await chrome.storage.local.set({ state: next });
    return next;
  }).catch(e => console.error('[HF] patch failed', e));
  return _chain;
}

const proj = (s, id) => s.projects[id ?? s.activeId] ?? null;

/* Turn an API failure into something readable. The interesting part of a 400 is
   always in the body — usually FastAPI's [{loc, msg}] validation list, which
   names the exact field that was rejected. */
function apiError(res) {
  if (res.error) return res.error;
  const d = res.data;
  const detail = d?.detail ?? d?.message ?? d?.error ?? d?.errors;
  let text = '';
  if (Array.isArray(detail)) {
    text = detail.map(x => {
      const where = Array.isArray(x?.loc) ? x.loc.filter(s => s !== 'body').join('.') : (x?.field ?? '');
      return where ? `${where}: ${x.msg ?? x.message ?? JSON.stringify(x)}` : (x?.msg ?? JSON.stringify(x));
    }).join('; ');
  } else if (typeof detail === 'string') text = detail;
  else if (detail) text = JSON.stringify(detail);
  else if (res.raw) text = res.raw;
  text = String(text).slice(0, 400);
  return text ? `${res.status} — ${text}` : String(res.status);
}

async function log(projectId, msg, level = 'info') {
  await patch(s => {
    const p = s.projects[projectId];
    if (!p) return s;
    p.log.unshift({ t: new Date().toISOString(), level, msg });
    p.log = p.log.slice(0, 500);          // generous — logs are the audit trail
    p.updatedAt = Date.now();
    return s;
  });
}

/* ── Badge + notifications ──────────────────────────────────────────────────
   So progress is visible without opening the popup, and a finished batch is
   noticed even if the popup has been closed for an hour. */
async function refreshBadge() {
  const s = await get();
  const id = s.runQueue.find(x => s.projects[x] && !s.projects[x].paused);
  const p = id ? s.projects[id] : null;
  if (!p) { chrome.action.setBadgeText({ text: '' }); return; }
  const c = jobCounts(p);
  chrome.action.setBadgeText({ text: `${c.settled}/${c.total}` });
  chrome.action.setBadgeBackgroundColor({ color: c.failed ? '#ff7a7a' : '#CDFF00' });
}

function notify(title, message) {
  try {
    chrome.notifications?.create({
      type: 'basic', iconUrl: '../icons/icon128.png', title, message, priority: 1
    });
  } catch {}
}

/* ── Page bridge ────────────────────────────────────────────────────────────*/
const allTabs = () => chrome.tabs.query({ url: ['https://higgsfield.ai/*', 'https://*.higgsfield.ai/*'] });
async function findTab() {
  const tabs = await allTabs();
  return tabs.find(t => t.active) ?? tabs[0] ?? null;
}

async function ensureContentScript(tabId) {
  try { if ((await chrome.tabs.sendMessage(tabId, { type: 'PING' }))?.ok) return { ok: true }; } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/selectors.js', 'src/content.js'] });
    await new Promise(r => setTimeout(r, 250));
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return pong?.ok ? { ok: true } : { ok: false, error: 'content script silent' };
  } catch (e) { return { ok: false, error: 'inject failed: ' + e.message }; }
}

async function send(msg) {
  const tab = await findTab();
  if (!tab) return { ok: false, noTab: true, error: 'No higgsfield.ai tab open.' };
  const ready = await ensureContentScript(tab.id);
  if (!ready.ok) return { ok: false, bridgeError: true, error: ready.error };
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch (e) { return { ok: false, bridgeError: true, error: 'bridge lost: ' + e.message }; }
}

async function getToken() {
  const tab = await findTab();
  if (!tab) return { ok: false, error: 'No higgsfield.ai tab open.' };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: async () => {
        try {
          const c = window.Clerk;
          if (!c?.session) return { ok: false, error: 'Clerk session not found.' };
          const jwt = await c.session.getToken();
          return jwt ? { ok: true, jwt } : { ok: false, error: 'Clerk returned no token.' };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
      }
    });
    return r.result ?? { ok: false, error: 'no result' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* Not a rejection by Higgsfield — the PAGE moved under us. Navigating the tab,
   an SPA route change or a reload tears down the frame our fetch runs in, and
   Clerk is briefly absent while the new page boots. These must never consume a
   job attempt: nothing was wrong with the request. */
const TRANSIENT = /frame with id|failed to fetch|clerk session not found|clerk returned no token|bridge lost|content script silent|receiving end does not exist|no higgsfield|inject failed|message port closed|no result/i;
const isTransient = res =>
  !!res && !res.ok && res.status === undefined && TRANSIENT.test(String(res.error ?? ''));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiOnce(spec, opts = {}) {
  if (!spec) return { ok: false, error: 'Endpoint not configured.' };
  const tok = await getToken();
  if (!tok.ok) return { ok: false, authError: true, error: tok.error };
  return send({ type: 'FETCH', cfg: CONFIG, spec, opts: { ...opts, bearer: tok.jwt } });
}

/* Fallback path: call the API straight from the service worker. host_permissions
   cover the gateway, so cookies still ride along with credentials:'include' and
   there is no CORS preflight to fail. This does not depend on a page frame
   staying alive, so it survives the navigation that kills the bridge. Kept as a
   FALLBACK rather than the default because requests from the page carry the
   app's own origin and bot-protection context. */
async function apiDirect(spec, opts = {}) {
  const tok = await getToken();
  if (!tok.ok) return { ok: false, authError: true, error: tok.error };

  let path = spec.path;
  if (opts.subst) for (const [k, v] of Object.entries(opts.subst)) path = path.replace('{' + k + '}', v);

  try {
    const r = await fetch(CONFIG.apiOrigin + path, {
      method: spec.method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(CONFIG.extraHeaders ?? {}),
                 Authorization: 'Bearer ' + tok.jwt },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, status: r.status, via: 'sw' };
    let raw = '', data = null;
    try { raw = await r.text(); } catch {}
    if (raw) { try { data = JSON.parse(raw); } catch {} }
    const ra = r.headers.get('retry-after');
    return { ok: r.ok, status: r.status, data, via: 'sw',
             raw: r.ok ? undefined : raw.slice(0, 1200),
             retryAfterMs: ra ? Number(ra) * 1000 : null };
  } catch (e) {
    return { ok: false, error: `direct fetch threw: ${e.message}` };
  }
}

/* Ride out a page transition rather than surfacing it. Three tries over ~7s
   covers a reload; if the bridge is still down, go around it. */
async function api(spec, opts = {}) {
  let res;
  for (const wait of [800, 2000, 4000, 0]) {
    res = await apiOnce(spec, opts);
    if (!isTransient(res) || !wait) break;
    await sleep(wait);
  }
  if (isTransient(res)) {
    const direct = await apiDirect(spec, opts);
    // Only prefer the direct result if it actually reached the server.
    if (direct.status !== undefined) return direct;
  }
  return res;
}

async function checkAuth() {
  /* Clerk is momentarily absent while a page loads. Declaring the user logged
     out on the first miss made the popup flash "Not signed in" during any
     navigation, so give it a couple of seconds to come back. */
  let tok;
  for (const wait of [700, 1800, 0]) {
    tok = await getToken();
    if (tok.ok || !wait) break;
    await sleep(wait);
  }
  if (!tok.ok) {
    const noTab = /No higgsfield/.test(tok.error);
    await patch(s => { s.authState = noTab ? 'no_tab' : 'logged_out'; return s; });
    return false;
  }
  await patch(s => { s.authState = 'ok'; return s; });
  return true;
}

/* ── Project detection ──────────────────────────────────────────────────────*/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function idFromUrl(url) {
  try {
    const u = new URL(url);
    for (const k of ['projectId', 'project_id', 'folderId', 'folder_id']) {
      const v = u.searchParams.get(k);
      if (v && UUID.test(v)) return v.match(UUID)[0];
    }
    const m = u.pathname.match(UUID);
    if (m) return m[0];
  } catch {}
  return null;
}

async function detectProject() {
  const tabs = [...(await allTabs())].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  const seen = [];
  for (const t of tabs) {
    if (t.url) { seen.push(t.url); const id = idFromUrl(t.url); if (id) return { id, from: t.url }; }
  }
  for (const t of tabs) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: () => location.href });
      if (r?.result) { seen.push(r.result); const id = idFromUrl(r.result); if (id) return { id, from: r.result }; }
    } catch {}
  }
  return { id: null, seen };
}

async function folderName(id) {
  const r = await api(CONFIG.endpoints.getFolder, { subst: { folderId: id } });
  return r.ok ? (r.data?.name ?? null) : null;
}

/* ── Runner ─────────────────────────────────────────────────────────────────
   Only ONE project runs at a time — Higgsfield rate-limits concurrent
   generations, so several projects racing would just produce 429s. Additional
   projects sit in runQueue and start automatically when the one ahead
   finishes. */

const isDone   = v => CONFIG.statusValues.done.includes(v);
const isFailed = v => CONFIG.statusValues.failed.includes(v);
const ACTIVE   = ['generating', 'generated', 'element_created'];
const asList   = v => v == null ? [] : (Array.isArray(v) ? v : [v]);
const refNames = spec => [...asList(spec.reference), ...asList(spec.dependsOn)];

function defaultsFor(m) {
  const d = {
    image: { ...CONFIG.builtinDefaults.image, ...(m.defaults?.image ?? {}) },
    video: { ...CONFIG.builtinDefaults.video, ...(m.defaults?.video ?? {}) }
  };
  /* "unlimited" set once for the whole manifest — at the root or on defaults —
     applies to both types unless a type sets its own. */
  const root = m.unlimited ?? m.use_unlim ?? m.defaults?.unlimited ?? m.defaults?.use_unlim;
  if (root !== undefined)
    for (const t of ['image', 'video'])
      if (d[t].unlimited === undefined && d[t].params?.unlimited === undefined) d[t].unlimited = root;
  return d;
}

/* Higgsfield stores Element names normalised — "@props_beach sandals" in a
   manifest is saved as "props_beach-sandals". Compare on that normal form so a
   cosmetic difference doesn't read as a missing Element. */
const normName = n => String(n ?? '').replace(/^@/, '').trim().toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* Resolve Element names to ids WITHOUT deciding what to do about the ones that
   are absent — the caller holds the job rather than failing it, so the names
   have to come back intact. */
async function resolveElements(names, pid) {
  if (!names?.length) return { ids: [], missing: [], catalogOk: true, catalog: [] };

  const seen = new Map();          // normalised name → id
  const ids  = new Set();          // every id that actually exists
  const catalog = [];
  const absorb = r => {
    if (!r?.ok) return false;
    for (const e of (r.data?.items ?? [])) {
      if (!e?.id) continue;
      ids.add(String(e.id).toLowerCase());
      if (!e.name) continue;
      catalog.push(e.name);
      seen.set(normName(e.name), e.id);
    }
    return true;
  };

  // Whole account first, then the project folder — an Element filed in a
  // subfolder does not always come back in the flat picker.
  let catalogOk = absorb(await api(CONFIG.endpoints.listElements));
  const p = (await get()).projects[pid];
  if (p?.id && /^[0-9a-f-]{36}$/i.test(p.id))
    catalogOk = absorb(await api(CONFIG.endpoints.listInFolder, { subst: { folderId: p.id } })) || catalogOk;

  const out = [], missing = [];
  for (const n of names) {
    if (/^[0-9a-f-]{36}$/i.test(n)) {
      /* A raw UUID used to be trusted on sight. It shouldn't be: re-uploading
         an Element gives it a NEW id, so a manifest saved in an earlier session
         can point at ids that no longer exist. Higgsfield doesn't complain — it
         just silently drops the reference and generates the wrong thing. */
      if (!catalogOk || ids.has(n.toLowerCase())) out.push(n);
      else missing.push(n);
      continue;
    }
    const id = seen.get(normName(n));
    id ? out.push(id) : missing.push(n);
  }
  return { ids: out, missing, catalogOk, catalog };
}

/* Closest existing names, so a typo or a rename is obvious at a glance. */
function nearestNames(want, catalog, n = 3) {
  const w = normName(want);
  const score = c => {
    const x = normName(c);
    if (x === w) return 100;
    if (x.includes(w) || w.includes(x)) return 80;
    const parts = w.split('-').filter(Boolean);
    return parts.filter(t => t.length > 2 && x.includes(t)).length * 10;
  };
  return catalog.map(c => [score(c), c]).filter(([s]) => s > 0)
                .sort((a, b) => b[0] - a[0]).slice(0, n).map(([, c]) => c);
}

/* Ask Higgsfield for the current state of every in-flight job and pull down any
   finished media. Used by the normal tick AND by an explicit sync — while a
   project is paused the generation Higgsfield already accepted keeps running,
   so on resume its result is usually sitting there waiting to be collected. */
/* Higgsfield scans every Element's media for third-party IP before it can be
   used as a reference. Until that finishes, any job referencing it is rejected
   with 400 {"error_type":"other","text":"IP check not finished for input media"}.
   The field names aren't documented, so pull anything IP-ish off the element
   and its first media rather than guessing one key. */
async function ipStateOf(elementId) {
  const r = await api(CONFIG.endpoints.getElement, { subst: { id: elementId } });
  if (!r.ok) return { id: elementId, unknown: true };
  const e = r.data?.element ?? r.data ?? {};
  const m = (e.medias ?? [])[0] ?? {};
  const ipKeys = o => Object.entries(o || {}).filter(([k]) => /^ip[_A-Z]/i.test(k));
  const fields = Object.fromEntries([...ipKeys(e), ...ipKeys(m)]);
  const done = fields.ipCheckFinished ?? fields.ip_check_finished;
  return { id: elementId, name: e.name ?? elementId, fields,
           finished: done === undefined ? null : !!done };
}

/* Park a job until the scan completes. Not a failure — no attempt is used and
   the batch moves on to whatever else is runnable. */
async function holdForIp(pid, name, elementIds) {
  const states = [];
  for (const id of (elementIds ?? [])) states.push(await ipStateOf(id));
  const blocked = states.filter(st => st.finished === false);
  const named = (blocked.length ? blocked : states).map(st => st.name ?? st.id);

  await patch(st => {
    const j = st.projects[pid].jobs.find(x => x.name === name);
    j.status = 'waiting_ip';
    j.ipRetryAt = Date.now() + CONFIG.limits.ipRecheckMs;
    j.error = `Element IP scan pending: ${named.join(', ') || 'unknown'}`;
    return st;
  });

  await log(pid, `${name}: on hold — Higgsfield is still running its IP check on `
    + `${named.length} referenced Element(s): ${named.join(', ') || '(could not identify which)'}. `
    + `Nothing is wrong with the job; it retries automatically every `
    + `${Math.round(CONFIG.limits.ipRecheckMs / 60000)} min.`, 'warn');
  for (const st of states)
    if (Object.keys(st.fields ?? {}).length)
      await log(pid, `  ${st.name ?? st.id}: ${JSON.stringify(st.fields)}`, 'warn');
}

/* Put IP-held jobs back in the queue once their recheck time arrives. */
async function releaseIpHolds(pid, force = false) {
  const s = await get();
  const due = (s.projects[pid]?.jobs ?? [])
    .filter(j => j.status === 'waiting_ip' && (force || (j.ipRetryAt ?? 0) <= Date.now()));
  for (const j of due) {
    await patch(st => {
      const x = st.projects[pid].jobs.find(y => y.name === j.name);
      x.status = 'pending'; x.error = null;
      return st;
    });
    await log(pid, `${j.name}: rechecking — IP scan may have finished.`);
  }
  return due.length;
}

async function pollJobs(pid) {
  const s = await get();
  const p = s.projects[pid];
  if (!p) return 0;

  const EP = CONFIG.endpoints;
  const inFlight = p.jobs.filter(j => j.status === 'generating' && j.jobId);
  if (!inFlight.length) return 0;

  const res = await api(EP.jobStatus, { body: { ids: inFlight.map(j => j.jobId) } });
  if (!res.ok) return 0;
  const rows = res.data?.items ?? [];

  /* Fetching the job directly returns its full record including result URLs,
     for video as well as image. The folder listing is kept as a fallback for
     the case where the detail route rejects the folder_id we hold. */
  let itemsByJob = null;
  const loadFolderItems = async () => {
    if (itemsByJob) return itemsByJob;
    const fid = inFlight.find(j => j.folderId)?.folderId ?? p.id;
    const fr = await api(EP.folderItems, { subst: { folderId: fid } });
    itemsByJob = {};
    if (fr.ok) for (const it of (fr.data?.items ?? [])) { const jb = it.job ?? it; if (jb?.id) itemsByJob[jb.id] = jb; }
    return itemsByJob;
  };
  const detailOf = async (job) => {
    const dr = await api(EP.jobDetail, { subst: { id: job.jobId, folderId: job.folderId ?? p.id } });
    if (dr.ok && dr.data) return dr.data.job ?? dr.data;
    return (await loadFolderItems())[job.jobId] ?? null;
  };
  /* Video results land under a different key than images depending on the
     model, so try each shape rather than assuming one. */
  const urlOf = j => j?.results?.raw?.url ?? j?.results?.min?.url
                  ?? j?.results?.video?.url ?? j?.results?.url
                  ?? j?.result?.url ?? null;

  let changed = 0;
  for (const job of inFlight) {
    const rec = rows.find(r => r?.id === job.jobId);
    if (!rec) {
      // Higgsfield does not know this id — treat as lost rather than hanging.
      await failJob(pid, job.name, 'job id not found on the server');
      changed++; continue;
    }
    if (isFailed(rec.status)) { await failJob(pid, job.name, 'generation failed: ' + rec.status); changed++; continue; }

    /* The status list can't cover a value Higgsfield hasn't shown us yet, and a
       job stuck on an unrecognised status would sit in "generating" forever
       while the finished image sits in the account. Past the stale threshold,
       stop trusting status and ask the job itself whether it has media. */
    const stale = job.submittedAt && (Date.now() - job.submittedAt) > CONFIG.limits.staleJobMs;
    if (!isDone(rec.status)) {
      if (!stale) continue;
      const probe = await detailOf(job);
      if (!urlOf(probe)) {
        if (!job.staleLogged) {
          await log(pid, `${job.name}: still running after `
            + `${Math.round((Date.now() - job.submittedAt) / 60000)} min (status "${rec.status}").`, 'warn');
          await patch(st => { st.projects[pid].jobs.find(x => x.name === job.name).staleLogged = true; return st; });
        }
        continue;
      }
      await log(pid, `${job.name}: finished on Higgsfield but reported status "${rec.status}" — `
        + `recovered from the job record.`, 'warn');
    }

    const full = await detailOf(job);
    const url = urlOf(full);
    if (!url) { await log(pid, `${job.name}: completed, waiting for media URL`); continue; }

    await patch(st => {
      const pr = st.projects[pid];
      const j = pr.jobs.find(x => x.name === job.name);
      if (j.submittedAt) pr.batch.durations = [...(pr.batch.durations ?? []), Date.now() - j.submittedAt].slice(-20);
      j.status = 'generated'; j.mediaUrl = url; j.mediaId = job.jobId;
      j.width = full?.params?.width ?? null; j.height = full?.params?.height ?? null;
      j.jobSetType = j.jobSetType ?? full?.job_set?.type ?? full?.type ?? full?.params?.model ?? null;
      // Carry the source media's IP-scan result forward — a later video job has
      // to restate it or the request is rejected.
      j.ipCheckFinished = full?.ip_check_finished ?? full?.ipCheckFinished ?? true;
      j.ipDetected      = full?.ip_detected      ?? full?.ipDetected      ?? false;
      j.ipStatus        = full?.ip_status        ?? full?.ipStatus        ?? 'uploaded';
      return st;
    });
    await log(pid, `Finished ${job.name}`);
    changed++;
  }
  return changed;
}

/* Full reconcile: refresh in-flight jobs, then finish off anything that already
   generated but never got its Element created (which is what a pause in the
   middle of the pipeline leaves behind). */
async function syncProject(pid) {
  // An explicit Sync means "check now", so the IP backoff is skipped.
  const freed  = (await releaseHolds(pid)) + (await releaseIpHolds(pid, true));
  const polled = await pollJobs(pid);
  const made = await createElements(pid);
  const s = await get();
  const c = jobCounts(s.projects[pid]);
  await log(pid, `Synced — ${polled} job(s) updated, ${made} Element(s) created`
    + (freed ? `, ${freed} released from hold` : '')
    + (c.waiting ? `. ${c.waiting} still waiting on Elements` : '')
    + `. ${c.settled}/${c.total} done.`);
  return { polled, made, freed, counts: c };
}

/* A hold is not a failure: no attempt is consumed, the job stays in the batch,
   and it resumes on its own. Logged only when the missing set CHANGES, so a
   long wait doesn't bury the log under one repeated line. */
async function holdJob(pid, name, el) {
  const s = await get();
  const prev = s.projects[pid]?.jobs.find(j => j.name === name);
  const same = prev?.status === 'waiting_elements' &&
               (prev.missingElements ?? []).join('|') === el.missing.join('|');

  await patch(st => {
    const j = st.projects[pid].jobs.find(x => x.name === name);
    j.status = 'waiting_elements';
    j.missingElements = el.missing;
    j.error = `needs Element${el.missing.length > 1 ? 's' : ''}: ${el.missing.join(', ')}`;
    return st;
  });

  if (same) return;

  if (!el.catalogOk) {
    await log(pid, `${name}: on hold — could not read your Elements list, so ${el.missing.join(', ')} can't be confirmed. Retrying.`, 'warn');
    return;
  }
  await log(pid, `${name}: on hold — missing ${el.missing.length} Element(s): ${el.missing.join(', ')}`, 'warn');
  for (const m of el.missing) {
    if (/^[0-9a-f-]{36}$/i.test(m)) {
      await log(pid, `  ${m} — this id no longer exists in your account. The Element was `
        + `most likely re-uploaded, which gives it a new id. Replace the id in the manifest `
        + `with the Element's NAME and it will resolve by name from now on.`, 'warn');
      continue;
    }
    const near = nearestNames(m, el.catalog);
    await log(pid, near.length
      ? `  ${m} — not in this project. Closest existing: ${near.join(', ')}`
      : `  ${m} — not found in any of your ${el.catalog.length} Elements.`, 'warn');
  }
  await log(pid, `  Add the media in Higgsfield (Elements → New Element, name it exactly as above, file it in this project), then it resumes automatically — no restart needed.`, 'warn');
}

/* Re-check everything on hold once per tick using a single catalog read. */
async function releaseHolds(pid) {
  const s = await get();
  const p = s.projects[pid];
  const held = (p?.jobs ?? []).filter(j => j.status === 'waiting_elements');
  if (!held.length) return 0;

  const spec = name => p.manifest.jobs.find(j => j.name === name);
  const wanted = [...new Set(held.flatMap(j => spec(j.name)?.elements ?? []))];
  const el = await resolveElements(wanted, pid);
  if (!el.catalogOk) return 0;
  const stillMissing = new Set(el.missing.map(normName));

  let freed = 0;
  for (const job of held) {
    const need = spec(job.name)?.elements ?? [];
    const gap = need.filter(n => !/^[0-9a-f-]{36}$/i.test(n) && stillMissing.has(normName(n)));
    if (gap.length) continue;
    await patch(st => {
      const j = st.projects[pid].jobs.find(x => x.name === job.name);
      j.status = 'pending'; j.error = null; j.missingElements = [];
      return st;
    });
    await log(pid, `${job.name}: Elements found — back in the queue.`);
    freed++;
  }
  return freed;
}

async function runProject(pid) {
  let s = await get();
  let p = s.projects[pid];
  if (!p?.manifest) return;

  if (s.cooldownUntil && Date.now() < s.cooldownUntil) return;

  // Anything the user has since added — or that has finished scanning — goes
  // back in the queue.
  if (await releaseHolds(pid) || await releaseIpHolds(pid)) { s = await get(); p = s.projects[pid]; }

  const EP = CONFIG.endpoints;
  const d = defaultsFor(p.manifest);
  const spec = name => p.manifest.jobs.find(j => j.name === name);
  const jobIdOf = n => /^[0-9a-f-]{36}$/i.test(n ?? '') ? n : (p.jobs.find(j => j.name === n)?.jobId ?? null);
  /* Video wants the whole media object, not just an id: { id, url, type }.
     A bare UUID in the manifest gives us the id only — the backend accepts
     that, it just can't show a thumbnail while it queues. */
  const mediaRefOf = n => {
    if (!n) return null;
    if (/^[0-9a-f-]{36}$/i.test(n)) return { id: n, url: null, jobSetType: null };
    const dj = p.jobs.find(j => j.name === n);
    if (!dj?.jobId) return null;
    return { id: dj.mediaId ?? dj.jobId, url: dj.mediaUrl ?? null, jobSetType: dj.jobSetType ?? null,
             ipCheckFinished: dj.ipCheckFinished, ipDetected: dj.ipDetected, ipStatus: dj.ipStatus };
  };

  // ── submit one, only if nothing is active ────────────────────────────────
  const active = p.jobs.filter(j => ACTIVE.includes(j.status)).length;
  if (active < CONFIG.limits.maxConcurrent) {
    for (const job of p.jobs.filter(j => j.status === 'pending')) {
      const sp = spec(job.name);
      const deps = [...refNames(sp), ...asList(sp.startImage), ...asList(sp.endImage)].filter(Boolean);
      const blocked = deps.some(dn => {
        if (/^[0-9a-f-]{36}$/i.test(dn)) return false;
        const dj = p.jobs.find(j => j.name === dn);
        return dj && !['generated', 'element_created', 'complete'].includes(dj.status);
      });
      if (blocked) continue;

      const type = (sp.type ?? 'image').toLowerCase();
      const folderRef = p.manifest.folders?.[sp.category] ?? p.id;

      /* Elements the job needs but the project doesn't have yet. Generating
         anyway would silently produce the wrong subject, and failing the job
         throws away work the user can fix in thirty seconds — so hold it and
         name exactly what to add. The hold clears by itself on the next tick
         once the Element exists. */
      const el = await resolveElements(sp.elements, pid);
      if (el.missing.length) {
        await holdJob(pid, job.name, el);
        continue;
      }

      const ctx = {
        slugOverrides: p.manifest.modelSlugs ?? {},
        folderId: /^[0-9a-f-]{36}$/i.test(folderRef ?? '') ? folderRef : null,
        elementIds: el.ids,
        referenceJobIds: refNames(sp).map(jobIdOf).filter(Boolean),
        startImage: mediaRefOf(asList(sp.startImage)[0]),
        endImage:   mediaRefOf(asList(sp.endImage)[0])
      };
      const built = type === 'video' ? buildVideoBody(sp, d, ctx) : buildImageBody(sp, d, ctx);
      for (const n of built.notes ?? []) await log(pid, `${job.name}: ${n}`, 'warn');
      if (built.dropped?.length)
        await log(pid, `${job.name}: model accepts ${capsFor(sp.model ?? d[type].model).maxRefs} refs; dropped ${built.dropped.length}`, 'warn');

      /* Image and video are two different routes. Image: /fnf/jobs/{slug} with
         the model hyphenated. Video: /fnf/jobs/v2/{key} with the model left in
         underscore form. Sending a video to the image route is what produced
         the 405 — it fell through to the GET-only /fnf/jobs/{id}. */
      const ep   = type === 'video' ? EP.generateVideo : EP.generate;
      const path = type === 'video'
        ? ep.path.replace('{modelKey}', built.modelKey)
        : ep.path.replace('{modelSlug}', built.modelSlug);
      const res = await api({ ...ep, path }, { body: built.body });

      if (res.status === 429) {
        await patch(st => {
          st.rateLimitHits = (st.rateLimitHits ?? 0) + 1;
          st.cooldownUntil = Date.now() + Math.min(
            res.retryAfterMs ?? CONFIG.limits.rateLimitBackoffMs * st.rateLimitHits,
            CONFIG.limits.rateLimitMaxBackoffMs);
          return st;
        });
        const st = await get();
        await log(pid, `Rate limited — waiting ${Math.round((st.cooldownUntil - Date.now()) / 1000)}s. ${job.name} stays queued.`, 'warn');
        return;
      }
      if (res.status === 405 || res.status === 404) {
        /* The path exists but rejects POST (405), or doesn't exist (404) — both
           mean the model slug is wrong, so the request fell through to the
           GET-only /fnf/jobs/{id} route. Say so explicitly instead of leaving a
           bare status code. */
        await failJob(pid, job.name,
          `unknown model "${sp.model ?? d[type].model}" — POST ${path} returned ${res.status}. ` +
          `Add "modelSlugs": { "${sp.model ?? d[type].model}": "<real-slug>" } to the manifest.`);
        return;
      }
      if (isTransient(res)) {
        /* The tab navigated mid-submit. We cannot tell whether Higgsfield
           accepted the job, so leave it pending and let the next tick decide —
           re-submitting blind could double-charge. */
        await softFail(pid, job.name, apiError(res));
        return;
      }
      /* This particular 400 is not a payload problem — it is Higgsfield still
         scanning a referenced Element. Failing the job would be wrong twice
         over: nothing is broken, and the wait is usually minutes. */
      if (res.status === 400 && /ip check not finished/i.test(JSON.stringify(res.data ?? res.raw ?? ''))) {
        await holdForIp(pid, job.name, ctx.elementIds);
        continue;
      }
      if (!res.ok) {
        /* A 400 means the route was right but the payload wasn't. Record the
           body we sent alongside the server's complaint so the mismatch is
           visible without another capture round-trip. */
        if (res.status === 400) {
          /* Summarise the inputs first — the prompt swamps the body dump and
             the inputs are what a 400 is almost always about. */
          const m = built.body?.params?.medias ?? [];
          await log(pid, `${job.name}: inputs — ${m.length ? m.map(x =>
            `${x.role}:${x.data?.type}/ip=${x.data?.ipStatus}:${x.data?.ipCheckFinished}`).join(' ')
            : 'no start/end image'}; ${(ctx.elementIds ?? []).length} element ref(s)`, 'warn');
          const { prompt, ...rest } = built.body.params;
          await log(pid, `${job.name}: params (prompt omitted) ${JSON.stringify(rest).slice(0, 900)}`, 'warn');
        }
        await failJob(pid, job.name, `generate(${type}): ${apiError(res)}`);
        return;
      }

      const jobSet = res.data?.job_sets?.[0];
      const jobId  = jobSet?.jobs?.[0]?.id;
      if (!jobId) { await failJob(pid, job.name, 'no job id in generate response'); return; }
      /* Remember the job-set type ("nano_banana_2", "seedance_2_0", …). A later
         video job that uses this output as its start frame has to declare it as
         "<type>_job" in the media entry. */
      const jobSetType = jobSet?.type ?? jobSet?.job_set_type ?? null;

      await patch(st => {
        const j = st.projects[pid].jobs.find(x => x.name === job.name);
        j.status = 'generating'; j.jobId = jobId; j.submittedAt = Date.now(); j.folderId = ctx.folderId;
        j.jobSetType = jobSetType; j.kind = type;
        st.rateLimitHits = 0; st.cooldownUntil = 0;
        return st;
      });
      await log(pid, `Submitted ${type} · ${job.name}`);
      break;
    }
  }

  await pollJobs(pid);

  await createElements(pid);
}

/* Higgsfield answers a duplicate name with 409, but be tolerant about how the
   message is phrased in case the status ever changes. */
function isDuplicateName(res) {
  if (res.status === 409) return true;
  const t = JSON.stringify(res.data ?? res.raw ?? '').toLowerCase();
  return /already exist|duplicate|name.*taken/.test(t);
}

/* Every Element name currently on the account, lower-cased. Cached briefly —
   createElements can run several jobs in one pass and the list only changes
   when we ourselves add to it. */
let _elCache = null;
async function elementNameSet(pid) {
  if (_elCache && Date.now() - _elCache.at < CONFIG.limits.elementCacheMs) return _elCache.set;
  const set = new Set();
  const soak = r => { if (r?.ok) for (const e of (r.data?.items ?? [])) if (e?.name) set.add(String(e.name).toLowerCase()); };
  soak(await api(CONFIG.endpoints.listElements));
  const p = (await get()).projects[pid];
  if (p?.id && /^[0-9a-f-]{36}$/i.test(p.id))
    soak(await api(CONFIG.endpoints.listInFolder, { subst: { folderId: p.id } }));
  _elCache = { at: Date.now(), set };
  return set;
}

const _busy = new Set();
async function createElements(pid) {
  if (_busy.has(pid)) return 0;      // a tick and a manual Sync can overlap
  _busy.add(pid);
  try { return await _createElements(pid); } finally { _busy.delete(pid); }
}

async function _createElements(pid) {
  const s = await get();
  const p = s.projects[pid];
  if (!p?.manifest) return 0;
  const spec = name => p.manifest.jobs.find(j => j.name === name);
  let made = 0;

  for (const job of p.jobs.filter(j => j.status === 'generated')) {
    const sp = spec(job.name);
    const type = (sp.type ?? 'image').toLowerCase();
    if (!(sp.saveAsElement ?? (type === 'image'))) {
      await patch(st => { st.projects[pid].jobs.find(x => x.name === job.name).status = 'complete'; return st; });
      made++; continue;
    }
    const folderRef = p.manifest.folders?.[sp.category] ?? p.id;
    const folderId  = /^[0-9a-f-]{36}$/i.test(folderRef ?? '') ? folderRef : null;
    const media = { id: job.mediaId, url: job.mediaUrl, width: job.width, height: job.height };

    /* Element names are unique per account, so re-running a batch collides with
       the Elements the last run created. Rather than failing a finished
       generation, fall back to name-1, name-2, … — the media is already paid
       for and the user wants it saved. */
    const base  = sp.elementName ?? job.name;
    const taken = await elementNameSet(pid);
    let candidate = nextElementName(base, taken);
    let res, renamed = false;

    for (let attempt = 0; attempt < 8; attempt++) {
      res = await api(CONFIG.endpoints.createElement, {
        body: buildElementBody(sp, media, { folderId, name: candidate })
      });
      if (res.ok || !isDuplicateName(res)) break;
      // Lost a race, or the picker page didn't list it — step to the next free
      // suffix and try again.
      taken.add(candidate.toLowerCase());
      candidate = nextElementName(base, taken);
      renamed = true;
    }

    if (!res.ok && isTransient(res)) { await softFail(pid, job.name, apiError(res)); continue; }
    if (!res.ok) { await failJob(pid, job.name, 'createElement: ' + apiError(res), 'generated'); continue; }
    if (candidate !== elementName(base)) {
      await log(pid, `${job.name}: "${elementName(base)}" already exists — saved as "${candidate}".`
        + (renamed ? '' : ''), 'warn');
    }
    _elCache = null;                       // the catalog just changed
    await patch(st => {
      const j = st.projects[pid].jobs.find(x => x.name === job.name);
      j.status = 'complete'; j.elementId = res.data?.id ?? null; j.elementName = candidate;
      return st;
    });
    await log(pid, `Element created · ${job.name}`);
    made++;
  }
  return made;
}

/* retryStatus decides WHERE a retry resumes. A generation that failed goes back
   to 'pending' and is re-submitted; a job whose media already exists must go
   back to 'generated' instead, or the retry would pay for the image a second
   time just to redo the Element step. */
/* Log a transient condition without touching the job. Repeats are suppressed —
   a tab left mid-navigation would otherwise fill the log with one line. */
async function softFail(pid, name, error) {
  const s = await get();
  const last = s.projects[pid]?.log?.[0]?.msg ?? '';
  const msg = `${name}: paused on a page change (${error}). Will retry — no attempt used.`;
  if (last !== msg) await log(pid, msg, 'warn');
}

async function failJob(pid, name, error, retryStatus = 'pending') {
  await patch(s => {
    const j = s.projects[pid].jobs.find(x => x.name === name);
    j.attempts = (j.attempts ?? 0) + 1;
    j.error = error;
    j.status = j.attempts >= CONFIG.limits.maxAttempts ? 'failed' : retryStatus;
    return s;
  });
  await log(pid, `${name}: ${error}`, 'error');
}

async function tick() {
  const s = await get();
  // A paused project keeps its place in the queue but is skipped, so pausing
  // one project does not block the others behind it.
  const pid = s.runQueue.find(id => s.projects[id] && !s.projects[id].paused);
  if (!pid) { await refreshBadge(); return; }
  if (!(await checkAuth())) return;

  await runProject(pid);
  await refreshBadge();

  const after = await get();
  const p = after.projects[pid];

  /* Everything that CAN run has run, and the remainder is waiting on Elements.
     The project stays queued — it must, or adding the Element later would go
     unnoticed — but say so once instead of ticking away silently. */
  if (p && p.jobs.length
      && p.jobs.every(j => ['complete', 'failed', 'waiting_elements', 'waiting_ip'].includes(j.status))
      && p.jobs.some(j => j.status === 'waiting_elements' || j.status === 'waiting_ip')
      && !p.batch.heldNotifiedAt) {
    const held = p.jobs.filter(j => ['waiting_elements', 'waiting_ip'].includes(j.status));
    const names = [...new Set(held.flatMap(j => j.missingElements ?? [j.error].filter(Boolean)))];
    await patch(st => { st.projects[pid].batch.heldNotifiedAt = Date.now(); return st; });
    await log(pid, `Waiting on you — ${held.length} job(s) held for missing Element(s): ${names.join(', ')}. `
      + `Add them to this project in Higgsfield and they run automatically.`, 'warn');
    notify(`${p.name} — waiting on Elements`, `${held.length} job(s) need: ${names.slice(0, 4).join(', ')}`);
  }
  if (p && !p.jobs.some(j => ['waiting_elements', 'waiting_ip'].includes(j.status)) && p.batch.heldNotifiedAt)
    await patch(st => { st.projects[pid].batch.heldNotifiedAt = null; return st; });

  if (p && p.jobs.length && p.jobs.every(j => ['complete', 'failed'].includes(j.status))) {
    const c = jobCounts(p);
    await patch(st => {
      st.projects[pid].batch.finishedAt = Date.now();
      st.runQueue = st.runQueue.filter(x => x !== pid);
      return st;
    });
    await log(pid, `Batch finished — ${c.done} complete, ${c.failed} failed.`);
    notify(`${p.name} finished`, `${c.done} complete${c.failed ? `, ${c.failed} failed` : ''}`);
    await refreshBadge();
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'hf-tick') tick(); });

(async function boot() {
  // Only tear down the capture script when it is NOT armed — otherwise arming
  // it would be undone by the next service-worker wake.
  const s0 = await get();
  if (!s0.capture?.armed) chrome.scripting.unregisterContentScripts({ ids: ['hf-capture'] }).catch(() => {});
  chrome.alarms.create('hf-tick', { periodInMinutes: 1 });
  await refreshBadge();
  const loop = async () => {
    try { const s = await get(); if (s.runQueue.length) await tick(); } catch (e) { console.error(e); }
    setTimeout(loop, Math.max(5, CONFIG.limits.pollIntervalSec) * 1000);
  };
  loop();
})();

/* ── Endpoint capture ────────────────────────────────────────────────────────
   Re-armable so new endpoints (video generation, anything Higgsfield changes)
   can be recorded without shipping a new build. Secrets are redacted inside the
   page before anything is stored. */
async function armCapture() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['hf-capture'] }).catch(() => []);
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: 'hf-capture',
      matches: ['https://higgsfield.ai/*', 'https://*.higgsfield.ai/*'],
      js: ['src/inject-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true
    }]);
  }
  // Also inject into the tab that is already open so capture starts now.
  const tab = await findTab();
  if (tab) {
    await ensureContentScript(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['src/inject-main.js'] }).catch(() => {});
  }
  await patch(s => { s.capture = { armed: true, meta: s.capture?.meta ?? null, calls: s.capture?.calls ?? [] }; return s; });
}

async function disarmCapture() {
  await chrome.scripting.unregisterContentScripts({ ids: ['hf-capture'] }).catch(() => {});
  await patch(s => { if (s.capture) s.capture.armed = false; return s; });
}

/* ── Messages ───────────────────────────────────────────────────────────────*/
chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  (async () => {
    const s = await get();
    switch (msg.type) {
      case 'GET_STATE': respond(s); break;

      case 'ADD_PROJECT': {
        const id = msg.id || 'local-' + Date.now();
        await patch(st => {
          if (!st.projects[id]) st.projects[id] = newProject({ id, name: msg.name });
          else st.projects[id].name = msg.name || st.projects[id].name;
          st.order = [id, ...st.order.filter(x => x !== id)];
          st.activeId = id; st.view = 'project';
          return st;
        });
        respond({ ok: true, id });
        break;
      }
      case 'OPEN_PROJECT':
        await patch(st => {
          st.activeId = msg.id; st.view = 'project';
          st.order = [msg.id, ...st.order.filter(x => x !== msg.id)];
          return st;
        });
        respond({ ok: true }); break;

      case 'SET_VIEW': await patch(st => { st.view = msg.view; return st; }); respond({ ok: true }); break;

      case 'RENAME_PROJECT':
        await patch(st => { if (st.projects[msg.id]) st.projects[msg.id].name = msg.name; return st; });
        respond({ ok: true }); break;

      case 'DELETE_PROJECT':
        await patch(st => {
          delete st.projects[msg.id];
          st.order = st.order.filter(x => x !== msg.id);
          st.runQueue = st.runQueue.filter(x => x !== msg.id);
          if (st.activeId === msg.id) { st.activeId = null; st.view = 'list'; }
          return st;
        });
        await refreshBadge(); respond({ ok: true }); break;

      case 'LOAD_MANIFEST': {
        const jobs = msg.manifest.jobs.map(j => ({
          name: j.name, type: (j.type ?? 'image').toLowerCase(), status: 'pending', attempts: 0
        }));
        await patch(st => {
          const p = st.projects[msg.id];
          if (!p) return st;
          p.manifest = msg.manifest; p.jobs = jobs;
          p.batch = { startedAt: null, finishedAt: null, durations: [] };
          p.updatedAt = Date.now();
          return st;
        });
        await log(msg.id, `Loaded ${jobs.length} jobs.`);
        /* Check every Element reference NOW rather than discovering a dead id
           halfway through a paid batch. */
        const refs = [...new Set(msg.manifest.jobs.flatMap(j => j.elements ?? []))];
        if (refs.length) {
          const chk = await resolveElements(refs, msg.id);
          if (!chk.catalogOk) await log(msg.id, `Could not read your Elements list — references unverified.`, 'warn');
          else if (chk.missing.length)
            await log(msg.id, `${chk.missing.length} of ${refs.length} Element reference(s) do not resolve: `
              + `${chk.missing.join(', ')}. Jobs using them will be held, not failed.`, 'warn');
          else await log(msg.id, `All ${refs.length} Element reference(s) resolve.`);
        }
        respond({ ok: true, count: jobs.length }); break;
      }

      case 'START': {
        const p = s.projects[msg.id];
        if (!p?.manifest) { respond({ ok: false, error: 'Load a manifest first.' }); break; }
        await patch(st => {
          const pr = st.projects[msg.id];
          if (!pr.batch.startedAt) pr.batch.startedAt = Date.now();
          pr.batch.finishedAt = null;
          pr.paused = false;
          if (!st.runQueue.includes(msg.id)) st.runQueue.push(msg.id);
          return st;
        });
        const st2 = await get();
        const pos = st2.runQueue.indexOf(msg.id);
        await log(msg.id, pos === 0 ? 'Started.' : `Queued — ${pos} project(s) ahead.`);
        tick();
        respond({ ok: true, position: pos }); break;
      }
      case 'PAUSE':
        await patch(st => { if (st.projects[msg.id]) st.projects[msg.id].paused = true; return st; });
        await log(msg.id, 'Paused. Any generation already accepted by Higgsfield keeps running.');
        await refreshBadge(); respond({ ok: true }); break;

      case 'RESUME': {
        await patch(st => {
          const p = st.projects[msg.id];
          if (p) p.paused = false;
          if (!st.runQueue.includes(msg.id)) st.runQueue.push(msg.id);
          st.cooldownUntil = 0; st.rateLimitHits = 0;
          return st;
        });
        await log(msg.id, 'Resuming — checking what finished while paused…');
        // Reconcile BEFORE anything new is submitted, so the job that completed
        // during the pause is collected rather than left stuck at "generating".
        const r = await syncProject(msg.id);
        tick();
        respond({ ok: true, ...r }); break;
      }

      case 'SYNC': {
        const r = await syncProject(msg.id);
        await refreshBadge();
        respond({ ok: true, ...r }); break;
      }

      case 'STOP':
        await patch(st => {
          st.runQueue = st.runQueue.filter(x => x !== msg.id);
          if (st.projects[msg.id]) st.projects[msg.id].paused = false;
          return st;
        });
        await log(msg.id, 'Stopped and removed from the run queue.');
        await refreshBadge(); respond({ ok: true }); break;

      case 'RETRY_FAILED':
        await patch(st => {
          for (const j of st.projects[msg.id].jobs) if (j.status === 'failed') {
            // Resume at the right stage: media already in hand → Element step
            // only, so a retry never re-pays for a generation.
            j.status = j.mediaUrl ? 'generated' : 'pending';
            j.attempts = 0; j.error = null;
          }
          st.cooldownUntil = 0; st.rateLimitHits = 0;
          return st;
        });
        await log(msg.id, 'Failed jobs requeued.'); respond({ ok: true }); break;

      case 'CLEAR_LOG':
        await patch(st => { st.projects[msg.id].log = []; return st; });
        respond({ ok: true }); break;

      case 'DETECT_PROJECT': {
        const det = await detectProject();
        if (det.id) respond({ ok: true, id: det.id, name: await folderName(det.id) });
        else respond({ ok: false, error: (det.seen ?? []).length
          ? 'No project id found. Checked: ' + det.seen.map(u => u.slice(0, 70)).join(' | ')
          : 'No higgsfield.ai tab is open.' });
        break;
      }

      case 'CAPTURE_ARM':    await armCapture();    respond({ ok: true }); break;
      case 'CAPTURE_DISARM': await disarmCapture(); respond({ ok: true }); break;
      case 'CAPTURE_CLEAR':
        await patch(st => { st.capture.calls = []; return st; });
        respond({ ok: true }); break;

      case 'CAPTURE_PUSH': {
        await patch(st => {
          if (!st.capture) st.capture = { armed: true, meta: null, calls: [] };
          if (msg.meta) st.capture.meta = msg.meta;
          if (msg.rec) {
            const m = msg.rec.method;
            // Mutations are never de-duplicated — that is where generation
            // submits live. Repetitive GET polling is thinned so the dump stays
            // readable.
            if (m && !['GET', 'HEAD'].includes(m)) st.capture.calls.push(msg.rec);
            else {
              const key = m + ' ' + msg.rec.url.split('?')[0] + ' ' + msg.rec.status;
              const seen = st.capture.calls.filter(c => (c.method + ' ' + c.url.split('?')[0] + ' ' + c.status) === key).length;
              if (seen < 2) st.capture.calls.push(msg.rec);
            }
            if (st.capture.calls.length > 600) st.capture.calls.shift();
          }
          return st;
        });
        respond({ ok: true }); break;
      }

      case 'CAPTURE_READ': {
        const cap = s.capture ?? { calls: [] };
        const NOISE = /clerk\.higgsfield|pricing\.higgsfield|amplitude|dd\.higgsfield|cms\.higgsfield|growthbook|\/plans|\/packages|\/publications|auto-top-ups|quizzes/i;
        const calls = (cap.calls ?? []).filter(c => !NOISE.test(c.url));
        const mutations = calls.filter(c => c.method && !['GET', 'HEAD', 'WS', 'SSE'].includes(c.method));
        respond({ ok: true,
          captureVersion: chrome.runtime.getManifest().version,
          armed: !!cap.armed, count: calls.length, mutationCount: mutations.length,
          ...(cap.meta ?? {}), calls });
        break;
      }

      case 'EXPORT_PROJECT': {
        const p = s.projects[msg.id];
        respond({ ok: !!p, data: p ? {
          exportedAt: new Date().toISOString(),
          project: { id: p.id, name: p.name },
          manifest: p.manifest,
          results: p.jobs.map(j => ({ name: j.name, status: j.status, jobId: j.jobId,
                                      elementId: j.elementId, mediaUrl: j.mediaUrl, error: j.error })),
          log: p.log
        } : null });
        break;
      }
      default: respond({ ok: false, error: 'unknown: ' + msg.type });
    }
  })();
  return true;
});
