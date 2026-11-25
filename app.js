/**
 * Checklist & Route Viewer - Client App with Secret GitHub Gist Two-Way Sync
 *
 * Features:
 *   - System Light/Dark theme adaptive UI
 *   - Archive / Unarchive & Delete lists (with tombstones synced across all devices)
 *   - Active vs Archived sections in drawer search ("Show / Search Archived Lists")
 *   - Whole-Plan, Prerequisites Section, and Per-Phase completion toggles
 *   - Automatic Completion Modal when a list reaches 100% completion
 */

const STORAGE_LAST_PLAN_KEY = 'checklist_viewer_last_plan_id';
const STORAGE_BUNDLE_CACHE_KEY = 'checklist_viewer_bundle_cache';
const STORAGE_GIST_ID_KEY = 'checklist_viewer_gist_id';
const STORAGE_GIST_TOKEN_KEY = 'checklist_viewer_gist_token';
const GIST_FILENAME = 'checklist-sync-store.json';

let bundleData = { index: { latestPlanId: null, deletedPlanIds: [], plans: [] }, plans: {} };
let currentPlan = null;
let pushTimeout = null;
let pendingDeletePlanId = null;

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
  el.textContent = text || (online ? 'Cloud Synced' : 'Offline Cache');
  el.classList.toggle('offline', !online);
}

function isPlanFullyCompleted(plan) {
  if (!plan) return false;
  const steps = plan.steps || [];
  if (steps.length === 0) return false;
  return steps.every((s) => s.completed);
}

function rebuildBundleIndexClient() {
  const allPlans = Object.values(bundleData.plans || {}).map((p) => {
    const totalSteps = Array.isArray(p.steps) ? p.steps.length : 0;
    const completedSteps = Array.isArray(p.steps) ? p.steps.filter((s) => s.completed).length : 0;
    const totalItems = Array.isArray(p.items) ? p.items.length : 0;
    return {
      id: p.id,
      title: p.title || p.id,
      summary: p.summary || '',
      tags: p.tags || [],
      archived: Boolean(p.archived),
      createdAt: p.createdAt || p.updatedAt,
      updatedAt: p.updatedAt,
      totalSteps,
      completedSteps,
      totalItems
    };
  });

  allPlans.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const activePlans = allPlans.filter((p) => !p.archived);
  const deletedIds = Array.isArray(bundleData.index?.deletedPlanIds) ? bundleData.index.deletedPlanIds : [];

  bundleData.index = {
    latestPlanId: activePlans[0]?.id || allPlans[0]?.id || null,
    deletedPlanIds: [...new Set(deletedIds)],
    updatedAt: new Date().toISOString(),
    plans: allPlans
  };
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
  rebuildBundleIndexClient();
  return plan;
}

/**
 * Wraps any user mutation on currentPlan to detect when the plan transitions
 * from incomplete (<100%) to 100% completed, triggering the completion popup!
 */
function mutateCurrentPlanWithCompletionCheck(mutatorFn) {
  if (!currentPlan) return;
  const wasCompleted = isPlanFullyCompleted(currentPlan);
  mutatorFn(currentPlan);
  recalculatePlanClient(currentPlan);
  const nowCompleted = isPlanFullyCompleted(currentPlan);

  renderCurrentPlan();
  renderDrawerPlanList();
  schedulePushToGist();

  if (!wasCompleted && nowCompleted && !currentPlan.archived) {
    showCompletionModal();
  }
}

function archivePlanById(planId, archiveState) {
  const plan = bundleData.plans?.[planId];
  if (!plan) return;
  plan.archived = Boolean(archiveState);
  plan.updatedAt = new Date().toISOString();
  rebuildBundleIndexClient();
  schedulePushToGist();

  if (currentPlan && currentPlan.id === planId) {
    renderCurrentPlan();
  }
  renderDrawerPlanList();
}

function deletePlanById(planId) {
  if (!planId) return;
  delete bundleData.plans[planId];
  if (!bundleData.index) {
    bundleData.index = { latestPlanId: null, deletedPlanIds: [], plans: [] };
  }
  if (!Array.isArray(bundleData.index.deletedPlanIds)) {
    bundleData.index.deletedPlanIds = [];
  }
  if (!bundleData.index.deletedPlanIds.includes(planId)) {
    bundleData.index.deletedPlanIds.push(planId);
  }
  rebuildBundleIndexClient();
  schedulePushToGist();

  if (currentPlan && currentPlan.id === planId) {
    currentPlan = null;
    localStorage.removeItem(STORAGE_LAST_PLAN_KEY);
    const nextId = selectInitialPlanId();
    openPlan(nextId);
  } else {
    renderDrawerPlanList();
  }
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
      rebuildBundleIndexClient();
      localStorage.setItem(STORAGE_BUNDLE_CACHE_KEY, JSON.stringify(bundleData));
      setSyncBadge(true, 'Cloud Synced');
      return true;
    }
  } catch {
    const cached = localStorage.getItem(STORAGE_BUNDLE_CACHE_KEY);
    if (cached) {
      bundleData = JSON.parse(cached);
      rebuildBundleIndexClient();
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
  }, 450);
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
    const lastPlan = bundleData.plans?.[lastOpenedOnDevice];
    if (lastPlan && !lastPlan.archived) {
      return lastOpenedOnDevice;
    }
  }
  const firstActive = plansList.find((p) => !p.archived);
  if (firstActive) return firstActive.id;
  return bundleData.index?.latestPlanId || (plansList[0]?.id ?? null);
}

function openPlan(planId) {
  const plan = planId ? bundleData.plans?.[planId] : null;
  if (!plan) {
    currentPlan = null;
    document.getElementById('plan-title').textContent = 'No Active Lists';
    document.getElementById('plan-summary').textContent =
      'Open the Lists menu (☰) to view archived lists, or ask Antigravity to create a new plan.';
    document.getElementById('badge-archived').classList.add('hidden');
    document.getElementById('plan-manage-actions').classList.add('hidden');
    document.getElementById('plan-tags').innerHTML = '';
    document.getElementById('currency-chips').innerHTML = '';
    document.getElementById('ft-warnings').classList.add('hidden');
    document.getElementById('prereq-section').classList.add('hidden');
    document.getElementById('steps-list').innerHTML = '<p class="sub-hint">No steps to display.</p>';
    document.querySelector('.inventory-column').classList.add('hidden');
    document.getElementById('progress-label').textContent = '0 / 0 Steps Completed';
    document.getElementById('progress-percent').textContent = '0%';
    document.getElementById('progress-fill').style.width = '0%';
    renderDrawerPlanList();
    return;
  }
  currentPlan = plan;
  localStorage.setItem(STORAGE_LAST_PLAN_KEY, plan.id);
  renderCurrentPlan();
  renderDrawerPlanList();
}

function createDrawerPlanCard(item) {
  const div = document.createElement('div');
  div.className = `plan-card-item ${currentPlan && currentPlan.id === item.id ? 'active' : ''}`;
  const dateStr = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '';
  const pct = item.totalSteps > 0 ? Math.round(((item.completedSteps || 0) / item.totalSteps) * 100) : 0;

  div.innerHTML = `
    <div class="plan-card-top">
      <div class="plan-card-title">${escapeHtml(item.title)}</div>
      ${item.archived ? '<span class="badge-archived">ARCHIVED</span>' : ''}
    </div>
    <div class="plan-card-meta">
      ${item.completedSteps || 0}/${item.totalSteps || 0} steps (${pct}%) • ${item.totalItems || 0} items • ${dateStr}
    </div>
    <div class="plan-card-actions">
      <button class="small-action-btn btn-card-archive">
        ${item.archived ? 'Unarchive' : 'Archive'}
      </button>
      <button class="small-action-btn danger-btn btn-card-delete">Delete</button>
    </div>
  `;

  div.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openPlan(item.id);
    toggleDrawer(false);
  });

  div.querySelector('.btn-card-archive').addEventListener('click', (e) => {
    e.stopPropagation();
    archivePlanById(item.id, !item.archived);
  });

  div.querySelector('.btn-card-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    promptDeletePlan(item.id, item.title);
  });

  return div;
}

function renderDrawerPlanList() {
  const container = document.getElementById('plan-list-container');
  const q = norm(document.getElementById('plan-search-input')?.value || '');
  const showArchived = document.getElementById('chk-show-archived')?.checked ?? true;
  container.innerHTML = '';

  const matchingPlans = (bundleData.index?.plans || []).filter((p) => {
    if (!q) return true;
    const fullPlan = bundleData.plans?.[p.id];
    const extraSearch = fullPlan ? JSON.stringify(fullPlan) : '';
    const hay = norm(`${p.title} ${p.summary} ${(p.tags || []).join(' ')} ${extraSearch}`);
    return hay.includes(q);
  });

  const activeList = matchingPlans.filter((p) => !p.archived);
  const archivedList = matchingPlans.filter((p) => p.archived);

  if (activeList.length === 0 && (!showArchived || archivedList.length === 0)) {
    const hiddenArchivedHint = !showArchived && archivedList.length > 0
      ? ` (${archivedList.length} matching archived list${archivedList.length > 1 ? 's' : ''} hidden — check "Show / Search Archived Lists" above)`
      : '';
    container.innerHTML = `<p class="sub-hint">No matching lists found${hiddenArchivedHint}.</p>`;
    return;
  }

  if (activeList.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'drawer-section-label';
    lbl.textContent = `Active Lists (${activeList.length})`;
    container.appendChild(lbl);
    for (const item of activeList) {
      container.appendChild(createDrawerPlanCard(item));
    }
  }

  if (showArchived && archivedList.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'drawer-section-label';
    lbl.textContent = `Archived Lists (${archivedList.length})`;
    container.appendChild(lbl);
    for (const item of archivedList) {
      container.appendChild(createDrawerPlanCard(item));
    }
  }
}

function renderCurrentPlan() {
  if (!currentPlan) return;

  document.getElementById('plan-manage-actions').classList.remove('hidden');
  document.getElementById('plan-title').textContent = currentPlan.title || currentPlan.id;
  document.getElementById('plan-summary').textContent = currentPlan.summary || '';

  const archivedBadge = document.getElementById('badge-archived');
  archivedBadge.classList.toggle('hidden', !currentPlan.archived);

  const btnArchive = document.getElementById('btn-archive-plan');
  btnArchive.textContent = currentPlan.archived ? 'Unarchive' : 'Archive';

  const fullyDone = isPlanFullyCompleted(currentPlan);
  const btnCompletePlan = document.getElementById('btn-complete-plan');
  btnCompletePlan.textContent = fullyDone ? '↺ Mark Plan Incomplete' : '✓ Complete Plan';

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
  const btnTogglePrereqs = document.getElementById('btn-toggle-all-prereqs');
  const prereqs = currentPlan.prerequisites || [];
  if (prereqs.length === 0) {
    prereqSection.classList.add('hidden');
  } else {
    prereqSection.classList.remove('hidden');
    const allPrereqsDone = prereqs.every((p) => p.completed);
    btnTogglePrereqs.textContent = allPrereqsDone ? '↺ Reset Prep' : '✓ Complete Prep';

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

  // Route Steps grouped by Phase with per-phase completion buttons
  const stepsContainer = document.getElementById('steps-list');
  const hideCompleted = document.getElementById('chk-hide-completed')?.checked || false;
  const stepQuery = norm(document.getElementById('step-filter-input')?.value || '');
  stepsContainer.innerHTML = '';

  // Compute phase stats across all steps in the plan
  const phaseStats = new Map();
  for (const s of steps) {
    const pName = s.phase || 'Steps';
    if (!phaseStats.has(pName)) {
      phaseStats.set(pName, { total: 0, done: 0, steps: [] });
    }
    const st = phaseStats.get(pName);
    st.total++;
    if (s.completed) st.done++;
    st.steps.push(s);
  }

  const filteredSteps = steps.filter((s) => {
    if (hideCompleted && s.completed) return false;
    if (!stepQuery) return true;
    const hay = norm(`${s.zone} ${s.coords} ${s.npc} ${s.action} ${s.notes || ''} ${s.aetheryte || ''} ${s.phase || ''}`);
    return hay.includes(stepQuery);
  });

  let lastRenderedPhase = null;

  for (const step of filteredSteps) {
    const phaseName = step.phase || 'Steps';
    if (phaseName !== lastRenderedPhase && phaseStats.size > 1) {
      lastRenderedPhase = phaseName;
      const pStat = phaseStats.get(phaseName);
      const allPhaseDone = pStat && pStat.done === pStat.total;

      const phaseBar = document.createElement('div');
      phaseBar.className = 'phase-group-header';
      phaseBar.innerHTML = `
        <span class="phase-group-title">${escapeHtml(phaseName)}</span>
        <div class="phase-group-right">
          <span class="phase-group-count">${pStat.done}/${pStat.total}</span>
          <button class="small-action-btn btn-toggle-phase">
            ${allPhaseDone ? '↺ Reset Phase' : '✓ Complete Phase'}
          </button>
        </div>
      `;
      phaseBar.querySelector('.btn-toggle-phase').addEventListener('click', () => {
        mutateCurrentPlanWithCompletionCheck(() => {
          const targetState = !allPhaseDone;
          for (const st of pStat.steps) {
            st.completed = targetState;
            if (!targetState) st.autoCompletedByInventory = false;
          }
        });
      });
      stepsContainer.appendChild(phaseBar);
    }

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
          ${step.autoCompletedByInventory ? `<span class="badge-auto">✓ Owned in Inventory</span>` : ''}
          ${step.notes ? `<span>• ${escapeHtml(step.notes)}</span>` : ''}
        </div>
      </div>
    `;
    const checkbox = div.querySelector('.step-checkbox');
    checkbox.addEventListener('change', (e) => {
      mutateCurrentPlanWithCompletionCheck(() => {
        step.completed = e.target.checked;
        step.autoCompletedByInventory = false;
      });
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
        mutateCurrentPlanWithCompletionCheck(() => {
          item.owned = Math.max(0, Number(newVal || 0));
        });
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

function showCompletionModal() {
  if (!currentPlan) return;
  document.getElementById('completion-modal-desc').textContent =
    `You have completed all steps in "${currentPlan.title}". Would you like to archive it, delete it, or leave it open?`;
  document.getElementById('completion-modal').classList.remove('hidden');
}

function hideCompletionModal() {
  document.getElementById('completion-modal').classList.add('hidden');
}

function promptDeletePlan(planId, planTitle) {
  pendingDeletePlanId = planId;
  document.getElementById('delete-modal-desc').textContent =
    `Are you sure you want to permanently delete "${planTitle || planId}" across all synced devices?`;
  document.getElementById('delete-modal').classList.remove('hidden');
}

function hideDeleteModal() {
  pendingDeletePlanId = null;
  document.getElementById('delete-modal').classList.add('hidden');
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
  document.getElementById('chk-show-archived').addEventListener('change', renderDrawerPlanList);

  document.getElementById('step-filter-input').addEventListener('input', renderCurrentPlan);
  document.getElementById('chk-hide-completed').addEventListener('change', renderCurrentPlan);

  // Plan management buttons in Summary Card
  document.getElementById('btn-complete-plan').addEventListener('click', () => {
    if (!currentPlan) return;
    const targetState = !isPlanFullyCompleted(currentPlan);
    mutateCurrentPlanWithCompletionCheck((plan) => {
      for (const pr of plan.prerequisites || []) pr.completed = targetState;
      for (const st of plan.steps || []) {
        st.completed = targetState;
        if (!targetState) st.autoCompletedByInventory = false;
      }
    });
  });

  document.getElementById('btn-archive-plan').addEventListener('click', () => {
    if (!currentPlan) return;
    archivePlanById(currentPlan.id, !currentPlan.archived);
  });

  document.getElementById('btn-delete-plan').addEventListener('click', () => {
    if (!currentPlan) return;
    promptDeletePlan(currentPlan.id, currentPlan.title);
  });

  // Prerequisites section bulk toggle
  document.getElementById('btn-toggle-all-prereqs').addEventListener('click', () => {
    if (!currentPlan || !currentPlan.prerequisites) return;
    const allDone = currentPlan.prerequisites.every((p) => p.completed);
    for (const pr of currentPlan.prerequisites) {
      pr.completed = !allDone;
    }
    recalculatePlanClient(currentPlan);
    renderCurrentPlan();
    schedulePushToGist();
  });

  // Completion Modal buttons
  document.getElementById('btn-close-completion').addEventListener('click', hideCompletionModal);
  document.getElementById('completion-backdrop').addEventListener('click', hideCompletionModal);
  document.getElementById('btn-modal-keep').addEventListener('click', hideCompletionModal);

  document.getElementById('btn-modal-archive').addEventListener('click', () => {
    if (currentPlan) {
      const archivedId = currentPlan.id;
      archivePlanById(archivedId, true);
      hideCompletionModal();
      const nextActive = (bundleData.index?.plans || []).find((p) => !p.archived && p.id !== archivedId);
      if (nextActive) openPlan(nextActive.id);
    }
  });

  document.getElementById('btn-modal-delete').addEventListener('click', () => {
    if (currentPlan) {
      const delId = currentPlan.id;
      hideCompletionModal();
      deletePlanById(delId);
    }
  });

  // Delete Confirmation Modal buttons
  document.getElementById('btn-close-delete').addEventListener('click', hideDeleteModal);
  document.getElementById('delete-backdrop').addEventListener('click', hideDeleteModal);
  document.getElementById('btn-cancel-delete').addEventListener('click', hideDeleteModal);
  document.getElementById('btn-confirm-delete').addEventListener('click', () => {
    if (pendingDeletePlanId) {
      const idToDelete = pendingDeletePlanId;
      hideDeleteModal();
      deletePlanById(idToDelete);
    }
  });

  // Cloud Sync Settings
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

  // Bulk Inventory Audit Modal
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
    mutateCurrentPlanWithCompletionCheck((plan) => {
      parseInventoryTextClient(plan, raw);
    });
    document.getElementById('isearch-paste-input').value = '';
    toggleIsearchModal(false);
  });

  await loadAndRender();
}

window.addEventListener('DOMContentLoaded', init);
