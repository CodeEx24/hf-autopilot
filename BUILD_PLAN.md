# Higgsfield Autopilot — Chrome Extension Build Plan

Automates: JSON manifest in → batch generation → queue polling → Element created with title/description/category → filed into the right folder.

---

## Architecture decision

**Network-first, DOM-last.**

A content script running on `higgsfield.ai` shares the page's cookies. Any `fetch(..., { credentials: 'include' })` it makes is automatically authenticated as you — no API key, no token management. That means you can call Higgsfield's own backend endpoints directly for generation, polling and element creation, and only fall back to clicking through the UI for folder assignment, which has no known API.

Why this matters: DOM selectors break every time Higgsfield ships a release. Network calls are far more stable. Every DOM dependency you avoid is maintenance you don't pay later.

```
popup.js  ──▶  background.js (service worker)  ──▶  content.js (on higgsfield.ai)
  UI            queue state machine, alarms          authenticated fetch + DOM
```

---

## PHASE 0 — Endpoint discovery (you must do this; I cannot)

I can't see your browser's network traffic. Everything downstream depends on this step, so do it first and carefully.

Open Higgsfield, press **F12 → Network**, filter to **Fetch/XHR**, then perform each action below once and capture the request. For each: right-click the request → **Copy → Copy as fetch**, and also note the response body.

| # | Action to perform | What you're capturing |
|---|---|---|
| 1 | Just load the page while logged in | A session/auth check call — something like `/me`, `/user`, `/balance`. Used to detect logged-out state. |
| 2 | Submit one generation | Method, URL, full request body — model, aspect ratio, resolution, count, and whether the **Unlimited** toggle appears as a field |
| 3 | Wait for it to finish | The polling call, and what the status values are (`queued` / `in_progress` / `completed`) |
| 4 | ⋯ menu → **Create Element**, fill it in, Create | The element-create endpoint and body — name, description, category, and how it references the source image |
| 5 | Open the folder dropdown, then move an element into a folder | Whether folders have **any** API. This is the one I expect to come back empty. |

Paste those five back to me and I'll wire them in.

**Two things to look for specifically:**

- Does the generation request carry an `Authorization: Bearer ...` header, or is it pure cookie auth? If it's a Bearer token, find where the page stores it (localStorage / sessionStorage) — the content script will need to read it.
- Is **Unlimited** a request field or an account-level setting? If it's account-level, the extension can't toggle it and you set it once in the UI.

---

## PHASE 1 — Scaffold

Manifest V3. Already written for you in this package.

- `permissions`: `storage`, `alarms`, `scripting`, `tabs`
- `host_permissions`: `https://higgsfield.ai/*`, `https://*.higgsfield.ai/*`
- Background **service worker** — note MV3 workers get killed when idle, which is exactly why polling uses `chrome.alarms` and all state lives in `chrome.storage.local` rather than in memory.

---

## PHASE 2 — Auth gate

On startup and on every alarm tick, the content script hits the session endpoint from Phase 0 step 1.

- **200** → proceed.
- **401 / 403 / redirect to login** → set `authState = 'logged_out'`, **pause the queue** (never drop it), and the popup shows *"Not signed in to Higgsfield. Open higgsfield.ai, log in, then press Resume."*

Nothing is lost on logout — jobs stay `pending` and resume where they left off. This is what you asked for: track the user, tell them to authenticate, then proceed.

---

## PHASE 3 — Manifest intake

Paste JSON into the popup. Validate before accepting:

- `name` ≤ 32 chars (Higgsfield's limit; spaces become hyphens)
- `category` ∈ `character` | `environment` | `prop` — note **your "location" maps to Higgsfield's `environment`**
- `prompt` non-empty
- `model` / `aspect_ratio` / `resolution` / `count` fall back to `defaults` when omitted

Each job is stored with a status, so the batch is resumable:

```
pending → submitted → generating → generated → element_created → filed → complete
                                                                    ↘ failed
```

---

## PHASE 4 — Submit loop

Background pulls the next `pending` job and asks the content script to POST it. Store the returned job ID.

**Cap concurrency at 2–3.** Firing 31 generations at once will get you rate-limited or silently dropped. There's a configurable delay between submissions too.

---

## PHASE 5 — Poll loop

`chrome.alarms.create({ periodInMinutes })` — this is your "check it time by time" interval, settable in the popup. Default 30 seconds.

Chrome's alarms API has a **1-minute floor** in production builds. For sub-minute polling the worker uses a `setTimeout` chain while it's alive, with the alarm as the fallback that revives it. Both paths are in the scaffold.

Exponential backoff on network errors, max 5 attempts, then mark `failed` with the raw error preserved.

---

## PHASE 6 — Create Element

On `completed`, POST the element-create call with the finished job's ID, plus `name`, `description`, `category` from the manifest.

**Idempotency matters here.** A job that already reached `element_created` must never be retried, or you'll get duplicate elements. The state machine only ever moves forward.

---

## PHASE 7 — Folder filing (the DOM part)

Your resolution rule, implemented:

1. List existing folders.
2. Look for a category folder — `Props`, `Locations`, `Characters` (names configurable).
3. If found → file there.
4. If not found → fall back to the **project-name folder** (`Pineapple Legend`).
5. If that doesn't exist either → create it, or leave unfiled and log it. Your choice, set by `onMissingFolder`.

If Phase 0 step 5 finds a folder API, this is a clean call. If it doesn't, the scaffold's DOM path does: open the element's ⋯ menu → click **Move to** → pick the folder.

**All selectors live in `src/selectors.js` and nowhere else.** When Higgsfield ships a redesign, you fix one file. The selectors match on **visible text** (`Move to`, `Create Element`) rather than CSS class names, because generated class names change constantly while button labels rarely do. Every step waits on a `MutationObserver` with a timeout instead of a fixed `sleep`.

---

## PHASE 8 — Safety rails

- **Credit preflight.** Before a batch, estimate cost and show it. 31 assets at 4 credits is 124; a fat-fingered `count: 4` makes that 496. The popup asks for confirmation above a threshold you set.
- **Kill switch** — Stop button halts immediately, in-flight jobs are left recoverable.
- **Failure log** with raw errors, exportable.
- **No silent truncation** — if the runner skips something, it says so.

---

## Things to be aware of

**Terms of service.** Automating a web app can conflict with its terms. Worth reading Higgsfield's before you run this at scale — I don't know what they say.

**MV3 service workers are killed aggressively.** This is the single most common reason homemade automation extensions "randomly stop." All state is in `chrome.storage.local` precisely so a killed worker resumes cleanly. Don't refactor state into module-level variables.

**Selector rot is when, not if.** Budget for occasional repairs to `selectors.js`.

---

## Manifest format

```json
{
  "project": "Pineapple Legend",
  "folders": { "character": "Characters", "environment": "Locations", "prop": "Props" },
  "onMissingFolder": "useProjectFolder",
  "defaults": {
    "model": "nano_banana_2",
    "aspect_ratio": "16:9",
    "resolution": "2k",
    "count": 1
  },
  "jobs": [
    {
      "name": "props_palayok-pot",
      "category": "prop",
      "description": "Soot-blackened terracotta cooking pot with two lug handles and a matching lid.",
      "prompt": "Prop turnaround reference sheet. FOUR VIEWS arranged side by side..."
    },
    {
      "name": "location_Barrio_Path",
      "category": "environment",
      "resolution": "4k",
      "description": "Dusty red-earth village footpath between stilted nipa huts.",
      "prompt": "Environment reference plate, EXTERIOR. COMPOSITION: WIDE ESTABLISHING SHOT..."
    }
  ]
}
```

Model IDs are the **internal** names, not the UI labels — Nano Banana Pro is `nano_banana_2`.

---

## What I need from you to finish this

The five captured requests from Phase 0. Until those land, `src/config.js` has placeholder endpoints and the extension will load and run its state machine but every network call will 404.

Send them and I'll fill in `config.js`, wire the real request bodies, and hand you a working build.
