# Manifest schema v2

The **project** is no longer part of the JSON — it lives in its own field in the
popup and persists across manifests. The JSON only describes the batch.

## Top level

| Key | Required | Notes |
|---|---|---|
| `version` | no | `2` |
| `folders` | no | Maps category → folder name. `{ "character": "Characters", "environment": "Locations", "prop": "Props" }` |
| `onMissingFolder` | no | `useProjectFolder` (default) or `create` |
| `defaults` | no | Per-type fallbacks: `defaults.image` and `defaults.video` |
| `jobs` | **yes** | Array of job objects |

## Job object

| Key | Applies to | Notes |
|---|---|---|
| `type` | both | `image` (default) or `video` |
| `name` | both | **Required. Max 32 chars**, must be unique. Spaces become hyphens. |
| `prompt` | both | **Required.** |
| `description` | both | Stored on the Element |
| `category` | both | `character` \| `environment` \| `prop` \| `auto`. **Your "location" is Higgsfield's `environment`.** |
| `elements` | both | Array of Element names or UUIDs. Injected into the prompt as `<<<uuid>>>` |
| `model` | both | Internal ID, e.g. `nano_banana_2` — not the UI label |
| `aspect_ratio` | both | `16:9`, `9:16`, `4:3`, `1:1`, `21:9` … |
| `count` | both | Results per job, 1–4 |
| `resolution` | image | `1k` \| `2k` \| `4k` |
| `duration` | video | Seconds |
| `reference` / `dependsOn` | image | Another job's `name` — its output becomes the reference image |
| `startImage` / `endImage` | video | Another job's `name` — its output becomes the first/last frame |
| `saveAsElement` | both | Defaults **true** for image, **false** for video |
| `params` | both | Model-specific extras, merged last and overriding everything: `variant`, `quality`, `model_type`, `soul_id`, `generate_audio` … |

## How `elements` works

Higgsfield injects references by embedding `<<<element_id>>>` in the prompt.
The runner looks each name up, converts it to a UUID and prepends the tokens.
If you place the tokens yourself in the prompt, it leaves the prompt alone.

```json
{ "prompt": "<<<props_pineapple-fruit>>> held in two weathered hands",
  "elements": ["props_pineapple-fruit"] }
```

## How chaining works

`reference`, `startImage` and `endImage` point at another job **by name**. That
job is scheduled first, and its finished output is passed in as media. This is
how the empty garden becomes the garden with the pineapple in it:

```json
[
  { "type": "image", "name": "location_Garden_Patch",     "prompt": "…bare centre patch…" },
  { "type": "image", "name": "location_Garden_Pineapple",
    "reference": "location_Garden_Patch",
    "prompt": "Add a mature pineapple plant rising from the bare centre patch; everything else unchanged." }
]
```

Order in the array doesn't matter — a job stays queued until its dependencies
have produced media. Circular references simply never run; the popup flags
references to jobs that don't exist.

## Validation the popup enforces

- Non-empty `jobs`
- `name` present, unique, ≤ 32 chars
- `prompt` present
- `type` ∈ image, video
- `category` valid, with a hint that "location" means `environment`
- `elements` is an array
- Video jobs don't carry `resolution`
- Every `reference` / `dependsOn` / `startImage` / `endImage` points at a real job

---

# Multiple references

There are two separate mechanisms, and they combine freely.

## 1. Multiple Elements — via the prompt

`elements` has always been a list. Each name resolves to a UUID and becomes a
`<<<uuid>>>` token in the prompt. Higgsfield supports several placeholders in
one prompt, which is how you get two characters in one shot.

```json
{ "elements": ["char_pina", "char_aling-rosa", "props_palayok-pot"],
  "prompt": "<<<char_pina>>> handing <<<props_palayok-pot>>> to <<<char_aling-rosa>>>" }
```

Place the tokens yourself for control over composition. If you don't, the
runner prepends them.

## 2. Multiple job outputs — via `reference`

`reference` and `dependsOn` now accept **a string or an array**:

```json
{ "type": "image", "name": "shot_kitchen_wide",
  "reference": ["location_Hut_Kitchen_Corner", "props_palayok-pot", "props_kalan-stove"],
  "prompt": "Wide shot of the kitchen with the pot on the stove." }
```

Each entry is another job's `name` (or a raw UUID). All of them are scheduled
first; the job stays queued until every one has produced media.

## Per-model limits — this will bite you

Models differ sharply in how many reference images they accept, and passing too
many breaks the request rather than degrading gracefully:

| Model | Max references |
|---|---|
| `soul_2`, `soul_v2`, `soul_cinematic` | **1** |
| `nano_banana_2`, `gpt_image_2` | 6 |
| `seedream_v5_pro`, `flux_2` | 6 |
| `ms_image` | 14 |
| anything else | 4 (conservative default) |

The role name also differs — Nano Banana uses `image`, Seedream and FLUX use
`image_references`. The runner picks the right one per model.

**Two guards:**

- The popup **rejects the manifest at load time** if a job passes more
  references than its model accepts, naming the job and the limit.
- If it slips through at runtime, the runner truncates and **logs exactly what
  it dropped**. It never silently discards references, because a batch that
  quietly ignored half your inputs looks like it worked.

## Start and end frames are not lists

`startImage` and `endImage` are positional roles — one frame each. Passing an
array is a validation error. Extra references on a video job go in `reference`
and ride along under the model's generic role.

## Circular references

The popup walks the dependency graph and rejects cycles, naming the loop:

```
Circular dependency: a → b → c → a
```

Without that check those jobs would sit queued forever, looking like a hang.
