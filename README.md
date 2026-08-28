# Higgsfield Autopilot — scaffold

**Not yet functional.** `src/config.js` contains placeholder endpoints. Complete Phase 0
of BUILD_PLAN.md (capture five requests in DevTools), fill them in, and it will run.

## Install
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open higgsfield.ai and sign in
4. Click the extension icon, paste your manifest, Load, Start

## Files
- `manifest.json` — MV3 config
- `src/config.js` — **the file you edit after endpoint discovery**
- `src/background.js` — queue state machine, polling, element creation, folder filing
- `src/content.js` — authenticated fetch via page cookies + DOM fallback for folders
- `src/selectors.js` — **every DOM dependency, isolated here for easy repair**
- `src/popup.html` / `popup.js` — manifest input, progress, auth banner
