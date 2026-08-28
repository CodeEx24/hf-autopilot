const $ = id => document.getElementById(id);
const call = msg => chrome.runtime.sendMessage(msg);

let logExpanded = false, logVisible = true;

/* Read state straight from storage. Messaging a sleeping MV3 service worker
   returns nothing, which is how the popup used to come up blank. */
async function readState() {
  try { const { state } = await chrome.storage.local.get('state'); if (state) return state; } catch {}
  return await call({ type: 'GET_STATE' });
}

const fmtDur = ms => {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const ago = t => t ? fmtDur(Date.now() - t) + ' ago' : 'never';

const counts = p => {
  const by = st => (p.jobs || []).filter(j => j.status === st).length;
  const done = by('complete'), failed = by('failed'), waiting = by('waiting_elements') + by('waiting_ip');
  const running = by('generating') + by('generated') + by('element_created');
  const total = (p.jobs || []).length;
  return { total, done, failed, running, waiting, queued: by('pending'),
           settled: done + failed, pct: total ? Math.round(((done + failed) / total) * 100) : 0 };
};

/* Log lines and job errors contain raw prompt text — which contains
   <<<element_id>>>. Dropped into innerHTML the browser parses <element_id> as a
   tag and swallows it, so "<<<abc>>>" displayed as "<<>>". Escape everything
   that comes from state. */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const extractId = t => (String(t || '').match(UUID_RE) ?? [null])[0];

function showErr(lines) {
  const b = $('errBanner');
  if (!lines?.length) { b.style.display = 'none'; return; }
  b.innerHTML = '<b>Problem</b><br>' + lines.slice(0, 12).join('<br>');
  b.style.display = 'block';
}

/* ── Project list ───────────────────────────────────────────────────────── */
function renderList(s) {
  const ids = s.order.filter(id => s.projects[id]);
  if (!ids.length) {
    $('projects').innerHTML =
      `<div class="empty">No projects yet.<br><span style="font-size:11px">Add one to start batching jobs.</span></div>`;
  } else {
    $('projects').innerHTML = ids.map(id => {
      const p = s.projects[id], c = counts(p);
      const qpos = s.runQueue.indexOf(id);
      const pill = p.paused && qpos > -1 ? '<span class="pill queue">paused</span>'
                 : qpos === 0 ? '<span class="pill run">running</span>'
                 : qpos > 0   ? `<span class="pill queue">queued #${qpos}</span>`
                 : c.failed   ? '<span class="pill fail">has failures</span>'
                 : c.total && c.settled === c.total ? '<span class="pill">done</span>'
                 : '<span class="pill">idle</span>';
      return `<div class="card" data-open="${id}">
        <div class="top"><span class="nm">${p.name}</span>${pill}</div>
        ${c.total ? `<div class="bar"><div style="width:${c.pct}%;background:${c.failed ? '#ff9a9a' : '#CDFF00'}"></div></div>` : ''}
        <div class="meta">
          <span>${c.total ? `${c.settled}/${c.total} done` : 'no jobs yet'}</span>
          ${c.failed ? `<span class="s-failed">${c.failed} failed</span>` : ''}
          <span>${(p.log || []).length} log lines</span>
          <span>updated ${ago(p.updatedAt)}</span>
        </div>
        <div class="acts">
          <button data-jobs="${id}">Create jobs</button>
          <button data-logs="${id}">View logs</button>
          ${qpos > -1
              ? (p.paused
                  ? `<button data-resume="${id}">Resume</button>`
                  : `<button data-pause="${id}">Pause</button>`)
              : `<button data-start="${id}" ${p.manifest ? '' : 'disabled'}>Start</button>`}
          ${qpos > -1 ? `<button data-stop="${id}">Stop</button>` : ''}
          <button class="danger" data-del="${id}">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  const q = s.runQueue.filter(id => s.projects[id]);
  $('globalQueue').textContent = q.length > 1
    ? `Run queue: ${q.map(id => s.projects[id].name).join(' → ')} · one project runs at a time`
    : (q.length === 1 ? 'One project running.' : '');
}

/* ── Project detail ─────────────────────────────────────────────────────── */
function renderProject(s) {
  const p = s.projects[s.activeId];
  if (!p) return;
  $('title').textContent = p.name;
  if (document.activeElement !== $('projName')) $('projName').value = p.name ?? '';
  if (document.activeElement !== $('projId'))   $('projId').value   = p.id?.startsWith('local-') ? '' : p.id;

  const c = counts(p);
  const qpos = s.runQueue.indexOf(p.id);
  $('subtitle').textContent = qpos === 0 ? 'running' : qpos > 0 ? `queued #${qpos}` : 'idle';

  if (!c.total) $('counts').innerHTML = '';
  else {
    const durs = p.batch?.durations ?? [];
    const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    const remaining = c.total - c.settled;
    const elapsed = p.batch?.startedAt ? fmtDur((p.batch.finishedAt ?? Date.now()) - p.batch.startedAt) : '—';
    const cool = Math.max(0, (s.cooldownUntil ?? 0) - Date.now());
    $('counts').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline">
         <b style="font-size:13px;color:#e8e8ea">${c.settled} / ${c.total} done</b><span>${c.pct}%</span></div>
       <div style="height:6px;background:#26262b;border-radius:3px;overflow:hidden;margin:5px 0">
         <div style="height:100%;width:${c.pct}%;background:${c.failed ? 'linear-gradient(90deg,#CDFF00,#ff7a7a)' : '#CDFF00'};transition:width .3s"></div></div>
       <div style="display:flex;gap:10px;flex-wrap:wrap">
         <span class="s-complete">✓ ${c.done} complete</span>
         ${c.running ? `<span class="s-generating">◐ ${c.running} running</span>` : ''}
         ${c.queued ? `<span class="s-pending">· ${c.queued} queued</span>` : ''}
         ${c.waiting ? `<span class="s-waiting_elements">⏸ ${c.waiting} waiting on Elements</span>` : ''}
         ${c.failed ? `<span class="s-failed">✕ ${c.failed} failed</span>` : ''}
       </div>
       <div style="margin-top:3px;color:#6a6a72">elapsed ${elapsed}${avg ? ` · avg ${fmtDur(avg)}/job` : ''}${remaining && avg ? ` · ~${fmtDur(avg * remaining)} left` : ''}</div>
       ${cool > 0 ? `<div style="margin-top:4px;color:#e8c95a">⏳ rate limited — resuming in ${Math.ceil(cool / 1000)}s</div>` : ''}`;
  }

  $('jobs').innerHTML = (p.jobs || []).map(j =>
    `<tr><td class="t">${esc(j.type ?? 'image')}</td><td>${esc(j.name)}</td>
     <td class="s-${esc(j.status)}">${j.status === 'waiting_elements' ? 'needs element' : j.status === 'waiting_ip' ? 'IP scan pending' : esc(j.status)}</td>
     <td class="err" style="color:${j.status.startsWith('waiting') ? '#7fb4ff' : '#ff7a7a'}" title="${esc(j.error)}">${esc((j.error || '').slice(0, 40))}</td></tr>`).join('');

  const all = p.log || [];
  const shown = logExpanded ? all.slice(0, 100) : all.slice(0, 5);
  $('log').innerHTML = shown.map(l =>
    `<div><span style="color:#5a5a62">${esc(l.t.slice(11, 19))}</span> <span style="${
      l.level === 'error' ? 'color:#ff7a7a' : l.level === 'warn' ? 'color:#e8c95a' : ''}">${esc(l.msg)}</span></div>`
  ).join('') || '<div style="color:#5a5a62">nothing yet</div>';
  $('logLabel').textContent = all.length ? `Log · showing ${shown.length} of ${all.length}` : 'Log';
  $('logMore').textContent = logExpanded ? 'show less' : 'show more';
  $('logMore').style.display = all.length > 5 ? '' : 'none';

  const queued = qpos > -1;
  $('start').style.display  = queued ? 'none' : '';
  $('pause').style.display  = queued && !p.paused ? '' : 'none';
  $('resume').style.display = queued &&  p.paused ? '' : 'none';
  $('start').disabled = !p.manifest;
  $('stop').disabled  = !queued;
  $('sync').disabled  = !(p.jobs || []).some(j => ['generating', 'generated', 'waiting_elements', 'waiting_ip'].includes(j.status));
  $('retry').disabled = !(p.jobs || []).some(j => j.status === 'failed');
  if (p.paused) $('subtitle').textContent = 'paused';
}

async function render() {
  const s = await readState();
  if (!s) return;

  const banners = {
    no_tab: ['warn', 'No <b>higgsfield.ai</b> tab is open. Open one and leave it open.'],
    logged_out: ['warn', 'Not signed in to Higgsfield. Log in, then press Start — queues are preserved.']
  };
  const ab = $('authBanner');
  if (banners[s.authState] && s.runQueue.length) {
    const [cls, html] = banners[s.authState];
    ab.className = 'banner ' + cls; ab.innerHTML = html; ab.style.display = 'block';
  } else ab.style.display = 'none';

  const listView = s.view !== 'project' || !s.projects[s.activeId];
  $('viewList').style.display = listView ? '' : 'none';
  $('viewProject').style.display = listView ? 'none' : '';
  $('back').style.display = listView ? 'none' : '';
  if (listView) {
    refreshCapture();
    $('title').textContent = 'Higgsfield Autopilot';
    $('subtitle').textContent = `${Object.keys(s.projects).length} project(s)`;
    renderList(s);
  } else renderProject(s);
}

/* ── Actions ────────────────────────────────────────────────────────────── */
const active = async () => (await readState()).activeId;

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.start) { const r = await call({ type: 'START', id: d.start }); if (!r.ok) showErr([r.error]); }
  else if (d.pause)  await call({ type: 'PAUSE',  id: d.pause });
  else if (d.resume) { b.textContent = 'syncing…'; await call({ type: 'RESUME', id: d.resume }); }
  else if (d.stop)  await call({ type: 'STOP', id: d.stop });
  else if (d.del)   { if (confirm('Delete this project and its logs?')) await call({ type: 'DELETE_PROJECT', id: d.del }); }
  else if (d.jobs || d.logs) await call({ type: 'OPEN_PROJECT', id: d.jobs || d.logs });
  else return;
  e.stopPropagation(); render();
});

document.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-open]');
  if (card && !e.target.closest('button')) { await call({ type: 'OPEN_PROJECT', id: card.dataset.open }); render(); }
});

$('back').onclick = async () => { await call({ type: 'SET_VIEW', view: 'list' }); render(); };

/* ── Endpoint capture ────────────────────────────────────────────────────── */
$('capArm').onclick    = async () => { await call({ type: 'CAPTURE_ARM' });    capStatus('armed — now use the site'); };
$('capDisarm').onclick = async () => { await call({ type: 'CAPTURE_DISARM' }); capStatus('disarmed'); };
$('capClear').onclick  = async () => { await call({ type: 'CAPTURE_CLEAR' });  capStatus('cleared'); };

$('capCopy').onclick = async () => {
  const r = await call({ type: 'CAPTURE_READ' });
  if (!r?.ok) return capStatus('nothing captured');
  const json = JSON.stringify(r, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    capStatus(`v${r.captureVersion} · ${r.count} calls · ${r.mutationCount} POST — copied`);
  } catch {
    // Clipboard writes can be blocked in popups; fall back to a download.
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    chrome.downloads?.download({ url, filename: 'hf-capture.json' });
    capStatus(`${r.count} calls downloaded as hf-capture.json`);
  }
  if (!r.mutationCount) capStatus('No POST captured — arm, then submit a generation before copying.');
};

function capStatus(t) { $('capInfo').textContent = t; }

async function refreshCapture() {
  const box = $('capBox');
  if (!box || !box.open) return;
  const r = await call({ type: 'CAPTURE_READ' });
  if (r?.ok && !$('capInfo').textContent.includes('copied'))
    capStatus(r.armed ? `armed · ${r.count} calls · ${r.mutationCount} POST`
                      : (r.count ? `idle · ${r.count} captured` : 'not armed'));
}

$('addProject').onclick = async () => {
  const name = prompt('Project name') || 'Untitled project';
  await call({ type: 'ADD_PROJECT', name });
  render();
};

$('addFromTab').onclick = async () => {
  const r = await call({ type: 'DETECT_PROJECT' });
  if (!r?.ok) return showErr([r?.error ?? 'Could not detect a project.']);
  showErr([]);
  await call({ type: 'ADD_PROJECT', id: r.id, name: r.name || 'Detected project' });
  render();
};

function normaliseId() {
  const raw = $('projId').value.trim();
  if (!raw) return;
  const id = extractId(raw);
  if (id && id !== raw) { $('projId').value = id; $('projSaved').textContent = 'id extracted'; setTimeout(() => $('projSaved').textContent = '', 1800); }
}
$('projId').addEventListener('paste', () => setTimeout(normaliseId, 0));
$('projId').addEventListener('blur', normaliseId);

$('saveProj').onclick = async () => {
  normaliseId();
  const id = await active();
  const newId = $('projId').value.trim();
  await call({ type: 'RENAME_PROJECT', id, name: $('projName').value.trim() });
  // Changing the id means creating the real project entry and moving to it.
  if (newId && newId !== id) {
    const st = await readState();
    await call({ type: 'ADD_PROJECT', id: newId, name: $('projName').value.trim() });
    if (st.projects[id]?.manifest)
      await call({ type: 'LOAD_MANIFEST', id: newId, manifest: st.projects[id].manifest });
    await call({ type: 'DELETE_PROJECT', id });
  }
  $('projSaved').textContent = 'saved'; setTimeout(() => $('projSaved').textContent = '', 1600);
  render();
};

$('detectProj').onclick = async () => {
  const r = await call({ type: 'DETECT_PROJECT' });
  if (!r?.ok) return showErr([r?.error ?? 'Could not detect.']);
  showErr([]);
  $('projId').value = r.id;
  if (r.name) $('projName').value = r.name;
  $('projSaved').textContent = 'detected — press Save'; setTimeout(() => $('projSaved').textContent = '', 2500);
};

const VALID_TYPE = ['image', 'video'], VALID_CAT = ['character', 'environment', 'prop', 'auto'];
function validate(m) {
  const errs = []; const seen = new Set();
  if (!Array.isArray(m.jobs) || !m.jobs.length) errs.push('manifest needs a non-empty "jobs" array');
  (m.jobs || []).forEach((j, i) => {
    const at = `job[${i}]${j.name ? ` "${j.name}"` : ''}`;
    if (!j.name) errs.push(`${at}: missing "name"`);
    else { if (j.name.length > 32) errs.push(`${at}: name is ${j.name.length} chars, max 32`);
           if (seen.has(j.name)) errs.push(`${at}: duplicate name`); seen.add(j.name); }
    if (!j.prompt) errs.push(`${at}: missing "prompt"`);
    const t = (j.type ?? 'image').toLowerCase();
    if (!VALID_TYPE.includes(t)) errs.push(`${at}: type must be image or video`);
    if (j.category && !VALID_CAT.includes(j.category))
      errs.push(`${at}: category must be one of ${VALID_CAT.join(', ')} — a location is "environment"`);
    if (t === 'video' && j.resolution) errs.push(`${at}: video jobs use "duration", not "resolution"`);
  });
  return errs;
}

$('load').onclick = async () => {
  let m; try { m = JSON.parse($('manifest').value); }
  catch (e) { return showErr(['Invalid JSON — ' + e.message]); }
  const errs = validate(m); if (errs.length) return showErr(errs);
  showErr([]);
  await call({ type: 'LOAD_MANIFEST', id: await active(), manifest: m });
  $('manifest').value = '';
  render();
};

$('exportProj').onclick = async () => {
  const r = await call({ type: 'EXPORT_PROJECT', id: await active() });
  if (!r?.ok) return showErr(['Nothing to export.']);
  const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  chrome.downloads?.download({ url, filename: `${r.data.project.name.replace(/\W+/g, '-')}-export.json` })
    ?? window.open(url);
};

$('start').onclick = async () => { const r = await call({ type: 'START', id: await active() }); if (!r.ok) showErr([r.error]); render(); };
$('stop').onclick  = async () => { await call({ type: 'STOP', id: await active() }); render(); };

$('pause').onclick = async () => { await call({ type: 'PAUSE', id: await active() }); render(); };

/* Resume reconciles first: whatever Higgsfield finished during the pause is
   collected before anything new is submitted. */
$('resume').onclick = async () => {
  $('resume').textContent = 'syncing…'; $('resume').disabled = true;
  const r = await call({ type: 'RESUME', id: await active() });
  $('resume').textContent = 'Resume'; $('resume').disabled = false;
  if (r?.ok) showErr([]);
  render();
};

$('sync').onclick = async () => {
  $('sync').textContent = 'syncing…'; $('sync').disabled = true;
  const r = await call({ type: 'SYNC', id: await active() });
  $('sync').textContent = 'Sync now';
  if (r?.ok && !r.polled && !r.made) showErr(['Nothing changed — no finished jobs to collect yet.']);
  else showErr([]);
  render();
};
$('retry').onclick = async () => { await call({ type: 'RETRY_FAILED', id: await active() }); render(); };
$('logClear').onclick = async () => { if (confirm('Clear this project\'s log?')) { await call({ type: 'CLEAR_LOG', id: await active() }); render(); } };
$('logMore').onclick = () => { logExpanded = !logExpanded; render(); };
$('logToggle').onclick = () => {
  logVisible = !logVisible;
  $('log').classList.toggle('collapsed', !logVisible);
  $('logToggle').textContent = logVisible ? 'hide' : 'show';
};

render();
setInterval(render, 2000);
