// Regression test for the free-text action pipeline (Stage 1.5 patch, item 5).
//
// A playtest reported the "What do you do?" box appearing to be ignored.
// The frontend plumbing turned out to already send it correctly; this test
// locks that contract in place so it can't silently regress: a free-text
// action must be sent verbatim as the turn's `action`, persisted verbatim
// in game state, and produce a narration that engages with it.
//
// This repo has no package.json-driven build step by design (see SPEC.md
// section 1) — that constraint is about the deployed app, not dev tooling,
// so this test's dependency (Playwright) is declared in package.json at
// the repo root as a devDependency only.
//
// Run:  npm install && node tests/free-text-action.test.mjs
//   or: npm run test:free-text

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PORT = 8811;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const CORE = {
  caseFile: {
    caseNumber: '26-TEST',
    title: 'The Test Fixture Case',
    setting: 'A quiet office',
    victim: { name: 'Victim', age: 40, description: 'x' },
    suspects: [{ name: 'Suspect One', age: 35, relation: 'Colleague', motive: 'm', alibi: 'a', secret: 's', isCulprit: true }],
    solution: { killer: 'Suspect One', accomplice: null, method: 'm', motive: 'm', timeline: 't' },
    posture: 'passive',
    caseStart: 'Day 1, 9:00 PM',
    deadlineEvent: 'The suspect skips town.',
  },
};

const DETAIL = {
  evidenceMap: [{ clue: 'c', location: 'l', pointsTo: 'p', redHerring: false }],
  actPlan: { act1: 'a1', act2: 'a2', act3: 'a3' },
};

let lastTurnRequestBody = null;

function ndjson(payload) {
  return `${JSON.stringify({ type: 'progress' })}\n${JSON.stringify({ type: 'result', payload })}\n`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/.netlify/functions/gm') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (parsed.type === 'newCaseCore') {
        res.end(ndjson(CORE));
      } else if (parsed.type === 'newCaseDetail') {
        res.end(ndjson(DETAIL));
      } else if (parsed.type === 'caseOpening') {
        res.end(ndjson({ openingNarration: 'The office is quiet. A body lies by the desk.', leads: ['Lead A', 'Lead B'], recap: 'r' }));
      } else if (parsed.type === 'turn') {
        lastTurnRequestBody = parsed;
        // Echoing the action into the narration is the mechanically
        // verifiable proxy for "the GM engaged with exactly what was
        // typed": if the frontend ever stops sending the real text, or
        // substitutes a stale/lead value, this echo breaks and the test
        // fails below.
        res.end(ndjson({ narration: `You act on it: ${parsed.action} — a concrete detail surfaces.`, leads: ['Next lead'], recap: 'r' }));
      } else {
        res.end(ndjson({ error: 'unexpected_type_in_test' }));
      }
    });
    return;
  }

  const filePath = path.join(REPO_ROOT, req.url === '/' ? '/index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.click('[data-action="new-case"]');
    await page.fill('#det1', 'Nero');
    await page.fill('#det2', 'Kenna');
    await page.click('#setup-form button[type="submit"]');
    await page.waitForSelector('#turn-feed', { timeout: 10000 });

    const FREE_TEXT = 'check her shoe size against the print by the door';
    await page.fill('#action-input', FREE_TEXT);
    await page.click('.action-bar button[type="submit"]');

    await page.waitForFunction(
      (text) => Array.from(document.querySelectorAll('.player-note')).some((el) => el.textContent.includes(text)),
      FREE_TEXT,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      (text) => Array.from(document.querySelectorAll('.case-page .narration')).some((el) => el.textContent.includes(text)),
      FREE_TEXT,
      { timeout: 10000 },
    );

    assert.ok(lastTurnRequestBody, 'no turn request reached the mocked function');
    assert.strictEqual(lastTurnRequestBody.action, FREE_TEXT, 'free text was not sent verbatim as the turn action');

    const gameState = await page.evaluate(() => JSON.parse(localStorage.getItem('cf-current-game')));
    const playerTurn = gameState.turns.find((t) => t.role === 'players' && t.action === FREE_TEXT);
    assert.ok(playerTurn, 'free-text action was not persisted verbatim in game state');

    const gmTurn = [...gameState.turns].reverse().find((t) => t.role === 'gm');
    assert.ok(gmTurn.narration.includes(FREE_TEXT), 'narration did not engage with the free-text action');

    console.log('PASS: free-text action sent verbatim, persisted, and produced a responsive narration');
    process.exitCode = 0;
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

main();
