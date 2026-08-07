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

// Express/Full length choice on the setup screen maps to an in-story case
// clock budget (hours), stored in game state and sent with every turn
// request so the GM can pace evidence reveal and end-game convergence
// pressure against hours remaining rather than turn count (see SPEC.md
// section 7.3).
const CLOCK_BUDGETS = { express: 48, full: 72 };

function computeAct(hoursRemaining, clockBudgetHours) {
  if (hoursRemaining <= 12) return 'act3';
  const elapsed = clockBudgetHours - hoursRemaining;
  if (elapsed < clockBudgetHours / 3) return 'act1';
  return 'act2';
}

function isClockExpired(game) {
  return !!game && typeof game.clockBudgetHours === 'number' && (game.hoursElapsed || 0) >= game.clockBudgetHours;
}

function hoursRemainingFor(game) {
  return Math.max(0, (game.clockBudgetHours || 0) - (game.hoursElapsed || 0));
}

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
  screen: 'home', // home | setup | loading | streaming | game | accusationForm | verdict | archive | archiveDetail | error
  settings: loadSettings(),
  currentGame: loadCurrentGame(),
  archive: loadArchive(),
  setupForm: null,
  accusationForm: null,
  confirmDialog: false,
  lastVerdict: null,
  archiveDetailIndex: null,
  pendingRequest: null, // { retry }
  loadingKind: 'newCase',
  streamingText: '', // standalone 'streaming' screen text (caseOpening / accusation)
  streamingTurn: null, // inline turn streaming: { text, phase: 'loading' | 'streaming' }
};

const root = document.getElementById('screen-root');
let loadingTimer = null;

/* ---------- GM network call ---------- */

// gm.mjs streams back newline-delimited JSON: any number of
// {"type":"progress"} keep-alive lines (ignored — pure liveness signal),
// any number of {"type":"narration-delta","text":"..."} lines carrying
// plain-text prose as it's decoded server-side out of the streaming JSON
// (forwarded to onNarrationDelta if provided; not every request type has
// one — newCaseCore and newCaseDetail never do), then exactly one
// {"type":"result","payload":{...}} line before the stream closes.
// Buffering and splitting on "\n" is safe even when the transport splits
// the NDJSON across multiple chunks, since we only act once a full line is
// present.
async function callGM(type, payload, onNarrationDelta) {
  try {
    const res = await fetch('/.netlify/functions/gm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ type }, payload)),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;

    const handleLine = (line) => {
      const chunk = parseNdjsonLine(line);
      if (!chunk) return;
      if (chunk.type === 'result') result = chunk.payload;
      else if (chunk.type === 'narration-delta' && onNarrationDelta) onNarrationDelta(chunk.text || '');
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    }

    handleLine(buffer.trim());

    return result || { error: 'gm_failed' };
  } catch (e) {
    return { error: 'gm_failed' };
  }
}

function parseNdjsonLine(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch (e) {
    return null;
  }
}

// Used by requests whose narration has nowhere existing to render inline
// (caseOpening: the game doesn't exist yet; accusation: the verdict screen's
// scorecard/solution/epilogue aren't available until the full envelope
// arrives). Shows the usual full-screen loading typewriter until the first
// narration delta arrives, then swaps to a standalone 'streaming' screen
// that grows the text into a case-page live. `loadingKind` lets a caller
// (case opening, chained after the skeleton call) keep the same loading
// label/lines as an earlier step instead of restarting them — defaults to
// `type` itself.
function runStreamingRequest(type, payload, onSuccess, loadingKind) {
  state.pendingRequest = { retry: () => runStreamingRequest(type, payload, onSuccess, loadingKind) };
  state.streamingText = '';
  ensureLoadingScreen(loadingKind || type);

  let switchedToStreaming = false;
  const onNarrationDelta = (deltaText) => {
    if (!switchedToStreaming) {
      switchedToStreaming = true;
      stopLoadingCycle();
      state.screen = 'streaming';
      render();
    }
    state.streamingText += deltaText;
    const el = document.getElementById('streaming-text');
    if (el) el.textContent = state.streamingText;
    else render();
  };

  callGM(type, payload, onNarrationDelta).then((data) => {
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
    case 'streaming':
      root.innerHTML = renderStreamingPage();
      break;
    case 'game':
      root.innerHTML = renderGame();
      scrollToNewestPage();
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

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Scrolls to the top of the newest case-page (the latest GM turn, or the
// in-progress streaming placeholder while one is showing) rather than to
// the bottom of the feed — landing the reader at the start of the new page,
// not past its leads or mid-page.
function scrollToNewestPage() {
  const feed = document.getElementById('turn-feed');
  if (!feed) return;
  const pages = feed.querySelectorAll('.case-page');
  const last = pages[pages.length - 1];
  if (last) {
    last.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  } else {
    feed.scrollTop = feed.scrollHeight;
  }
}

// Standalone full-screen version of the "watch the page get typed" render,
// used where there's no existing screen content to embed a live narration
// into yet: caseOpening (the game doesn't exist until this completes) and
// accusation (the verdict screen's scorecard/solution/epilogue aren't known
// until the full envelope arrives).
function renderStreamingPage() {
  const caseNumber = state.currentGame && state.currentGame.caseFile ? state.currentGame.caseFile.caseNumber : '';
  return `
    <div class="turn-feed" style="flex:1;">
      <div class="case-page">
        <span class="stamp">${caseNumber ? `Case ${esc(caseNumber)}` : 'Case File'}</span>
        <p class="narration"><span id="streaming-text"></span><span class="cursor">&nbsp;</span></p>
      </div>
    </div>
  `;
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
      length: 'express',
      tone: 'straight',
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
          <span class="label">Duration</span>
          <div class="mode-toggle">
            <button type="button" class="mode-option" data-action="select-length" data-length="express" aria-pressed="${f.length === 'express'}">
              Express
              <span class="option-hint">48 hours</span>
            </button>
            <button type="button" class="mode-option" data-action="select-length" data-length="full" aria-pressed="${f.length === 'full'}">
              Full
              <span class="option-hint">72 hours</span>
            </button>
          </div>
        </div>
        <div class="field">
          <span class="label">Tone</span>
          <div class="mode-toggle">
            <button type="button" class="mode-option" data-action="select-tone" data-tone="straight" aria-pressed="${f.tone === 'straight'}">
              Straight
              <span class="option-hint">grounded, default</span>
            </button>
            <button type="button" class="mode-option" data-action="select-tone" data-tone="dread" aria-pressed="${f.tone === 'dread'}">
              Dread
              <span class="option-hint">isolation, restraint</span>
            </button>
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

function turnEntryHtml(t, game) {
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
}

function renderClockBar(game) {
  const hoursLeft = hoursRemainingFor(game);
  const urgent = hoursLeft <= 12;
  return `
    <div class="clock-bar${urgent ? ' urgent' : ''}">
      <span>${esc(game.currentTime || '')}</span>
      <span class="clock-hours">${hoursLeft}h left</span>
    </div>
  `;
}

function renderGame() {
  const game = state.currentGame;
  if (!game) {
    state.screen = 'home';
    return renderHome();
  }
  const streaming = state.streamingTurn;
  const lastGmTurn = !streaming && [...game.turns].reverse().find((t) => t.role === 'gm');
  const leads = !streaming && lastGmTurn && Array.isArray(lastGmTurn.leads) ? lastGmTurn.leads : [];

  const feedHtml = game.turns.map((t) => turnEntryHtml(t, game)).join('');

  // While the GM's response is in flight, a placeholder card sits where the
  // next page will land: the loading typewriter until the first narration
  // delta arrives, then the growing text itself — reusing #loading-line-text
  // and #streaming-text the same way the full-screen loading/streaming
  // screens do, so startLoadingCycle() and the delta handler work unchanged.
  const streamingHtml = streaming ? `
    <div class="turn-entry">
      <div class="case-page">
        <span class="stamp">Case ${esc(game.caseFile.caseNumber || '')}</span>
        ${streaming.phase === 'loading'
          ? `<div class="loading-line"><span id="loading-line-text"></span><span class="cursor">&nbsp;</span></div>`
          : `<p class="narration"><span id="streaming-text">${esc(streaming.text)}</span><span class="cursor">&nbsp;</span></p>`}
      </div>
    </div>
  ` : '';

  return `
    <div class="game-screen" style="display:flex;flex-direction:column;flex:1;min-height:0;">
      ${renderClockBar(game)}
      <div class="turn-feed" id="turn-feed">
        ${feedHtml}
        ${streamingHtml}
        ${!streaming ? `
          <div class="leads">
            ${leads.map((lead, i) => `<button class="lead-card" data-action="select-lead" data-lead-index="${i}">${esc(lead)}</button>`).join('')}
          </div>
        ` : ''}
      </div>
      <form class="action-bar" data-action="submit-action-form">
        <input class="input" id="action-input" placeholder="What do you do?" autocomplete="off" maxlength="300" ${streaming ? 'disabled' : ''}>
        <button type="submit" class="btn btn-primary send" ${streaming ? 'disabled' : ''}>Go</button>
      </form>
      <div class="accusation-bar">
        <button class="accusation-btn" data-action="open-accusation" ${streaming ? 'disabled' : ''}>Make an Accusation</button>
      </div>
    </div>
  `;
}

function currentLeads() {
  const game = state.currentGame;
  if (!game || state.streamingTurn) return [];
  const lastGmTurn = [...game.turns].reverse().find((t) => t.role === 'gm');
  return lastGmTurn && Array.isArray(lastGmTurn.leads) ? lastGmTurn.leads : [];
}

function submitAction(actionText) {
  const text = (actionText || '').trim();
  const game = state.currentGame;
  if (!text || !game || state.streamingTurn) return;

  const recentTurns = game.turns.slice(-6);
  const turnCount = (game.turnCount || 0) + 1;
  const hoursRemaining = hoursRemainingFor(game);
  const currentAct = computeAct(hoursRemaining, game.clockBudgetHours || CLOCK_BUDGETS.full);

  game.turns.push({ role: 'players', action: text });
  saveCurrentGame(game);

  runTurnRequest({
    caseFile: game.caseFile,
    recap: game.recap,
    recentTurns,
    action: text,
    detectives: game.detectives,
    turnCount,
    clockBudgetHours: game.clockBudgetHours,
    hoursRemaining,
    currentAct,
    tone: game.tone,
  }, turnCount);
}

// Turn requests stream inline into the game screen (unlike caseOpening and
// accusation, which use the standalone 'streaming' screen) so the player's
// just-submitted action stays visible as a compact marker while the next
// page arrives — "you chose X, now watch the response" rather than cutting
// away to a generic loading takeover.
function runTurnRequest(payload, turnCount) {
  state.pendingRequest = { retry: () => runTurnRequest(payload, turnCount) };
  state.streamingTurn = { text: '', phase: 'loading' };
  state.screen = 'game';
  render();
  startLoadingCycle(LOADING_LINES.turn);

  let switchedToStreaming = false;
  const onNarrationDelta = (deltaText) => {
    if (!switchedToStreaming) {
      switchedToStreaming = true;
      stopLoadingCycle();
      state.streamingTurn.phase = 'streaming';
      render();
    }
    state.streamingTurn.text += deltaText;
    const el = document.getElementById('streaming-text');
    if (el) el.textContent = state.streamingTurn.text;
    else render();
  };

  callGM('turn', payload, onNarrationDelta).then((data) => {
    stopLoadingCycle();
    state.streamingTurn = null;
    if (!data || data.error) {
      state.screen = 'error';
      render();
      return;
    }
    onTurnSuccess(data, turnCount);
  });
}

function onTurnSuccess(data, turnCount) {
  const game = state.currentGame;
  game.turns.push({ role: 'gm', narration: data.narration, leads: data.leads || [] });
  game.recap = data.recap || game.recap;
  game.turnCount = turnCount;
  game.hoursElapsed = (game.hoursElapsed || 0) + (Number(data.hoursSpent) || 0);
  game.currentTime = data.currentTime || game.currentTime;
  saveCurrentGame(game);

  // The clock running out forces the case to resolution: the deadlineEvent
  // just happened in the narration above, so skip the normal game screen
  // (with its now-moot leads) and go straight to the accusation form, which
  // shows that same final narration inline before the fields — see
  // renderAccusationForm.
  if (isClockExpired(game)) {
    state.accusationForm = null;
    state.screen = 'accusationForm';
  } else {
    state.screen = 'game';
  }
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
  const expired = isClockExpired(game);
  const lastGmTurn = expired ? [...game.turns].reverse().find((t) => t.role === 'gm') : null;

  return `
    <div class="accusation-form">
      ${expired ? '' : '<span class="back-link" data-action="back-to-game">&larr; Back to the case</span>'}
      <div class="screen-header"><h1>Make an Accusation</h1></div>
      ${expired && lastGmTurn ? `
        <div class="case-page">
          <span class="stamp">Case ${esc(game.caseFile.caseNumber || '')}</span>
          <p class="narration">${esc(lastGmTurn.narration)}</p>
        </div>
        <p class="empty-note" style="text-align:left;font-style:normal;padding:10px 0 4px;">The clock ran out. Time to close the case.</p>
      ` : ''}
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

  runStreamingRequest('accusation', {
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
    roadsNotTaken: Array.isArray(data.roadsNotTaken) ? data.roadsNotTaken : [],
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
  const roads = Array.isArray(v.roadsNotTaken) ? v.roadsNotTaken : [];
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
      ${roads.length ? `
        <div class="roads-block">
          <h2>The Threads You Left Hanging</h2>
          <ul class="roads-list">
            ${roads.map((line) => `<li>${esc(line)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
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
      ${(entry.roadsNotTaken || []).length ? `
        <div class="roads-block">
          <h2>The Threads You Left Hanging</h2>
          <ul class="roads-list">
            ${entry.roadsNotTaken.map((line) => `<li>${esc(line)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
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
      state.screen = isClockExpired(state.currentGame) ? 'accusationForm' : 'game';
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
    case 'select-length':
      ensureSetupForm();
      state.setupForm.length = el.dataset.length;
      render();
      break;
    case 'select-tone':
      ensureSetupForm();
      state.setupForm.tone = el.dataset.tone;
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

    runNewCaseCore({
      detectives,
      flavor: f.flavor,
      tone: f.tone,
      customRequest: f.customRequest.trim(),
      length: f.length,
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

// New-case generation is split into three calls, each individually well
// under the function's timeout: a terse core caseFile (identity, cast,
// solution, clock, posture), a detail pass built on top of it (evidence,
// act plan, and — Dread only — apparent phenomena), then the narrated
// opening scene. None of the first two stream narration — the case file is
// data, never shown — only the opening does, via runStreamingRequest. All
// three stay under one continuous loading label until the opening's first
// narration delta arrives (the 'newCase' loadingKind is passed through
// explicitly so the typewriter cycle doesn't restart between steps). Each
// step retries independently: a failed detail call re-sends only itself
// against the already-generated core caseFile, it doesn't regenerate the
// core; a failed opening call doesn't regenerate either earlier step.

function runNewCaseCore(payload) {
  state.pendingRequest = { retry: () => runNewCaseCore(payload) };
  ensureLoadingScreen('newCase');

  callGM('newCaseCore', payload).then((data) => {
    // data.error covers both "gm_failed" (parse/request failure) and
    // "gm_truncated" (hit max_tokens) — both surface the same retry screen.
    if (!data || data.error || !data.caseFile) {
      stopLoadingCycle();
      state.screen = 'error';
      render();
      return;
    }
    runNewCaseDetail(payload, data.caseFile);
  });
}

function runNewCaseDetail(originalPayload, coreCaseFile) {
  state.pendingRequest = { retry: () => runNewCaseDetail(originalPayload, coreCaseFile) };
  ensureLoadingScreen('newCase');

  callGM('newCaseDetail', {
    caseFile: coreCaseFile,
    tone: originalPayload.tone,
    detectives: originalPayload.detectives,
  }).then((data) => {
    if (!data || data.error || !data.evidenceMap || !data.actPlan) {
      stopLoadingCycle();
      state.screen = 'error';
      render();
      return;
    }
    const fullCaseFile = { ...coreCaseFile, evidenceMap: data.evidenceMap, actPlan: data.actPlan };
    if (data.apparentPhenomena) fullCaseFile.apparentPhenomena = data.apparentPhenomena;
    runCaseOpening(originalPayload, fullCaseFile);
  });
}

function runCaseOpening(originalPayload, caseFile) {
  const openingPayload = { caseFile, detectives: originalPayload.detectives, tone: originalPayload.tone };
  runStreamingRequest(
    'caseOpening',
    openingPayload,
    (data) => onCaseOpeningSuccess(data, caseFile, originalPayload),
    'newCase', // keep the core/detail phases' loading label/lines, no restart
  );
}

function onCaseOpeningSuccess(data, caseFile, originalPayload) {
  const game = {
    version: 1,
    mode: 'deduction',
    createdAt: new Date().toISOString(),
    detectives: originalPayload.detectives,
    clockBudgetHours: CLOCK_BUDGETS[originalPayload.length] || CLOCK_BUDGETS.express,
    hoursElapsed: 0,
    currentTime: caseFile.caseStart || '',
    tone: originalPayload.tone || 'straight',
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
