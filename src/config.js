/* ── REAL ENDPOINTS, from the 2026-07-25 capture ──────────────────────────────
   The API is NOT on higgsfield.ai. It lives on a separate gateway host, which
   is why every earlier probe 404'd. Auth is a Clerk JWT with a ~60 SECOND
   lifetime, so tokens are minted per request rather than cached. */

export const CONFIG = {
  apiOrigin:  'https://fnf-api-gw.higgsfield.ai',
  pageOrigin: 'https://higgsfield.ai',

  endpoints: {
    // ── CONFIRMED ──────────────────────────────────────────────────────────
    createElement: { method: 'POST', path: '/fnf/v2/reference-elements' },
    getElement:    { method: 'GET',  path: '/fnf/v2/reference-elements/{id}' },
    listElements:  { method: 'GET',  path: '/fnf/v2/reference-elements/picker?size=100' },
    listInFolder:  { method: 'GET',  path: '/fnf/v2/reference-elements/picker?size=100&folder_id={folderId}&include_subfolders=true' },

    /* CONFIRMED. The MODEL IS IN THE URL PATH, hyphenated:
       nano_banana_2 → /fnf/jobs/nano-banana-2
       This is why no generic "/generate" endpoint ever showed up in a capture. */
    /* IMAGE: model in the path, hyphenated, no version segment.
         POST /fnf/jobs/nano-banana-2                                        */
    generate:      { method: 'POST', path: '/fnf/jobs/{modelSlug}' },

    /* VIDEO: different shape entirely — a /v2/ segment, and the model keeps
       its UNDERSCORES.
         POST /fnf/jobs/v2/seedance_2_0
       Guessing "seedance-2-0" is what produced the 405: it fell through to the
       GET-only /fnf/jobs/{id} route.                                        */
    generateVideo: { method: 'POST', path: '/fnf/jobs/v2/{modelKey}' },

    /* Single job with full results — simpler and more reliable than scanning a
       folder listing, and it works for both images and video.               */
    jobDetail:     { method: 'GET',  path: '/fnf/jobs/{id}?folder_id={folderId}' },

    /* CONFIRMED. Polling is batched: POST {"ids":[...]} and the response is
       {"items":[{id,status,job_set_type}],"missing":[]}.
       NOTE: status-batch reports STATUS ONLY — it carries no result URL. The
       finished image has to be read from the folder listing below. */
    jobStatus:     { method: 'POST', path: '/fnf/jobs/status-batch' },

    /* Folder items, which DO include each job's results.raw.url plus the real
       width/height. This is how a finished generation is turned into an
       Element. */
    folderItems:   { method: 'GET',  path: '/fnf/folders/{folderId}/items/v2?include_subfolders=true&size=50' },

    // Folder tree.
    listFolders:   { method: 'GET',  path: '/fnf/folders/{folderId}/children?size=100&sort_by=name' },
    listRoots:     { method: 'GET',  path: '/fnf/folders/accessible?size=100&surface=cinematic_studio&sort_by=name' },
    getFolder:     { method: 'GET',  path: '/fnf/folders/{folderId}' }
  },

  /* Sent on generation requests by the web app. */
  extraHeaders: { 'hf-surface': 'cinema_studio' },

  /* Model id → URL slug. Default rule is underscores→hyphens
     (nano_banana_2 → nano-banana-2), CONFIRMED for images.
     VIDEO SLUGS ARE UNVERIFIED — a wrong slug produces HTTP 405, because the
     request falls through to the GET-only /fnf/jobs/{id} route. Override per
     manifest with "modelSlugs": { "kling3_0_turbo": "actual-slug" } or per job
     with "modelSlug". */
  modelSlugs: {},

  /* Width/height are sent, but the SERVER OVERRIDES THEM — a request of
     2752×1536 came back as 1344×768 in the job set. So these are a best-effort
     hint, not a guarantee; resolution + aspect_ratio are what actually decide
     the output. */
  shortSide: { '1k': 768, '2k': 1536, '4k': 3072 },

  /* Clerk mints short-lived JWTs. window.Clerk.session.getToken() returns a
     fresh one and handles refresh internally — far more robust than replaying
     the /tokens endpoint ourselves. Must be called in the page's MAIN world. */
  auth: { via: 'clerk-global' },

  limits: {
    /* ONE AT A TIME by default. Higgsfield rate-limits concurrent generations
       per account, and a 429 wastes the slot without producing anything. The
       runner waits for a job to fully finish before submitting the next. */
    maxConcurrent: 1,
    submitDelayMs: 1500,
    /* 429 backoff. Not a failure — the request was refused, not rejected. */
    rateLimitBackoffMs: 45000,
    rateLimitMaxBackoffMs: 300000,
    pollIntervalSec: 30,
    maxAttempts: 5,
    elementCacheMs: 120000,
    /* How long to wait before re-trying a job blocked by an Element's pending
       IP scan. The scan usually settles in a few minutes. */
    ipRecheckMs: 300000,
    /* After this long in "generating", stop trusting the status field and go
       look at the job itself. A finished generation that the queue never
       noticed is worse than an extra request. */
    staleJobMs: 600000
  },

  statusValues: {
    /* Any of these means finished. The list is deliberately wide: an
       unrecognised terminal status leaves a job "generating" forever, which is
       exactly how a completed generation goes unnoticed. */
    done:    ['completed', 'succeeded', 'success', 'done', 'finished', 'ready', 'complete'],
    failed:  ['failed', 'error', 'cancelled'],
    // 'waiting' and 'queued' are both observed on a freshly submitted job.
    working: ['waiting', 'queued', 'pending', 'in_progress', 'processing', 'running']
  },

  modelCaps: {
    soul_2:{maxRefs:1,role:'image'}, soul_v2:{maxRefs:1,role:'image'},
    soul_cinematic:{maxRefs:1,role:'image'}, nano_banana_2:{maxRefs:6,role:'image'},
    nano_banana_flash:{maxRefs:6,role:'image'}, gpt_image_2:{maxRefs:6,role:'image'},
    seedream_v5_pro:{maxRefs:6,role:'image_references'}, seedream_v4_5:{maxRefs:6,role:'image_references'},
    flux_2:{maxRefs:6,role:'image_references'}, ms_image:{maxRefs:14,role:'image'},
    _default:{maxRefs:4,role:'image'}
  },

  builtinDefaults: {
    image: { model: 'nano_banana_2', aspect_ratio: '16:9', resolution: '2k', count: 1 },
    /* Video resolution is a PIXEL height (480p/720p/1080p/4k), not 1k/2k/4k.
       generate_audio defaults on, matching the web app — note audio costs more
       per second than silent. */
    video: { model: 'seedance_2_0', aspect_ratio: '9:16', resolution: '720p',
             duration: 5, count: 1, generate_audio: true }
  },

  /* Confirmed video job_set_types. These go in the URL verbatim. */
  /* Lengths each video model actually accepts. Anything else is a 400. */
  videoDurations: {
    seedance_2_0: [4, 8, 12], seedance_2_0_mini: [4, 8, 12],
    kling3_0: [5, 10], kling3_0_turbo: [5, 10],
    cinematic_studio_3_0: [5, 10], cinematic_studio_video_3_5: [5, 10],
    _default: [5, 10]
  },
  videoModels: ['seedance_2_0', 'seedance_2_0_mini', 'kling3_0', 'kling3_0_turbo',
                'cinematic_studio_3_0', 'cinematic_studio_video_3_5']
};

export function applyElements(prompt, ids) {
  if (!ids?.length) return prompt;
  const add = ids.filter(id => !prompt.includes(`<<<${id}>>>`)).map(id => `<<<${id}>>>`);
  return add.length ? `${add.join(' ')} ${prompt}` : prompt;
}

export const capsFor = m => CONFIG.modelCaps[m] ?? CONFIG.modelCaps._default;

export function packRefs(model, ids = []) {
  const caps = capsFor(model);
  return { medias: ids.slice(0, caps.maxRefs).map(id => ({ id, role: caps.role })),
           dropped: ids.slice(caps.maxRefs) };
}

/* Manifest-level overrides win, then the built-in map, then the default rule. */
export const modelSlug = (m, overrides = {}) =>
  overrides[m] ?? CONFIG.modelSlugs[m] ?? String(m).replace(/_/g, '-');

/* Derive pixel dimensions from an aspect ratio, keeping the short side at the
   tier's fixed value. Rounded to a multiple of 8, which every image backend
   expects. */
export function dimsFor(aspect, resolution) {
  const short = CONFIG.shortSide[resolution] ?? 1536;
  const [a, b] = String(aspect).split(':').map(Number);
  if (!a || !b) return { width: short, height: short };
  const r = a / b;
  const round8 = (n) => Math.round(n / 8) * 8;
  return r >= 1
    ? { width: round8(short * r), height: short }
    : { width: short, height: round8(short / r) };
}

/* The "unlimited" flag has been written in four different places across
   manifests — top level, inside params, and either spelling. Accept all of
   them, and fall back to the batch default, so turning it on in one place
   doesn't silently generate against credits. */
export const unlimOf = (job = {}, d = {}) =>
  job.unlimited ?? job.use_unlim ?? job.params?.unlimited ?? job.params?.use_unlim
  ?? d.unlimited ?? d.use_unlim ?? d.params?.unlimited ?? d.params?.use_unlim
  ?? false;

/* Batch-level params are a base the job's own params override. Without this a
   manifest that puts a setting in defaults.<type>.params reaches nothing. */
export const mergedParams = (job = {}, d = {}) => ({ ...(d.params ?? {}), ...(job.params ?? {}) });

export function buildImageBody(job, defaults, ctx = {}) {
  const d = defaults.image ?? {};
  const model      = job.model        ?? d.model;
  const aspect     = job.aspect_ratio ?? d.aspect_ratio;
  const resolution = job.resolution   ?? d.resolution;
  const { width, height } = dimsFor(aspect, resolution);

  const p = packRefs(model, ctx.referenceJobIds ?? []);
  // Confirmed shape: everything nests under "params", with use_unlim ALSO at
  // the top level — the web app sends it in both places.
  const useUnlim = unlimOf(job, d);
  const { unlimited, use_unlim, ...restParams } = mergedParams(job, d);

  const body = {
    params: {
      prompt: applyElements(job.prompt, ctx.elementIds),
      input_images: p.medias.map(m => m.id),
      width, height,
      batch_size: job.count ?? d.count ?? 1,
      aspect_ratio: aspect,
      is_storyboard: false,
      is_zoom_control: false,
      use_unlim: !!useUnlim,
      resolution,
      folder_id: ctx.folderId ?? null,
      ...restParams
    },
    use_unlim: !!useUnlim,
    use_seedream_bonus: false
  };
  return { body, dropped: p.dropped,
           notes: [useUnlim ? 'unlimited: on' : 'unlimited: OFF — this will use credits'],
           modelSlug: job.modelSlug ?? modelSlug(model, ctx.slugOverrides) };
}

/* Video resolutions are a different vocabulary from image ones. A manifest that
   sets one quality for the whole batch will hand video an image tier like "2k",
   which the endpoint rejects outright — so map it onto the nearest video tier
   instead of forwarding something that cannot succeed. */
const VIDEO_RES = { '480p': '480p', '540p': '540p', '720p': '720p', '1080p': '1080p',
                    '1k': '720p', '2k': '1080p', '4k': '1080p', 'hd': '720p', 'fhd': '1080p' };
export function videoRes(r, fallback = '720p') {
  const k = String(r ?? '').toLowerCase().trim();
  if (VIDEO_RES[k]) return VIDEO_RES[k];
  const n = parseInt(k, 10);
  if (n >= 1080) return '1080p';
  if (n >= 720) return '720p';
  if (n >= 480) return '480p';
  return fallback;
}

/* Video short side comes from the resolution label: 720p → 720. */
export function videoDims(aspect, resolution) {
  const short = parseInt(String(resolution), 10) || 720;
  const [a, b] = String(aspect).split(':').map(Number);
  if (!a || !b) return { width: short, height: short };
  const r = a / b;
  const round8 = n => Math.round(n / 8) * 8;
  return r >= 1 ? { width: round8(short * r), height: short }
                : { width: short, height: round8(short / r) };
}

/* CONFIRMED video body. Note how different it is from the image call:
   - everything nests under params, INCLUDING model
   - resolution is a pixel height, not a quality tier
   - medias entries are { role, data: { id, url, type } } — nested, and the
     type names the SOURCE job kind, e.g. "nano_banana_2_job"
   - top level carries use_unlim and use_free_gens                            */
export function buildVideoBody(job, defaults, ctx = {}) {
  const d = defaults.video ?? {};
  const model  = job.model ?? d.model;
  const aspect = job.aspect_ratio ?? d.aspect_ratio;
  const asked  = job.resolution ?? d.resolution;
  const res    = videoRes(asked, d.resolution ?? '720p');
  const { width, height } = videoDims(aspect, res);
  const notes  = [];
  if (String(asked).toLowerCase() !== res) notes.push(`resolution "${asked}" is an image tier — sent as ${res}`);

  /* Duration is required, and each model only accepts a fixed set of lengths. */
  const dur = Number(job.duration ?? d.duration ?? 5);
  const allowed = CONFIG.videoDurations[model] ?? CONFIG.videoDurations._default;
  const duration = allowed.includes(dur)
    ? dur
    : allowed.reduce((best, v) => Math.abs(v - dur) <= Math.abs(best - dur) ? v : best, allowed[0]);
  if (duration !== dur) notes.push(`duration ${dur}s not offered by ${model} — sent ${duration}s`);

  /* Video carries use_unlim at the TOP LEVEL only — the captured call has no
     copy inside params, so both spellings are stripped from the passthrough. */
  const useUnlim = unlimOf(job, d);
  const { unlimited, use_unlim, ...rest } = mergedParams(job, d);
  notes.push(useUnlim ? 'unlimited: on' : 'unlimited: OFF — this will use credits');

  /* The IP-check trio is NOT optional. Higgsfield runs an intellectual-property
     scan on every input media and the video endpoint refuses the job unless the
     media declares that scan finished:
        400 {"error_type":"other","text":"IP check not finished for input media"}
     Real values are used when the source job reported them; otherwise the
     confirmed defaults from the web app's own call. */
  const medias = [];
  const addMedia = (role, ref) => {
    if (!ref?.id) return;
    medias.push({ role, data: {
      id: ref.id,
      type: ref.jobSetType ? `${ref.jobSetType}_job` : 'image_job',
      url: ref.url ?? null,
      ipCheckFinished: ref.ipCheckFinished ?? true,
      ipDetected:      ref.ipDetected ?? false,
      ipStatus:        ref.ipStatus ?? 'uploaded'
    }});
  };
  addMedia('start_image', ctx.startImage);
  addMedia('end_image',   ctx.endImage);

  return {
    body: {
      params: {
        model,
        prompt: applyElements(job.prompt, ctx.elementIds),
        duration,
        batch_size: job.count ?? d.count ?? 1,
        aspect_ratio: aspect,
        resolution: res,
        bitrate_mode: 'standard',
        /* The web app sends the tier TWICE — "resolution" and "quality" carry
           the same value. Confirmed in the 2026-07-26 capture of a working
           element-referencing video. */
        quality: res,
        generate_audio: job.generate_audio ?? d.generate_audio ?? true,
        width, height,
        ...(medias.length ? { medias } : {}),
        folder_id: ctx.folderId ?? null,
        ...rest
      },
      use_unlim: !!useUnlim,
      use_free_gens: false
    },
    dropped: [],
    notes,
    modelKey: model                 // URL keeps underscores for video
  };
}

/* Confirmed shape from the capture. Note folder_id is set HERE, at creation —
   there is no separate "move to folder" call to make, and no DOM automation
   needed. That removes the most fragile part of the original design. */
/* Higgsfield caps Element names at 32 chars and rejects duplicates outright
   (409). Suffixing has to fit INSIDE the cap, so the base is trimmed to make
   room for "-12" rather than the suffix being cut off — which would just
   collide again. */
export function elementName(base, n = 0) {
  const clean = String(base ?? 'element').trim().replace(/\s+/g, '-');
  if (!n) return clean.slice(0, 32);
  const suffix = `-${n}`;
  return clean.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix;
}

/* First name in the base, base-1, base-2 … series that isn't taken. */
export function nextElementName(base, taken = new Set(), max = 200) {
  const norm = v => String(v).trim().toLowerCase();
  const has  = v => taken.has(norm(v));
  const first = elementName(base, 0);
  if (!has(first)) return first;
  for (let n = 1; n <= max; n++) {
    const c = elementName(base, n);
    if (!has(c)) return c;
  }
  return elementName(base, Date.now() % 1000);
}

export function buildElementBody(job, media, ctx = {}) {
  return {
    audio_input_id: null,
    category:    job.category ?? 'auto',
    description: job.description ?? '',
    folder_id:   ctx.folderId ?? null,
    medias: [{
      id:    media.id,
      url:   media.url,
      type:  'image_job',
      width: media.width  ?? null,
      height: media.height ?? null
    }],
    name: ctx.name ?? elementName(job.name),
    video_medias: [],
    workspace_id: ctx.workspaceId ?? null
  };
}
