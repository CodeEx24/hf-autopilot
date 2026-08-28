/* Every DOM dependency in this extension lives here and nowhere else.
   When Higgsfield ships a redesign, this is the only file you repair.
   Selectors match on visible TEXT rather than generated class names,
   because labels change far less often than CSS. */

globalThis.HF_SELECTORS = {
  text: {
    contextMenuTrigger: '…',   // the "..." button on an asset card
    createElement: 'Create Element',
    moveTo: 'Move to',
    create: 'Create',
    newFolder: 'New Folder'
  },
  fields: {
    elementName: 'input[placeholder*="Element" i], input[value="My-Element"]',
    elementDescription: 'textarea[placeholder*="description" i]',
    categoryDropdown: '[role="combobox"], select',
    locationDropdown: '[role="combobox"], select'
  },
  waitTimeoutMs: 8000
};

/* Wait for an element matching a predicate, via MutationObserver rather than
   a fixed sleep — fixed sleeps are the other big cause of flaky automation. */
globalThis.hfWaitFor = function (predicate, timeoutMs) {
  timeoutMs = timeoutMs || globalThis.HF_SELECTORS.waitTimeoutMs;
  return new Promise((resolve, reject) => {
    const found = predicate();
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const hit = predicate();
      if (hit) { obs.disconnect(); clearTimeout(t); resolve(hit); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const t = setTimeout(() => {
      obs.disconnect();
      reject(new Error('hfWaitFor timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });
};

/* Find a clickable element by its visible text. */
globalThis.hfByText = function (text, root) {
  const scope = root || document;
  const nodes = scope.querySelectorAll('button, [role="menuitem"], [role="option"], a, div');
  for (const n of nodes) {
    if (n.textContent && n.textContent.trim() === text) return n;
  }
  return null;
};
