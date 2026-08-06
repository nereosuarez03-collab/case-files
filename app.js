'use strict';

/* ============================================================
   CASE FILES — Stage 1 frontend
   Vanilla JS SPA. All persistence in localStorage. The only
   network call is POST /.netlify/functions/gm.
   ============================================================ */

/* ---------- storage ---------- */

const KEYS = {
  settings: 'cf-settings',
  currentGame: 'cf-current-game',
  archive: 'cf-archive',
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable or full; nothing to do in Stage 1 */
  }
}

function loadSettings() {
  return loadJSON(KEYS.settings, { detectives: ['', ''] });
}
function saveSettings(settings) {
  saveJSON(KEYS.settings, settings);
}
function loadCurrentGame() {
  return loadJSON(KEYS.currentGame, null);
}
function saveCurrentGame(game) {
  saveJSON(KEYS.currentGame, game);
}
function clearCurrentGame() {
  try {
    localStorage.removeItem(KEYS.currentGame);
  } catch (e) {
    /* ignore */
  }
}
function loadArchive() {
  return loadJSON(KEYS.archive, []);
}
function saveArchive(archive) {
  saveJSON(KEYS.archive, archive);
}

/* ---------- utilities ---------- */

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (e) {
    return iso;
  }
}

const FLAVORS = ['Murder', 'Disappearance', 'Heist', 'Surprise us'];

const LOADING_LINES = {
  newCase: [
    'Dispatch is calling it in…',
    'Pulling the records…',
    'Sketching the scene…',
    'Naming names…',
  ],
  turn: [
    'Running it down…',
    'Working the room…',
    'Checking the log…',
    'Following up…',
  ],
  accusation: [
    'Closing the file…',
    'Calling it in…',
    'The DA is reading…',
    "Ink's drying…",
  ],
};

/* ---------- state ---------- */

const state = {
  screen: 'home', // home | setup | loading | game | accusationForm | verdict | archive | archiveDetail | error
  settings: loadSettings(),
  currentGame: loadCurrentGame(),
  archive: loadArchive(),
  setupForm: null,
  accusationForm: null,
  confirmDialog: false,
  lastVerdict: null,
  archiveDetailIndex: null,
  pendingRequest: null, // { type, payload, onSuccess }
  loadingKind: 'newCase',
};

const root = document.getElementById('screen-root');
let loadingTimer = null;

/* ---------- GM network call ---------- */

async function callGM(type, payload) {
  try {
    const res = await fetch('/.netlify/functions/gm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ type }, payload)),
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { error: 'gm_failed' };
  }
}

function runRequest(type, payload, onSuccess) {
  state.pendingRequest = { retry: () => runRequest(type, payload, onSuccess) };
  state.loadingKind = type;
  state.screen = 'loading';
  render();

  callGM(type, payload).then((data) => {
    stopLoadingCycle();
    if (!data || data.error) {
      state.screen = 'error';
      render();
      return;
    }
    onSuccess(data);
  });
}

function retryPending() {
  if (!state.pendingRequest) return;
  state.pendingRequest.retry();
}

// Puts the loading screen up (and starts its typewriter cycle) only if it
// isn't already showing, so a chained request under the same loadingKind
// doesn't reset the cycling lines mid-sequence.
function ensureLoadingScreen(kind) {
  state.loadingKind = kind;
  if (state.screen !== 'loading') {
    state.screen = 'loading';
    render();
  }
}

/* ---------- loading typewriter ---------- */

function startLoadingCycle(lines) {
  stopLoadingCycle();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lineIdx = 0;
  let charIdx = 0;
  let hold = 0;

  const node = () => document.getElementById('loading-line-text');

  if (reduced) {
    const tick = () => {
      const n = node();
      if (!n) return;
      n.textContent = lines[lineIdx % lines.length];
      lineIdx++;
    };
    tick();
    loadingTimer = setInterval(tick, 1700);
    return;
  }

  const tick = () => {
    const n = node();
    if (!n) return;
    const line = lines[lineIdx % lines.length];
    if (charIdx < line.length) {
      charIdx++;
      n.textContent = line.slice(0, charIdx);
    } else if (hold < 22) {
      hold++;
    } else {
      charIdx = 0;
      hold = 0;
      lineIdx++;
      n.textContent = '';
    }
  };
  loadingTimer = setInterval(tick, 36);
}

function stopLoadingCycle() {
  if (loadingTimer) clearInterval(loadingTimer);
  loadingTimer = null;
}

/* ---------- render dispatcher ---------- */

function render() {
  switch (state.screen) {
    case 'home':
      root.innerHTML = renderHome();
      break;
    case 'setup':
      root.innerHTML = renderSetup();
      break;
    case 'loading':
      root.innerHTML = renderLoading();
      startLoadingCycle(LOADING_LINES[state.loadingKind] || LOADING_LINES.turn);
      break;
    case 'game':
      root.innerHTML = renderGame();
      scrollFeedToBottom();
      break;
    case 'accusationForm':
      root.innerHTML = renderAccusationForm();
      break;
    case 'verdict':
      root.innerHTML = renderVerdict();
      break;
    case 'archive':
      root.innerHTML = renderArchive();
      break;
    case 'archiveDetail':
      root.innerHTML = renderArchiveDetail();
      break;
    case 'error':
      root.innerHTML = renderError();
      break;
    default:
      root.innerHTML = renderHome();
  }
  if (state.confirmDialog) {
    root.insertAdjacentHTML('beforeend', renderConfirmDialog());
  }
}

function scrollFeedToBottom() {
  const feed = document.getElementById('turn-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/* ---------- HOME ---------- */

function renderHome() {
  const hasCurrent = !!state.currentGame;
  const archiveCount = state.archive.length;
  return `
    <div class="home">
      <div>
        <div class="logo">Case <span class="mark">Files</span></div>
        <p class="tagline">Two detectives. One shared screen. A case only you can crack.</p>
      </div>
      <div class="home-actions">
        <button class="btn btn-primary btn-block" data-action="new-case">New Case</button>
        ${hasCurrent ? '<button class="btn btn-secondary btn-block" data-action="continue-case">Continue Case</button>' : ''}
        <button class="btn btn-ghost" data-action="open-archive">${archiveCount > 0 ? `Archive (${archiveCount})` : 'Archive'}</button>
      </div>
    </div>
  `;
}

/* ---------- SETUP ---------- */

function ensureSetupForm() {
  if (!state.setupForm) {
    const det = state.settings.detectives || ['', ''];
    state.setupForm = {
      det1: det[0] || '',
      det2: det[1] || '',
      flavor: 'Surprise us',
      customRequest: '',
      mode: 'deduction',
    };
  }
}

function renderSetup() {
  ensureSetupForm();
  const f = state.setupForm;
  return `
    <div class="setup-screen">
      <span class="back-link" data-action="back-home">&larr; Home</span>
      <div class="screen-header"><h1>Open a Case</h1></div>
      <form id="setup-form" data-action="submit-setup">
        <div class="field">
          <label class="label" for="det1">Detective 1</label>
          <input class="input" id="det1" name="det1" required maxlength="40" value="${esc(f.det1)}" placeholder="Name">
        </div>
        <div class="field">
          <label class="label" for="det2">Detective 2</label>
          <input class="input" id="det2" name="det2" required maxlength="40" value="${esc(f.det2)}" placeholder="Name">
        </div>
        <div class="field">
          <span class="label">Case flavor</span>
          <div class="flavor-grid">
            ${FLAVORS.map((flav) => `
              <button type="button" class="flavor-card" data-action="select-flavor" data-flavor="${esc(flav)}" aria-pressed="${f.flavor === flav}">${esc(flav)}</button>
            `).join('')}
          </div>
        </div>
        <div class="field">
          <label class="label" for="customRequest">Anything you want in this case?</label>
          <textarea class="textarea" id="customRequest" name="customRequest" maxlength="300" placeholder="Optional">${esc(f.customRequest)}</textarea>
        </div>
        <div class="field">
          <span class="label">Mode</span>
          <div class="mode-toggle">
            <button type="button" class="mode-option" data-action="select-mode" data-mode="deduction" aria-pressed="true">Deduction</button>
            <button type="button" class="mode-option" disabled aria-pressed="false">
              Branching
              <span class="coming-soon">Coming soon</span>
            </button>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Open the case file</button>
      </form>
    </div>
  `;
}

/* ---------- LOADING ---------- */

function renderLoading() {
  return `
    <div class="loading-screen">
      <span class="stamp-spin">Case ${state.loadingKind === 'newCase' ? 'opening' : state.loadingKind === 'accusation' ? 'closing' : 'in progress'}</span>
      <div class="loading-line"><span id="loading-line-text"></span><span class="cursor">&nbsp;</span></div>
    </div>
  `;
}

/* ---------- GAME (investigation loop) ---------- */

function renderGame() {
  const game = state.currentGame;
  if (!game) {
    state.screen = 'home';
    return renderHome();
  }
  const lastGmTurn = [...game.turns].reverse().find((t) => t.role === 'gm');
  const leads = lastGmTurn && Array.isArray(lastGmTurn.leads) ? lastGmTurn.leads : [];

  const feedHtml = game.turns.map((t) => {
    if (t.role === 'gm') {
      return `
        <div class="turn-entry">
          <div class="case-page">
            <span class="stamp">Case ${esc(game.caseFile.caseNumber || '')}</span>
            <p class="narration">${esc(t.narration)}</p>
          </div>
        </div>
      `;
    }
    return `
      <div class="turn-entry">
        <div class="player-note">
          <span class="who">${esc(game.detectives.join(' & '))}</span>
          ${esc(t.action)}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="game-screen" style="display:flex;flex-direction:column;flex:1;min-height:0;">
      <div class="turn-feed" id="turn-feed">
        ${feedHtml}
        <div class="leads">
          ${leads.map((lead, i) => `<button class="lead-card" data-action="select-lead" data-lead-index="${i}">${esc(lead)}</button>`).join('')}
        </div>
      </div>
      <form class="action-bar" data-action="submit-action-form">
        <input class="input" id="action-input" placeholder="What do you do?" autocomplete="off" maxlength="300">
        <button type="submit" class="btn btn-primary send">Go</button>
      </form>
      <div class="accusation-bar">
        <button class="accusation-btn" data-action="open-accusation">Make an Accusation</button>
      </div>
    </div>
  `;
}

function currentLeads() {
  const game = state.currentGame;
  if (!game) return [];
  const lastGmTurn = [...game.turns].reverse().find((t) => t.role === 'gm');
  return lastGmTurn && Array.isArray(lastGmTurn.leads) ? lastGmTurn.leads : [];
}

function submitAction(actionText) {
  const text = (actionText || '').trim();
  const game = state.currentGame;
  if (!text || !game) return;

  const recentTurns = game.turns.slice(-6);
  const turnCount = (game.turnCount || 0) + 1;

  game.turns.push({ role: 'players', action: text });
  saveCurrentGame(game);

  runRequest('turn', {
    caseFile: game.caseFile,
    recap: game.recap,
    recentTurns,
    action: text,
    detectives: game.detectives,
    turnCount,
  }, (data) => onTurnSuccess(data, turnCount));
}

function onTurnSuccess(data, turnCount) {
  const game = state.currentGame;
  game.turns.push({ role: 'gm', narration: data.narration, leads: data.leads || [] });
  game.recap = data.recap || game.recap;
  game.turnCount = turnCount;
  saveCurrentGame(game);
  state.screen = 'game';
  render();
}

/* ---------- ACCUSATION ---------- */

function ensureAccusationForm() {
  if (!state.accusationForm) {
    state.accusationForm = { killer: '', killerOther: '', method: '', motive: '' };
  }
}

function renderAccusationForm() {
  ensureAccusationForm();
  const game = state.currentGame;
  const f = state.accusationForm;
  const suspects = (game.caseFile.suspects || []).map((s) => s.name).filter(Boolean);

  return `
    <div class="accusation-form">
      <span class="back-link" data-action="back-to-game">&larr; Back to the case</span>
      <div class="screen-header"><h1>Make an Accusation</h1></div>
      <form id="accusation-form" data-action="submit-accusation-form">
        <div class="field">
          <label class="label" for="killer-select">Killer</label>
          <select class="select" id="killer-select" name="killer">
            <option value="" ${f.killer === '' ? 'selected' : ''} disabled>Choose a suspect</option>
            ${suspects.map((name) => `<option value="${esc(name)}" ${f.killer === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}
            <option value="__other__" ${f.killer === '__other__' ? 'selected' : ''}>Someone else</option>
          </select>
          <div class="someone-else-field" id="killer-other-field" style="${f.killer === '__other__' ? '' : 'display:none;'}">
            <input class="input" id="killerOther" name="killerOther" placeholder="Who?" value="${esc(f.killerOther)}">
          </div>
        </div>
        <div class="field">
          <label class="label" for="method">Method</label>
          <textarea class="textarea" id="method" name="method" required placeholder="How was it done?">${esc(f.method)}</textarea>
        </div>
        <div class="field">
          <label class="label" for="motive">Motive</label>
          <textarea class="textarea" id="motive" name="motive" required placeholder="Why?">${esc(f.motive)}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Close the Case</button>
      </form>
    </div>
  `;
}

function renderConfirmDialog() {
  return `
    <div class="dialog-overlay" data-action="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Close the case?</h2>
        <p>The DA only gives you one shot.</p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" data-action="confirm-accusation-no">Wait</button>
          <button class="btn btn-primary" data-action="confirm-accusation-yes">Close It</button>
        </div>
      </div>
    </div>
  `;
}

function submitAccusationConfirmed() {
  const game = state.currentGame;
  const f = state.accusationForm;
  const killer = f.killer === '__other__' ? f.killerOther.trim() : f.killer;

  state.confirmDialog = false;

  runRequest('accusation', {
    caseFile: game.caseFile,
    recap: game.recap,
    accusation: { killer, method: f.method.trim(), motive: f.motive.trim() },
    detectives: game.detectives,
  }, onAccusationSuccess);
}

function onAccusationSuccess(data) {
  const game = state.currentGame;
  const entry = {
    title: game.caseFile.title,
    caseNumber: game.caseFile.caseNumber,
    date: new Date().toISOString(),
    detectives: game.detectives,
    score: data.score || {},
    trueSolution: data.trueSolution || '',
    epilogue: data.epilogue || '',
    verdictNarration: data.verdictNarration || '',
  };

  const archive = loadArchive();
  archive.push(entry);
  saveArchive(archive);
  state.archive = archive;

  clearCurrentGame();
  state.currentGame = null;
  state.accusationForm = null;

  state.lastVerdict = data;
  state.screen = 'verdict';
  render();
}

/* ---------- VERDICT ---------- */

function scoreLabel(val) {
  if (val === 'correct') return 'Correct';
  if (val === 'partial') return 'Partial';
  return 'Missed';
}

function renderVerdict() {
  const v = state.lastVerdict;
  if (!v) {
    state.screen = 'home';
    return renderHome();
  }
  const score = v.score || {};
  return `
    <div class="verdict-screen">
      <div class="screen-header"><h1>Verdict</h1></div>
      <div class="case-page">
        <span class="stamp">Closed</span>
        <p class="narration">${esc(v.verdictNarration)}</p>
      </div>
      <div class="scorecard">
        <div class="score-badge" data-score="${esc(score.killer || 'missed')}">
          <span class="part">Killer</span>
          <span class="verdict-tag">${scoreLabel(score.killer)}</span>
        </div>
        <div class="score-badge" data-score="${esc(score.method || 'missed')}">
          <span class="part">Method</span>
          <span class="verdict-tag">${scoreLabel(score.method)}</span>
        </div>
        <div class="score-badge" data-score="${esc(score.motive || 'missed')}">
          <span class="part">Motive</span>
          <span class="verdict-tag">${scoreLabel(score.motive)}</span>
        </div>
      </div>
      <div class="solution-block">
        <h2>The Truth</h2>
        <p>${esc(v.trueSolution)}</p>
      </div>
      <div class="epilogue-block">
        <h2>Epilogue</h2>
        <p>${esc(v.epilogue)}</p>
      </div>
      <div class="verdict-actions">
        <button class="btn btn-primary btn-block" data-action="verdict-new-case">New Case</button>
        <button class="btn btn-secondary btn-block" data-action="verdict-back-home">Back to Home</button>
      </div>
    </div>
  `;
}

/* ---------- ARCHIVE ---------- */

function renderArchive() {
  const entries = state.archive;
  return `
    <div class="archive-screen">
      <span class="back-link" data-action="back-home">&larr; Home</span>
      <div class="screen-header"><h1>Archive</h1></div>
      ${entries.length === 0 ? '<p class="empty-note">No closed cases yet.</p>' : `
        <div class="archive-list">
          ${entries.slice().reverse().map((e, i) => {
            const realIndex = entries.length - 1 - i;
            const score = e.score || {};
            return `
              <button class="archive-item" data-action="open-archive-item" data-archive-index="${realIndex}">
                <div class="title">${esc(e.title || 'Untitled Case')}</div>
                <div class="meta">${esc(formatDate(e.date))} &middot; ${esc((e.detectives || []).join(' & '))}</div>
                <div class="badges">
                  <span data-score="${esc(score.killer)}">Killer: ${esc(scoreLabel(score.killer))}</span>
                  <span data-score="${esc(score.method)}">Method: ${esc(scoreLabel(score.method))}</span>
                  <span data-score="${esc(score.motive)}">Motive: ${esc(scoreLabel(score.motive))}</span>
                </div>
              </button>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;
}

function renderArchiveDetail() {
  const entry = state.archive[state.archiveDetailIndex];
  if (!entry) {
    state.screen = 'archive';
    return renderArchive();
  }
  return `
    <div class="archive-detail">
      <span class="back-link" data-action="archive-back">&larr; Archive</span>
      <div class="screen-header"><h1>${esc(entry.title || 'Untitled Case')}</h1></div>
      <p class="empty-note" style="text-align:left;font-style:normal;padding:0 0 14px;">${esc(formatDate(entry.date))} &middot; ${esc((entry.detectives || []).join(' & '))}</p>
      <div class="case-page">
        <span class="stamp">Case ${esc(entry.caseNumber || '')}</span>
        <p class="narration">${esc(entry.verdictNarration)}</p>
      </div>
      <div class="solution-block">
        <h2>The Truth</h2>
        <p>${esc(entry.trueSolution)}</p>
      </div>
      <div class="epilogue-block">
        <h2>Epilogue</h2>
        <p>${esc(entry.epilogue)}</p>
      </div>
    </div>
  `;
}

/* ---------- ERROR ---------- */

function renderError() {
  return `
    <div class="error-screen">
      <span class="eyebrow">Static on the radio</span>
      <p>The line dropped before the report came through. Try again?</p>
      <button class="btn btn-primary" data-action="retry-request">Try Again</button>
      <button class="btn btn-ghost" data-action="error-back-home">Back to Home</button>
    </div>
  `;
}

/* ---------- event delegation ---------- */

root.addEventListener('click', onRootClick);
root.addEventListener('submit', onRootSubmit);
root.addEventListener('input', onRootInput);
root.addEventListener('change', onRootChange);

function onRootClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'new-case':
      state.setupForm = null;
      state.screen = 'setup';
      render();
      break;
    case 'continue-case':
      state.currentGame = loadCurrentGame();
      state.screen = 'game';
      render();
      break;
    case 'open-archive':
      state.archive = loadArchive();
      state.screen = 'archive';
      render();
      break;
    case 'back-home':
      state.screen = 'home';
      render();
      break;
    case 'select-flavor':
      ensureSetupForm();
      state.setupForm.flavor = el.dataset.flavor;
      render();
      break;
    case 'select-mode':
      ensureSetupForm();
      state.setupForm.mode = el.dataset.mode;
      render();
      break;
    case 'select-lead': {
      const leads = currentLeads();
      const idx = Number(el.dataset.leadIndex);
      const lead = leads[idx];
      if (lead) submitAction(lead);
      break;
    }
    case 'open-accusation':
      state.accusationForm = null;
      state.screen = 'accusationForm';
      render();
      break;
    case 'back-to-game':
      state.screen = 'game';
      render();
      break;
    case 'confirm-accusation-yes':
      submitAccusationConfirmed();
      break;
    case 'confirm-accusation-no':
    case 'dialog-overlay':
      if (action === 'dialog-overlay' && e.target !== el) return;
      state.confirmDialog = false;
      render();
      break;
    case 'retry-request':
      retryPending();
      break;
    case 'error-back-home':
      state.pendingRequest = null;
      state.screen = 'home';
      render();
      break;
    case 'verdict-new-case':
      state.lastVerdict = null;
      state.setupForm = null;
      state.screen = 'setup';
      render();
      break;
    case 'verdict-back-home':
      state.lastVerdict = null;
      state.screen = 'home';
      render();
      break;
    case 'open-archive-item':
      state.archiveDetailIndex = Number(el.dataset.archiveIndex);
      state.screen = 'archiveDetail';
      render();
      break;
    case 'archive-back':
      state.screen = 'archive';
      render();
      break;
    default:
      break;
  }
}

function onRootSubmit(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  const action = el.dataset.action;

  if (action === 'submit-setup') {
    ensureSetupForm();
    const f = state.setupForm;
    if (!f.det1.trim() || !f.det2.trim()) return;

    const detectives = [f.det1.trim(), f.det2.trim()];
    saveSettings({ detectives });
    state.settings = { detectives };

    runNewCaseSkeleton({
      detectives,
      flavor: f.flavor,
      customRequest: f.customRequest.trim(),
    });
  } else if (action === 'submit-action-form') {
    const input = document.getElementById('action-input');
    const text = input ? input.value : '';
    if (input) input.value = '';
    submitAction(text);
  } else if (action === 'submit-accusation-form') {
    ensureAccusationForm();
    const f = state.accusationForm;
    if (!f.killer || (f.killer === '__other__' && !f.killerOther.trim())) return;
    if (!f.method.trim() || !f.motive.trim()) return;
    state.confirmDialog = true;
    render();
  }
}

function onRootInput(e) {
  const id = e.target.id;
  if (['det1', 'det2', 'customRequest'].includes(id)) {
    ensureSetupForm();
    state.setupForm[id] = e.target.value;
  } else if (id === 'killerOther') {
    ensureAccusationForm();
    state.accusationForm.killerOther = e.target.value;
  } else if (id === 'method' || id === 'motive') {
    ensureAccusationForm();
    state.accusationForm[id] = e.target.value;
  }
}

function onRootChange(e) {
  if (e.target.id === 'killer-select') {
    ensureAccusationForm();
    state.accusationForm.killer = e.target.value;
    const field = document.getElementById('killer-other-field');
    if (field) field.style.display = e.target.value === '__other__' ? '' : 'none';
    if (e.target.value === '__other__') {
      const other = document.getElementById('killerOther');
      if (other) other.focus();
    }
  }
}

// New-case generation is split into two calls to stay under the function
// timeout: a terse caseFile skeleton, then the opening scene built from it.
// Both run under one continuous loading screen (same loadingKind, so
// ensureLoadingScreen doesn't restart the typewriter cycle between them).
// Each step retries independently: a failed opening call re-sends only the
// opening request against the already-generated caseFile, it doesn't
// regenerate the skeleton.

function runNewCaseSkeleton(payload) {
  state.pendingRequest = { retry: () => runNewCaseSkeleton(payload) };
  ensureLoadingScreen('newCase');

  callGM('newCaseSkeleton', payload).then((data) => {
    if (!data || data.error || !data.caseFile) {
      stopLoadingCycle();
      state.screen = 'error';
      render();
      return;
    }
    runCaseOpening(payload, data.caseFile);
  });
}

function runCaseOpening(originalPayload, caseFile) {
  state.pendingRequest = { retry: () => runCaseOpening(originalPayload, caseFile) };
  ensureLoadingScreen('newCase');

  const openingPayload = { caseFile, detectives: originalPayload.detectives };
  callGM('caseOpening', openingPayload).then((data) => {
    stopLoadingCycle();
    if (!data || data.error) {
      state.screen = 'error';
      render();
      return;
    }
    onCaseOpeningSuccess(data, caseFile, originalPayload);
  });
}

function onCaseOpeningSuccess(data, caseFile, originalPayload) {
  const game = {
    version: 1,
    mode: 'deduction',
    createdAt: new Date().toISOString(),
    detectives: originalPayload.detectives,
    caseFile,
    recap: data.recap,
    turns: [{ role: 'gm', narration: data.openingNarration, leads: data.leads || [] }],
    turnCount: 0,
    status: 'active',
  };
  saveCurrentGame(game);
  state.currentGame = game;
  state.setupForm = null;
  state.screen = 'game';
  render();
}

/* ---------- boot ---------- */

render();
