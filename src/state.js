/* ── State model ──────────────────────────────────────────────────────────────
   Everything is keyed by project. Each project owns its own manifest, job list,
   log and batch timing, so opening one project never disturbs another and no
   log is ever overwritten by the next batch.

   All of it lives in chrome.storage.local — MV3 kills idle service workers, so
   in-memory state would vanish mid-run. */

export const EMPTY = {
  schema: 3,
  projects: {},        // id → project
  order: [],           // project ids, most-recently-used first
  runQueue: [],        // project ids waiting to run; only [0] actually runs
  activeId: null,      // project open in the popup
  view: 'list',        // 'list' | 'project'
  authState: 'unknown',
  lastAuthStatus: null,
  cooldownUntil: 0,
  rateLimitHits: 0,
  /* Endpoint capture. Global rather than per-project — it records raw API
     traffic, which is not project-scoped. */
  capture: { armed: false, meta: null, calls: [] }
};

export function newProject({ id, name }) {
  return {
    id, name: name || 'Untitled project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    folders: {},
    manifest: null,
    jobs: [],
    log: [],
    batch: { startedAt: null, finishedAt: null, durations: [] },
    archived: false
  };
}

/* Older builds stored a single project at the top level. Carry that work
   forward rather than silently discarding a batch someone was mid-way through. */
export function migrate(old) {
  if (!old || old.schema === 3) return old ?? structuredClone(EMPTY);

  const s = structuredClone(EMPTY);
  const id = old.project?.id || 'legacy-' + Date.now();
  const p = newProject({ id, name: old.project?.name || 'Imported project' });
  p.manifest = old.manifest ?? null;
  p.jobs     = old.jobs ?? [];
  p.log      = old.log ?? [];
  p.batch    = old.batch ?? p.batch;
  p.folders  = old.manifest?.folders ?? {};

  if (p.manifest || p.jobs.length) {
    s.projects[id] = p;
    s.order = [id];
    s.activeId = id;
    s.view = 'project';
  }
  s.authState = old.authState ?? 'unknown';
  return s;
}

export const jobCounts = (p) => {
  const by = st => (p.jobs || []).filter(j => j.status === st).length;
  const done = by('complete'), failed = by('failed'), waiting = by('waiting_elements') + by('waiting_ip');
  const running = by('generating') + by('generated') + by('element_created');
  return {
    total: (p.jobs || []).length,
    done, failed, running, waiting,
    queued: by('pending'),
    settled: done + failed,
    pct: (p.jobs || []).length ? Math.round(((done + failed) / p.jobs.length) * 100) : 0
  };
};
