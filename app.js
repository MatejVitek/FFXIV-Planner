/**
 * Checklist & Route Viewer - Client App with Secret GitHub Gist Two-Way Sync
 *
 * Notice: Static code is completely work-safe and game-agnostic. All plan data
 * is fetched privately from the user's authenticated Secret GitHub Gist.
 */

const STORAGE_LAST_PLAN_KEY = 'checklist_viewer_last_plan_id';
const STORAGE_BUNDLE_CACHE_KEY = 'checklist_viewer_bundle_cache';
const STORAGE_GIST_ID_KEY = 'checklist_viewer_gist_id';
const STORAGE_GIST_TOKEN_KEY = 'checklist_viewer_gist_token';
const GIST_FILENAME = 'checklist-sync-store.json';

let bundleData = { index: { latestPlanId: null, plans: [] }, plans: {} };
let currentPlan = null;
let pushTimeout = null;

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function getCredentials() {
  return {
    gistId: localStorage.getItem(STORAGE_GIST_ID_KEY) || '',
    token: localStorage.getItem(STORAGE_GIST_TOKEN_KEY) || ''
  };
}

function setCredentials(gistId, token) {
  if (gistId && token) {
    localStorage.setItem(STORAGE_GIST_ID_KEY, gistId.trim());
    localStorage.setItem(STORAGE_GIST_TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(STORAGE_GIST_ID_KEY);
    localStorage.removeItem(STORAGE_GIST_TOKEN_KEY);
  }
}

/**
 * Checks URL hash (#gist=<id>&token=<pat>) for 1-click / QR-code device pairing,
 * saves credentials to localStorage, and immediately scrubs the hash from the URL bar.
 */
function checkUrlPairingHash() {
  if (!window.location.hash || window.location.hash.length < 2) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const gist = params.get('gist');
  const token = params.get('token');
  if (gist && token) {
    setCredentials(gist, token);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  }
  return false;
}

function setSyncBadge(online, text) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text || (online ? 'Gist Synced' : 'Offline Cache');
  el.classList.toggle('offline', !online);
}

function recalculatePlanClient(plan) {
  const itemMap = new Map();
  for (const item of plan.items || []) {
    item.needed = Math.max(0, Number(item.needed ?? item.baseNeeded ?? 0));
    item.owned = Math.max(0, Number(item.owned ?? 0));
    itemMap.set(norm(item.name), item);
  }
  for (const item of plan.items || []) {
    if (!item.parentItem) {
      item.remaining = Math.max(0, item.needed - item.owned);
    }
  }
  for (let depth = 0; depth < 4; depth++) {
    for (const item of plan.items || []) {
      if (item.parentItem) {
        const parent = itemMap.get(norm(item.parentItem));
        if (parent && item.parentRatio) {
          const parentYield = Math.max(1, Number(parent.yieldPerCraft || 1));
          const craftsNeeded = Math.ceil(parent.remaining / parentYield);
          item.needed = craftsNeeded * Number(item.parentRatio) + Number(item.directNeeded || 0);
        }
        item.remaining = Math.max(0, item.needed - item.owned);
      }
    }
  }
  for (const step of plan.steps || []) {
    if (step.itemRef) {
      const linked = itemMap.get(norm(step.itemRef));
      if (linked) {
        step.currentQuantity = linked.remaining;
        if (step.actionTemplate) {
          step.action = step.actionTemplate
            .replace(/\{remaining\}/g, String(linked.remaining))
            .replace(/\{qty\}/g, String(linked.remaining))
            .replace(/\{needed\}/g, String(linked.needed))
            .replace(/\{owned\}/g, String(linked.owned));
        }
        if (linked.remaining === 0 && linked.needed > 0) {
          step.autoCompletedByInventory = true;
          step.completed = true;
        } else if (step.autoCompletedByInventory && linked.remaining > 0) {
          step.autoCompletedByInventory = false;
          step.completed = false;
        }
      }
    }
  }
  plan.updatedAt = new Date().toISOString();
  // Also update summary stats in index
  const idxEntry = (bundleData.index?.plans || []).find((p) => p.id === plan.id);
  if (idxEntry) {
    idxEntry.completedSteps = (plan.steps || []).filter((s) => s.completed).length;
    idxEntry.totalSteps = (plan.steps || []).length;
    idxEntry.updatedAt = plan.updatedAt;
  }
  return plan;
}

async function fetchFromGist() {
  const { gistId, token } = getCredentials();
  if (!gistId || !token) return false;

  setSyncBadge(true, 'Syncing...');
  try {
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!res.ok) throw new Error('Gist HTTP ' + res.status);
    const gist = await res.json();
    const fileObj = gist.files?.[GIST_FILENAME] || Object.values(gist.files || {})[0];
    if (fileObj && fileObj.content) {
      bundleData = JSON.parse(fileObj.content);
      localStorage.setItem(STORAGE_BUNDLE_CACHE_KEY, JSON.stringify(bundleData));
      setSyncBadge(true, 'Cloud Synced');
      return true;
    }
  } catch {
    const cached = localStorage.getItem(STORAGE_BUNDLE_CACHE_KEY);
    if (cached) {
      bundleData = JSON.parse(cached);
    }
    setSyncBadge(false, 'Offline Cache');
  }
  return false;
}

function schedulePushToGist() {
  localStorage.setItem(STORAGE_BUNDLE_CACHE_KEY, JSON.stringify(bundleData));
  const { gistId, token } = getCredentials();
  if (!gistId || !token) return;

  setSyncBadge(true, 'Saving...');
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(async () => {
    try {
      bundleData.syncedAt = new Date().toISOString();
      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: {
            [GIST_FILENAME]: {
              content: JSON.stringify(bundleData, null, 2)
            }
          }
        })
      });
      if (!res.ok) throw new Error('Failed Gist PATCH');
      setSyncBadge(true, 'Saved to Cloud');
    } catch {
      setSyncBadge(false, 'Saved Locally');
    }
  }, 550);
}

function parseInventoryTextClient(plan, rawText) {
  for (const item of plan.items || []) {
    const escaped = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(\\d+)\\s+items?\\s+found.*?"${escaped}"`, 'i'),
      new RegExp(`"${escaped}".*?(\\d+)\\s+items?\\s+found`, 'i'),
      new RegExp(`${escaped}\\s*[:=x×-]\\s*(\\d+)`, 'i'),
      new RegExp(`(\\d+)\\s*x?\\s*${escaped}`, 'i')
    ];
    for (const regex of patterns) {
      const m = rawText.match(regex);
      if (m && m[1] !== undefined) {
        item.owned = Number(m[1]);
        break;
      }
    }
  }
}

function selectInitialPlanId() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryPlan = urlParams.get('plan');
  const plansList = bundleData.index?.plans || [];
  const validIds = new Set(plansList.map((p) => p.id));

  if (queryPlan && validIds.has(queryPlan)) return queryPlan;

  const lastOpenedOnDevice = localStorage.getItem(STORAGE_LAST_PLAN_KEY);
  if (lastOpenedOnDevice && validIds.has(lastOpenedOnDevice)) {
    return lastOpenedOnDevice;
  }
  return bundleData.index?.latestPlanId || (plansList[0]?.id ?? null);
}

function openPlan(planId) {
  const plan = bundleData.plans?.[planId];
  if (!plan) {
    document.getElementById('plan-title').textContent = 'No Checklists Loaded';
    document.getElementById('plan-summary').textContent = 'Create or sync a plan to view it here.';
    return;
  }
  currentPlan = plan;
  localStorage.setItem(STORAGE_LAST_PLAN_KEY, plan.id);
  renderCurrentPlan();
  renderDrawerPlanList();
}

function renderDrawerPlanList() {
  const container = document.getElementById('plan-list-container');
  const q = norm(document.getElementById('plan-search-input')?.value || '');
  container.innerHTML = '';

  const list = (bundleData.index?.plans || []).filter((p) => {
    if (!q) return true;
    const fullPlan = bundleData.plans?.[p.id];
    const extraSearch = fullPlan ? JSON.stringify(fullPlan) : '';
    const hay = norm(`${p.title} ${p.summary} ${(p.tags || []).join(' ')} ${extraSearch}`);
    return hay.includes(q);
  });

  if (list.length === 0) {
    container.innerHTML = `<p class="sub-hint">No matching lists found.</p>`;
    return;
  }

  for (const item of list) {
    const div = document.createElement('div');
    div.className = `plan-card-item ${currentPlan && currentPlan.id === item.id ? 'active' : ''}`;
    const dateStr = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '';
    div.innerHTML = `
      <div class="plan-card-title">${escapeHtml(item.title)}</div>
      <div class="plan-card-meta">
        ${item.completedSteps || 0}/${item.totalSteps || 0} steps • ${item.totalItems || 0} items • ${dateStr}
      </div>
    `;
    div.addEventListener('click', () => {
      openPlan(item.id);
      toggleDrawer(false);
    });
    container.appendChild(div);
  }
}

function renderCurrentPlan() {
  if (!currentPlan) return;

  document.getElementById('plan-title').textContent = currentPlan.title || currentPlan.id;
  document.getElementById('plan-summary').textContent = currentPlan.summary || '';

  const auditBtn = document.getElementById('btn-isearch-modal');
  if ((currentPlan.items || []).length > 0) {
    auditBtn.classList.remove('hidden');
  } else {
    auditBtn.classList.add('hidden');
  }

  const tagsEl = document.getElementById('plan-tags');
  tagsEl.innerHTML = (currentPlan.tags || [])
    .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`)
    .join('');

  const steps = currentPlan.steps || [];
  const doneCount = steps.filter((s) => s.completed).length;
  const pct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;
  document.getElementById('progress-label').textContent = `${doneCount} / ${steps.length} Steps Completed`;
  document.getElementById('progress-percent').textContent = `${pct}%`;
  document.getElementById('progress-fill').style.width = `${pct}%`;

  const currEl = document.getElementById('currency-chips');
  const totals = currentPlan.currencyTotals || {};
  currEl.innerHTML = Object.entries(totals)
    .filter(([, val]) => Number(val) > 0)
    .map(([curr, val]) => `<span class="currency-chip">${escapeHtml(curr)}: ${Number(val).toLocaleString()}</span>`)
    .join('');

  const warnEl = document.getElementById('ft-warnings');
  const warnings = currentPlan.freeTrialWarnings || [];
  if (warnings.length > 0) {
    warnEl.classList.remove('hidden');
    warnEl.innerHTML = warnings.map((w) => `<div>⚠️ ${escapeHtml(w)}</div>`).join('');
  } else {
    warnEl.classList.add('hidden');
  }

  // Prerequisites
  const prereqSection = document.getElementById('prereq-section');
  const prereqList = document.getElementById('prereq-list');
  const prereqs = currentPlan.prerequisites || [];
  if (prereqs.length === 0) {
    prereqSection.classList.add('hidden');
  } else {
    prereqSection.classList.remove('hidden');
    prereqList.innerHTML = '';
    for (const pr of prereqs) {
      const li = document.createElement('li');
      li.className = pr.completed ? 'completed' : '';
      li.innerHTML = `
        <input type="checkbox" class="step-checkbox" ${pr.completed ? 'checked' : ''} />
        <span>${escapeHtml(pr.text)}</span>
      `;
      li.addEventListener('click', () => {
        pr.completed = !pr.completed;
        recalculatePlanClient(currentPlan);
        renderCurrentPlan();
        schedulePushToGist();
      });
      prereqList.appendChild(li);
    }
  }

  // Route Steps
  const stepsContainer = document.getElementById('steps-list');
  const hideCompleted = document.getElementById('chk-hide-completed')?.checked || false;
  const stepQuery = norm(document.getElementById('step-filter-input')?.value || '');
  stepsContainer.innerHTML = '';

  const filteredSteps = steps.filter((s) => {
    if (hideCompleted && s.completed) return false;
    if (!stepQuery) return true;
    const hay = norm(`${s.zone} ${s.coords} ${s.npc} ${s.action} ${s.notes || ''} ${s.aetheryte || ''}`);
    return hay.includes(stepQuery);
  });

  for (const step of filteredSteps) {
    const div = document.createElement('div');
    div.className = `step-item ${step.completed ? 'completed' : ''}`;
    const coordsText = step.coords ? `(${escapeHtml(step.coords)})` : '';
    const npcText = step.npc ? ` - <span class="step-npc">${escapeHtml(step.npc)}</span>` : '';
    div.innerHTML = `
      <input type="checkbox" class="step-checkbox" ${step.completed ? 'checked' : ''} />
      <div class="step-body">
        <div class="step-route-line">
          <span class="step-zone">[${escapeHtml(step.zone || 'General')}]</span>
          <span class="step-coords">${coordsText}</span>${npcText}
          - <span class="step-action">${escapeHtml(step.action || '')}</span>
        </div>
        <div class="step-meta">
          ${step.aetheryte ? `<span class="badge-aetheryte">✦ ${escapeHtml(step.aetheryte)}</span>` : ''}
          ${step.phase ? `<span>${escapeHtml(step.phase)}</span>` : ''}
          ${step.autoCompletedByInventory ? `<span class="badge-auto">✓ Owned in Inventory</span>` : ''}
          ${step.notes ? `<span>• ${escapeHtml(step.notes)}</span>` : ''}
        </div>
      </div>
    `;
    const checkbox = div.querySelector('.step-checkbox');
    checkbox.addEventListener('change', (e) => {
      step.completed = e.target.checked;
      step.autoCompletedByInventory = false;
      recalculatePlanClient(currentPlan);
      renderCurrentPlan();
      schedulePushToGist();
    });
    stepsContainer.appendChild(div);
  }

  // Inventory & Materials
  const invColumn = document.querySelector('.inventory-column');
  const itemsContainer = document.getElementById('items-list');
  const items = currentPlan.items || [];
  itemsContainer.innerHTML = '';

  if (items.length === 0) {
    invColumn.classList.add('hidden');
  } else {
    invColumn.classList.remove('hidden');
    for (const item of items) {
      const fulfilled = item.remaining === 0 && item.needed > 0;
      const div = document.createElement('div');
      div.className = `inv-item ${fulfilled ? 'fulfilled' : ''}`;
      div.innerHTML = `
        <div class="inv-top">
          <span class="inv-name">${escapeHtml(item.name)}</span>
          <span class="inv-counts">
            Need: ${item.needed} • Owned: ${item.owned} • <strong>Left: ${item.remaining}</strong>
          </span>
        </div>
        <div class="inv-acq">
          ${escapeHtml(item.acquisition || '')}
          ${item.parentItem ? ` <em>(for ${escapeHtml(item.parentItem)})</em>` : ''}
        </div>
        <div class="inv-controls">
          <button class="qty-btn btn-dec" aria-label="Decrease owned">−</button>
          <input type="number" class="qty-input" min="0" value="${item.owned}" aria-label="Owned quantity" />
          <button class="qty-btn btn-inc" aria-label="Increase owned">+</button>
          <button class="have-all-btn">${fulfilled ? 'Reset (0)' : `Have All (${item.needed})`}</button>
        </div>
      `;

      const input = div.querySelector('.qty-input');
      const updateQty = (newVal) => {
        item.owned = Math.max(0, Number(newVal || 0));
        recalculatePlanClient(currentPlan);
        renderCurrentPlan();
        schedulePushToGist();
      };

      div.querySelector('.btn-dec').addEventListener('click', () => updateQty(item.owned - 1));
      div.querySelector('.btn-inc').addEventListener('click', () => updateQty(item.owned + 1));
      input.addEventListener('change', (e) => updateQty(e.target.value));
      div.querySelector('.have-all-btn').addEventListener('click', () => {
        updateQty(fulfilled ? 0 : item.needed);
      });

      itemsContainer.appendChild(div);
    }
  }
}

function toggleDrawer(open) {
  const drawer = document.getElementById('plans-drawer');
  drawer.classList.toggle('hidden', !open);
  if (open) renderDrawerPlanList();
}

function toggleSetupView(showSetup) {
  document.getElementById('setup-content').style.display = showSetup ? 'block' : 'none';
  document.getElementById('main-content').style.display = showSetup ? 'none' : 'block';
  const { gistId, token } = getCredentials();
  document.getElementById('input-gist-id').value = gistId;
  document.getElementById('input-gist-token').value = token;
  document.getElementById('btn-disconnect-gist').classList.toggle('hidden', !(gistId && token));
}

function toggleIsearchModal(open) {
  const modal = document.getElementById('isearch-modal');
  modal.classList.toggle('hidden', !open);
  if (open && currentPlan) {
    const lines = [];
    for (const item of (currentPlan.items || []).slice(0, 14)) {
      lines.push(`/isearch "${item.name}"`);
    }
    document.getElementById('isearch-macro-text').textContent = lines.join('\n');
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadAndRender() {
  const { gistId, token } = getCredentials();
  if (!gistId || !token) {
    toggleSetupView(true);
    setSyncBadge(false, 'Not Paired');
    return;
  }
  toggleSetupView(false);
  await fetchFromGist();
  const initialId = selectInitialPlanId();
  openPlan(initialId);
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  checkUrlPairingHash();

  document.getElementById('btn-open-drawer').addEventListener('click', () => toggleDrawer(true));
  document.getElementById('btn-close-drawer').addEventListener('click', () => toggleDrawer(false));
  document.getElementById('drawer-backdrop').addEventListener('click', () => toggleDrawer(false));
  document.getElementById('plan-search-input').addEventListener('input', renderDrawerPlanList);

  document.getElementById('step-filter-input').addEventListener('input', renderCurrentPlan);
  document.getElementById('chk-hide-completed').addEventListener('change', renderCurrentPlan);

  document.getElementById('btn-sync-settings').addEventListener('click', () => {
    const isSetupVisible = document.getElementById('setup-content').style.display === 'block';
    toggleSetupView(!isSetupVisible);
  });

  document.getElementById('sync-status').addEventListener('click', () => loadAndRender());

  document.getElementById('btn-save-gist').addEventListener('click', async () => {
    const gId = document.getElementById('input-gist-id').value.trim();
    const gTok = document.getElementById('input-gist-token').value.trim();
    if (!gId || !gTok) return;
    setCredentials(gId, gTok);
    await loadAndRender();
  });

  document.getElementById('btn-disconnect-gist').addEventListener('click', () => {
    setCredentials('', '');
    localStorage.removeItem(STORAGE_BUNDLE_CACHE_KEY);
    toggleSetupView(true);
    setSyncBadge(false, 'Not Paired');
  });

  document.getElementById('btn-isearch-modal').addEventListener('click', () => toggleIsearchModal(true));
  document.getElementById('btn-close-modal').addEventListener('click', () => toggleIsearchModal(false));
  document.getElementById('modal-backdrop').addEventListener('click', () => toggleIsearchModal(false));

  document.getElementById('btn-copy-macro').addEventListener('click', () => {
    const txt = document.getElementById('isearch-macro-text').textContent;
    navigator.clipboard?.writeText(txt);
    document.getElementById('btn-copy-macro').textContent = 'Copied!';
    setTimeout(() => {
      document.getElementById('btn-copy-macro').textContent = 'Copy';
    }, 1500);
  });

  document.getElementById('btn-apply-isearch').addEventListener('click', () => {
    const raw = document.getElementById('isearch-paste-input').value.trim();
    if (!raw || !currentPlan) return;
    parseInventoryTextClient(currentPlan, raw);
    recalculatePlanClient(currentPlan);
    renderCurrentPlan();
    schedulePushToGist();
    document.getElementById('isearch-paste-input').value = '';
    toggleIsearchModal(false);
  });

  await loadAndRender();
}

window.addEventListener('DOMContentLoaded', init);
