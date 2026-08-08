# CASE FILES — Stage 1 Specification

Private two-player detective game. An AI game master (Claude API) generates a complete hidden case, then narrates it live while two detectives investigate and solve it together on one shared screen.

This document is the full brief for Stage 1. Build exactly this. Do not add features from "Out of scope."

---

## 1. Constraints

- Vanilla HTML, CSS, JS. Single-page PWA. No frameworks, no build step. (This governs the deployed app only. A `package.json` exists at the repo root purely to declare Playwright as a devDependency for the regression test in `tests/` — Netlify's build never runs `npm install`, so it has no effect on what ships; see section 2.)
- Hosting: Netlify with auto-deploy from GitHub `main`.
- One Netlify Function (`netlify/functions/gm.mjs`) is the only backend. It holds the API key (env var `ANTHROPIC_API_KEY`) and proxies calls to the Anthropic API. The key must never reach the browser. It is a Netlify Functions v2 streaming function (ESM `export default`, returns a `Response` whose body is a `ReadableStream`) — the open connection is what lets a slow generation run past the platform's synchronous invocation limit instead of being killed mid-response (see section 5). This alone was found not to be sufficient in practice: `netlify.toml`'s `[[headers]]` rules must also avoid matching `/.netlify/functions/*`, since Netlify's edge merges header rules onto the origin response, which requires buffering the function's response first — silently defeating the streamed `Response` and reintroducing the platform's buffered-invocation timeout (see `netlify.toml`). As a second, independent line of defense, case generation is split into up to three calls (`newCaseCore`, `newCaseDetail`, and — Dread tone only — `newCasePhenomena`; see section 5 and 7) each capped well under the timeout, so generation stays safe even in a worst-case fully-buffered scenario. This split is load-bearing, not just precautionary: with Dread's apparent-phenomena requirement folded into `newCaseDetail`, that call hit `stop_reason: "max_tokens"` at its 1800-token cap around 40s elapsed — raising the cap would have pushed it back toward the 60s ceiling, so the phenomena requirement was moved into its own call instead.
- Persistence: localStorage only. Keys: `cf-settings`, `cf-current-game`, `cf-archive`. Never rename these later without a migration function.
- Model: `claude-sonnet-4-6`. `max_tokens`: 1800 for the case core, 1800 for the case detail pass, 1000 for the case phenomena pass (Dread only), 1000 for the case opening, 1200 for turns, 1800 for accusation (raised from 1500 to make room for `roadsNotTaken`). Case generation is split across up to three calls (see section 5) both for the timeout margin described above and because each call is a separate, independently-retryable unit of work. One Anthropic call per function invocation, no in-function retries — recovery is the frontend's retry button, not a second attempt in gm.mjs. `gm.mjs` logs `elapsedMs`, tagged with the request type, for every Anthropic call so a slow call is traceable to which of the six request types it was.
- Players: exactly two detectives sharing one screen (they are on a video call together). No accounts, no auth, no multiplayer sync.

## 2. Repo and files

```
/index.html
/style.css
/app.js
/netlify/functions/gm.mjs
/netlify/functions/prompts.mjs   <- exports the six prompt templates (section 7); lives next to gm.mjs
                                     because Netlify bundles each function in isolation — a relative
                                     import can't reach outside its own function's directory
/manifest.webmanifest
/icons/
/netlify.toml
/package.json                    <- dev-only: declares Playwright as a devDependency so tests/ is
                                     actually runnable; not read by the Netlify build
/tests/free-text-action.test.mjs <- Playwright regression test (Stage 1.5 item 5): a free-text
                                     action must be sent verbatim as the turn action and produce a
                                     responsive narration. Run with `npm install && npm run test:free-text`.
```

## 3. Game flow (Stage 1 = Deduction Mode only)

1. **Home screen.** Logo, "New Case" button, "Continue Case" (if `cf-current-game` exists), "Archive" list of finished cases.
2. **Setup screen.** Two name fields (Detective 1 / Detective 2, prefilled from `cf-settings` after first game). A "case flavor" selector: Murder / Disappearance / Heist / Surprise us. A **duration** choice: Express (48 in-story hours) or Full (72 hours), default Express — stored as `clockBudgetHours` in game state (see section 4) and sent with every `turn` request to pace evidence reveal and end-game convergence pressure against the in-story case clock (see section 7.5). A **tone** choice: Straight (default) or Dread — Dread generates the case around isolation and includes "apparent phenomena" that always resolve to a rational, human cause; see section 7.1, 7.3, and 7.5. Optional free-text field: "Anything you want in this case?" Then "Open the case file."
3. **Case generation.** Up to four calls to the function, back to back under one continuous loading state (see section 6): `type: "newCaseCore"` generates the core of the hidden case file (identity, cast, solution, clock, posture — see section 7.1), then `type: "newCaseDetail"` takes that core and generates the investigable surface on top of it (evidence map, three-act pacing plan — see section 7.2), then — Dread tone only — `type: "newCasePhenomena"` takes the merged core+detail case file and generates the apparent phenomena (see section 7.3), then `type: "caseOpening"` generates the opening scene from the fully-merged case file. Straight-tone cases skip the phenomena call entirely. Only `caseOpening` streams narration; the core, detail, and phenomena calls carry no narration field, since a case file is data, never shown as prose. Loading messages show until the opening narration's first streamed delta arrives, then the typewriter loading state is replaced by the narration itself growing into a case-file page live as the model streams it (see section 5 and 6). The case file is never rendered anywhere in the UI, not even in a debug view.
4. **Investigation loop.** A **clock bar** sits above the turn feed: the in-story day and time (`currentTime`, GM-authored, freeform but terse — e.g. "Day 2, 3:15 AM") on the left, an **evidence counter** ("Evidence 2/3", from `securedEvidence.length`) in the middle, hours remaining on the right, all three in the typewriter label style; the bar turns `--thread` red once 12 hours or fewer remain, and updates after every turn. The evidence counter shows the number plainly and nothing else — no indication of which clues count as admissible or why (section 7.5 instructs the GM never to narrate that bookkeeping either). Every case-file page (the opening scene, each turn, and the closed-case page on the verdict and archive-detail screens) additionally carries its own **dateline**: the `currentTime` that applied when that page happened, stamped at the top of the page itself — see section 6. Each turn shows:
   - The narration for the current scene, rendered as a typed case-file page, its text growing progressively as the model streams it — see section 5 and 6.
   - At most 3 tappable **lead cards** suggested by the GM (2 is fine): terse, neutral phrases naming a person, place, or record ("The boathouse," "Carolyn's phone records") — never a conclusion, an urgency word, or an implied ranking, and shuffled so card order carries no signal. No lead may name, and no narration may reference as already known, a person not yet introduced in narration. Leads also must not name the same suspect two turns running (see section 7.5) — enforced entirely by the turn prompt, not client-side.
   - A free-text input, always available: the detectives can type anything ("check her shoe size", "ping-call the burner"). Free text is a first-class action, not a fallback, sent verbatim as the turn's `action` and honored by the GM with exactly the same weight as a tapped lead. This is what makes the game feel alive.
   - A persistent **"Make an accusation"** button, always visible but visually secondary.
   Selecting a lead or submitting text sends `type: "turn"` and appends the result, which also carries `hoursSpent` (added to game state's `hoursElapsed`) and `currentTime` (the new clock display). The choice itself renders immediately as a compact marker in the turn feed (who, and what they did) before the response streams in below it — choosing one thread can close others: unpursued time-sensitive leads may resolve offstage as the hours pass (a scene gets processed by techs and comes back as a report only; a witness leaves town), acknowledged naturally in the following narration. After each new page renders (the opening scene, a turn response, or the compact choice marker), the viewport scrolls to the top of that newest page — not to the top of the whole feed, not to its bottom.
   When `hoursElapsed` reaches `clockBudgetHours`, the clock has run out: that turn's narration plays out the case file's `deadlineEvent` as actually happening, and the app skips straight to the accusation screen instead of the normal game screen — showing that final narration inline above the form (no "Back to the case" link; there is no case left to go back to) so the detectives read what forced their hand before the fields. Reopening a clock-expired case via "Continue Case" lands directly on the accusation screen the same way.
5. **Accusation.** A form with three fields: Killer (dropdown of suspect names, shuffled to display order on every visit to this screen so position never correlates with guilt — "Someone else" free text always appended last, never shuffled in), Method (free text), Motive (free text). Confirm dialog: "Close the case? The DA only gives you one shot." Sends `type: "accusation"` with the current `securedEvidence` and whether the clock had already expired (section 7.6).
6. **Verdict screen.** The GM's verdict narration (streamed progressively like turn narration), a scorecard (Killer / Method / Motive each marked correct, partial, or missed), and the full true solution. The accusation's outcome — conviction, technicality walk, or wrong person charged, layered with "the clock already ran out" if it applies — is decided by the GM from the killer score and `securedEvidence` (section 7.6) and expressed through `verdictNarration` and `epilogue`; there's no separate outcome field, the frontend just renders whatever comes back. Next, if the response includes a valid `postAccusationChoice` (a prompt and exactly 2 options), a **decision card** presents it in the same paper-card-and-stamp visual language as a case-file page: one final call with no correct answer, generated from the case's own facts. Tapping an option replaces the card with a compact chosen-marker and reveals the epilogue below — until then, the epilogue, "The Threads You Left Hanging," and the "New Case" / "Back to Home" buttons all stay hidden, the same required-step pattern as the accusation form's own fields. The shown epilogue is the response's base `epilogue` plus the chosen option's `epilogueAddendum`. If there's no valid `postAccusationChoice`, all of that renders immediately with no card. Then a closing section titled "The Threads You Left Hanging" lists the roads not taken — scaled to the scorecard: exactly 2 short atmospheric lines if all three are correct, up to 4 explanatory lines if any is partial or missed. Buttons: "New Case" and "Back to home." The finished game (title, date, detectives, score, solution, the final combined epilogue, roads not taken) is appended to `cf-archive` — only once the epilogue is final, i.e. immediately if there was no decision card, or the moment one is chosen — and `cf-current-game` is cleared as soon as the accusation resolves (win or lose, there's no going back to the case).

Mode selection UI (Deduction vs Branching) should exist on the setup screen, but the Branching option is rendered disabled with a "Coming soon" tag. Do not implement it.

## 4. State model

`cf-current-game` (single JSON object):

```json
{
  "version": 1,
  "mode": "deduction",
  "createdAt": "ISO",
  "detectives": ["Nero", "Kenna"],
  "clockBudgetHours": 48,
  "hoursElapsed": 4,
  "currentTime": "Day 1, 1:40 AM",
  "tone": "straight",
  "caseFile": { /* hidden case file, the client-side merge of newCaseCore's response (identity,
                   cast, solution, posture, caseStart, deadlineEvent), newCaseDetail's response
                   (evidenceMap, actPlan), and — Dread only — newCasePhenomena's response
                   (apparentPhenomena), never displayed */ },
  "recap": "GM-maintained running summary of the investigation so far",
  "mentionTally": { "Suspect Name": { "turns": 2, "leads": 1 } },
  "securedEvidence": ["Exact clue text of an admissible clue the detectives have surfaced"],
  "turns": [
    { "role": "players", "action": "Walk the scene" },
    { "role": "gm", "narration": "...", "leads": ["...", "..."], "currentTime": "Day 1, 1:40 AM" }
  ],
  "turnCount": 4,
  "status": "active" | "solved"
}
```

Context management: every `turn` request sends the hidden `caseFile`, the `recap`, and only the **last 6 turns** verbatim. The GM returns an updated `recap` each turn; store it. This keeps token cost flat no matter how long the case runs.

Suspect screen-time balance: `mentionTally` is a sibling of `recap`, maintained the same way — the GM returns an updated tally every `turn` response, the frontend stores it verbatim and sends it back as context on the next `turn` request (empty object `{}` at case creation; the opening dispatch doesn't populate it). It maps each suspect's name to `{ "turns": N, "leads": N }`: how many turns they've appeared by name in narration, and how many leads have named them. The turn prompt uses this to keep suspicion-worthy screen time roughly even across all four suspects through act1 and act2 — see section 7.5. The frontend never reads or computes the tally itself; it's opaque pass-through state, same as `recap`.

DA evidence threshold: every generated `evidenceMap` clue carries `admissible` (section 7.2) — exactly 3 of the 8 clues per case are hard, court-usable evidence; the rest are inference, hearsay, or behavioral reads. `securedEvidence` is a sibling of `recap` and `mentionTally`, maintained the same way: an array of the exact `clue` text of each admissible clue the GM has confirmed the detectives concretely surfaced in narration (not merely referenced), returned updated every `turn` response, stored verbatim, and sent back as context on the next `turn` and on `accusation` (section 7.5, 7.6). Starts at `[]` at case creation. Its length is the number shown by the header's evidence counter ("Evidence 2/3") — there are always exactly 3 admissible clues, so no separate total needs to be tracked. The frontend never inspects which clues are admissible or computes the count from `evidenceMap` itself; `securedEvidence.length` is trusted directly, same as `mentionTally` is never recomputed client-side.

Each `gm` turn entry also stores its own `currentTime` (the opening's is `caseFile.caseStart`; every later turn's is that turn response's `currentTime`) — this is what lets each case-file page show its own dateline instead of only the header clock bar reflecting the single current value (see section 6).

Case clock: `clockBudgetHours` (48 for Express, 72 for Full) is fixed at case creation from the setup screen's duration choice. `hoursElapsed` accumulates the `hoursSpent` each turn response returns; `currentTime` is replaced each turn by the response's `currentTime` (a GM-authored display string — the frontend never does calendar arithmetic on it, since its format isn't guaranteed beyond "terse"). `hoursRemaining` (`clockBudgetHours - hoursElapsed`, floored at 0) and `currentAct` are derived, not stored: `act3` at 12 hours remaining or fewer, `act1` below 1/3 elapsed, `act2` otherwise. These three — `clockBudgetHours`, `hoursRemaining`, `currentAct` — are sent with every `turn` request, along with `tone` (fixed at case creation, same for `newCaseCore` and `caseOpening` too — `newCaseDetail` and `newCasePhenomena` don't take `tone`, since neither prompt branches on it: `newCasePhenomena` is only ever called for Dread cases in the first place), so the GM can pace evidence reveal, end-game convergence pressure, and (for Dread) apparent-phenomenon restraint (section 7.5).

## 5. Function API (`/.netlify/functions/gm`)

`POST` JSON, always answered with a streamed `Response` (`content-type: application/x-ndjson`), even for fast calls — the frontend's reader loop is the only consumer, so there's one code path regardless of how long generation takes. Six request types. The function builds the prompt from the templates in section 7, and calls the Anthropic API once with `stream: true`. No in-function retries — one Anthropic call per invocation. The function logs `elapsedMs`, tagged with the request type, and the response's `stop_reason` on every call, and the raw error body on a non-2xx or a mid-stream `error` event.

**Response body (NDJSON).** Each line is one JSON object, newline-terminated:
- `{ "type": "progress" }` — written on every streamed text delta from Anthropic while generation is in flight. Pure keep-alive / liveness signal; the frontend ignores the contents. This is what keeps the connection alive past the platform's synchronous invocation limit — bytes keep flowing instead of the function going silent until it returns.
- `{ "type": "narration-delta", "text": "..." }` — written alongside `progress`, for request types that have a narration-bearing field (`caseOpening`, `turn`, `accusation` — not `newCaseCore`, `newCaseDetail`, or `newCasePhenomena`, whose case file pieces are data and never shown as prose). The function incrementally decodes that field's string value out of the still-streaming JSON as it arrives (see `JsonStringFieldStreamer` in gm.mjs) and forwards each newly-decoded slice as plain text. This is what the frontend renders progressively into the case-file page (typewriter-by-stream) instead of showing a loading animation for the whole call.
- `{ "type": "result", "payload": {...} }` — written exactly once, as the last line, immediately before the stream closes. `payload` is either the successful response shape from the table below, or one of the two error shapes. Leads, recap, score, trueSolution, epilogue, and roadsNotTaken are only ever known once the JSON is complete, so they arrive here — never as deltas.

Two failure modes, both delivered as a `result` line with `payload: { error: "..." }`, and both given the same frontend handling: a "Static on the radio, try again" state with a retry button that resends the same request.
- `stop_reason === "max_tokens"`: the response was truncated before it could complete. Delivered as `{ error: "gm_truncated" }` without attempting to parse the accumulated text — a truncated response can't reliably produce valid JSON (and, per the case below, isn't trusted even if it happens to), so trying is wasted work.
- Anything else that isn't valid JSON once the stream completes, a non-2xx from Anthropic, or a mid-stream SSE `error` event: `{ error: "gm_failed" }`.

New-case generation is split into up to four calls, independent of the streaming transport and each individually well under the platform's timeout even in a worst-case fully-buffered response: `newCaseCore` generates the identity/cast/solution/clock/posture core of the hidden case file (terse, information-dense fields — no prose), `newCaseDetail` takes that core as context and generates the investigable surface on top of it (evidence map, act plan), then — Dread tone only — `newCasePhenomena` takes the merged core+detail case file and generates the apparent phenomena, then `caseOpening` takes the fully-merged case file and generates the narrated opening scene. Straight-tone cases skip `newCasePhenomena` entirely — the frontend never sends it. `newCaseDetail` was originally responsible for the Dread apparent-phenomena requirement too, but that pushed it to `stop_reason: "max_tokens"` at its 1800-token cap (~40s elapsed); splitting phenomena into their own call was the fix, since raising the cap would have traded one timeout risk for another. The frontend runs its calls back to back under one continuous loading state and retries each independently — a failed call resends only itself against whatever was already generated, it never regenerates an earlier step.

| type | payload in | response out |
|---|---|---|
| `newCaseCore` | `{ detectives, flavor, tone, customRequest }` | `{ caseFile }` (core fields only) |
| `newCaseDetail` | `{ caseFile, detectives }` (core `caseFile` as context) | `{ evidenceMap, actPlan }` |
| `newCasePhenomena` | `{ caseFile, detectives }` (merged core+detail `caseFile` as context; Dread only) | `{ apparentPhenomena }` |
| `caseOpening` | `{ caseFile, detectives, tone }` | `{ openingNarration, leads, recap }` |
| `turn` | `{ caseFile, recap, mentionTally, securedEvidence, recentTurns, action, detectives, turnCount, clockBudgetHours, hoursRemaining, currentAct, tone }` | `{ narration, leads, recap, hoursSpent, currentTime, mentionTally, securedEvidence }` |
| `accusation` | `{ caseFile, recap, securedEvidence, clockExpired, accusation: { killer, method, motive }, detectives }` | `{ verdictNarration, score: { killer, method, motive }, trueSolution, epilogue, postAccusationChoice, roadsNotTaken }` |

`score` values: `"correct" | "partial" | "missed"`.

## 6. Design direction

Subject: a nighttime case file shared by two people on a video call. The UI should feel like evidence, not like an app.

- **Palette:** `--ink #14161d` (app background), `--paper #efe8d8` (case-file pages), `--type #23201a` (text on paper), `--thread #b3382c` (evidence-board red: accents, the accusation button, stamps), `--pencil #8b8578` (secondary text, timestamps).
- **Type:** display and case headers in a typewriter face (`Special Elite` or `Courier Prime` via Google Fonts) used with restraint; body narration in a quiet readable serif (`Source Serif 4`); UI labels in the typewriter face at small sizes, letterspaced, uppercase.
- **Signature element:** every GM narration renders as a typed page clipped into the file: paper card, slightly rotated stamp reading `CASE 26-XXXX` in `--thread`, faint paper texture via CSS gradient only (no image assets). Lead cards look like index cards pinned below the page.
- **Per-page dateline:** every case-file page additionally carries a second stamp in its opposite top corner (mirroring the case-number stamp), showing the in-story day/time that page happened at — same typewriter face, letterspaced uppercase, but quieter `--pencil` instead of `--thread`, since it's a timestamp annotation rather than an official mark, and rotated the other way for a hand-stamped feel. It shows whatever `currentTime` string the GM authored for that page verbatim — never reformatted, same as the header clock bar. This applies to the opening scene, every turn, the accusation screen's clock-expired inline narration, the verdict screen's closed-case page, and archive-detail pages; the header clock bar stays as the single always-current summary, this is the per-page historical record.
- **Loading states:** typewriter-style text that types out, cycling short lines ("Dispatch is calling it in…", "Pulling the records…"). No spinners. This runs only until the GM's narration itself starts arriving — once the first streamed delta lands, the cycling lines are replaced in place by the narration growing directly into its case-file page (typewriter-by-stream, same paper card, same blinking `--thread` cursor at the write head). A tapped lead or submitted free-text action renders immediately as a compact dashed-border marker in the turn feed, with the next page's loading state appearing right below it — the marker, not a full-screen takeover, is what the player sees first.
- **Case clock:** a slim bar above the turn feed, typewriter label style, letterspaced uppercase — the in-story time on the left, an evidence counter in the middle, hours remaining on the right. Quiet `--pencil` gray normally; the whole bar (evidence counter included) switches to `--thread` red once 12 hours or fewer remain, the same accent used for pressure and stamps elsewhere, so urgency reads through color the player already associates with the DA and the evidence board.
- **Post-accusation decision card:** the same paper-card-and-stamp language as a case-file page (it *is* one, stamped "Your Call" instead of a case number), holding a one-line prompt and two full-width option buttons stacked below it, dark chrome against the paper like other in-app buttons. Once chosen, it's replaced by a compact dashed-border marker — same construction as the turn feed's own choice markers, just not right-aligned — naming which option was picked, with the epilogue appearing directly below.
- Dark app chrome around light paper pages. Motion minimal: pages fade-slide in, respect `prefers-reduced-motion`. Mobile-first at 380 px; it will mostly be played on phones.
- Quality floor: keyboard focus visible, tap targets 44 px, text ≥ 16 px on paper.

## 7. Game-master prompts

These six templates live in `prompts.mjs`. `{{placeholders}}` are interpolated. All six end by demanding raw JSON with no markdown fences and no text outside the JSON object. The core, opening, and turn templates additionally branch on `{{tone}}` (`"straight"` or `"dread"`) — the tone-only text is shown separately after each base template, exactly where the builder function inserts it. The detail and phenomena templates do not branch on tone: detail's requirements are tone-agnostic, and phenomena is Dread-only content that's simply never requested for a Straight case (see section 5).

### 7.1 Case core (`newCaseCore`)

```
You are the case architect for a two-player detective game. Generate the
core of a complete, self-consistent crime case that will be narrated over
many turns and finished with a second detail pass. The players never see
this file; it is the hidden ground truth the narrator must obey.

Detectives: {{det1}} and {{det2}}.
Requested flavor: {{flavor}}. Tone: {{tone}}. Player request to honor if present: "{{customRequest}}".

Requirements:
- Grounded and realistic. No supernatural elements. Adult tension is fine.
- A victim, a setting with atmosphere, and exactly 4 suspects.
- Exactly one culprit (an accomplice is allowed and encouraged sometimes).
- Every suspect has: name, age, relation to victim, a real motive, a claimed
  alibi, and a secret (which for innocents is unrelated to the murder). Each
  of those fields is one short sentence.
- A hidden timeline of the crime night: 6 lines maximum, one line each,
  minute-level where it matters.
- A culprit posture, chosen to fit who this culprit actually is: "passive"
  (stays hidden, no counter-moves), "reactive" (from act2, destroys
  evidence, pressures witnesses, changes routine as the detectives close
  in), or "hostile" (acts against the detectives themselves — surveillance,
  a message, a witness silenced, misdirection aimed at them). Most cases
  should be passive or reactive; reserve hostile for a culprit it genuinely
  fits.
- The culprit occupies a structurally trusted role that makes them
  unsuspicious by default: the one who found the body, reported it, is
  assisting the investigation, or is a caretaker or family confidant others
  rely on. Their trustworthiness should be structural, not merely claimed.
- A case clock: caseStart (the in-story day and time the investigation
  begins, terse, e.g. "Day 1, 9:40 PM") and a deadlineEvent — one specific
  event invented from this case's own facts that occurs when the clock
  expires (a suspect's flight, a body released for cremation, a witness
  leaving protective custody, a trust executing). Never a generic "time
  runs out."
- What makes this case good: a motive rooted in a personal wound, not only
  mechanics; a culprit whose competence explains why they weren't caught
  earlier; a solution whose emotional logic will land when it's eventually
  revealed, not just its evidentiary logic.[DREAD REQUIREMENT — see below, `tone: "dread"` only]
- Every field in this JSON is terse and information-dense: one short
  sentence each, no prose flourishes, no scene-setting language anywhere in
  the case file. This is a data file, not narration.

Respond with ONLY this JSON:
{
  "caseFile": {
    "caseNumber": "26-XXXX",
    "title": "",
    "setting": "",
    "victim": { "name": "", "age": 0, "description": "" },
    "suspects": [ { "name": "", "age": 0, "relation": "", "motive": "",
                    "alibi": "", "secret": "", "isCulprit": false } ],
    "solution": { "killer": "", "accomplice": null, "method": "", "motive": "",
                  "timeline": "" },
    "posture": "passive",
    "caseStart": "",
    "deadlineEvent": ""
  }
}
```

**When `tone` is `"dread"`,** the requirement bullet marked above is this text, appended right after the "what makes this case good" bullet, before the "terse and information-dense" bullet:

```
- Dread tone: generate the case around isolation — a place with a history,
  a community that won't talk, a prior incident that echoes into this one.
  Dread cases skew reactive or hostile posture.
```

### 7.2 Case detail (`newCaseDetail`)

```
You are the case architect finishing the investigable surface of a detective
case for two players sharing one screen: {{det1}} and {{det2}}. Below is the
core of the case already established — ground truth you must stay perfectly
consistent with.

CORE CASE FILE: {{coreCaseFileJson}}

Requirements:
- An evidence map of exactly 8 clues: each has where it is found, what it
  truly points to, and whether it is a red herring — strictly one short
  fragment per field, not a sentence. At least 2 red herrings. Clues must
  make the case FAIRLY solvable: a careful player following real clues can
  identify killer, method, and motive.
- One piece of physical evidence must contradict the killer's alibi.
- Every one of the 4 suspects, not only the culprit, must have at least one
  clue in the evidence map whose pointsTo names them — a concrete piece of
  evidence that appears to implicate them, not just a stated motive from the
  core file. Red herrings are the natural way to give innocents this: a red
  herring that points at an innocent suspect satisfies both requirements at
  once.
- Mark exactly 3 of the 8 clues "admissible": true — hard, court-usable
  evidence (forensics, records, documents, a physical object tied to the
  culprit). Everything else is "admissible": false — inference, hearsay,
  behavioral reads, anything a defense attorney would tear apart alone. At
  least one of the 3 admissible clues must be obtainable only through a
  time-costly action (a lab result, a warrant, a records pull) — never
  something available on a first glance.
- At least one clue or thread that can be permanently lost if the detectives
  don't pursue it in time.
- A three-act plan for pacing: act1 (the scene and the suspects come into
  view), act2 (contradictions surface and alibis start to strain), act3 (the
  endgame — pressure converges toward an accusation). Each act is at most 2
  short fragments, not sentences.
- No prose anywhere. This is a data file: fragments and short phrases only,
  never a full sentence, never scene-setting language.

Respond with ONLY this JSON:
{
  "evidenceMap": [ { "clue": "", "location": "", "pointsTo": "",
                     "redHerring": false, "admissible": false } ],
  "actPlan": { "act1": "", "act2": "", "act3": "" }
}
```

The frontend merges `newCaseDetail`'s response into the core `caseFile` client-side (`evidenceMap`, `actPlan`) before the Dread-only phenomena call (or, for Straight cases, before generating the opening directly).

### 7.3 Case phenomena (`newCasePhenomena`, Dread tone only)

```
You are the case architect adding Dread-tone apparent phenomena to a
detective case for two players sharing one screen: {{det1}} and {{det2}}. Below
is the case already established — ground truth you must stay perfectly
consistent with.

CASE FILE: {{caseFileJson}}

Requirements:
- Include 3 to 5 "apparent phenomena": events that feel impossible (a knock
  in an empty house, a voice, a cold touch, a light that shouldn't be on),
  each paired with its concrete human explanation, hidden until surfaced.
- The rules of any case still apply in full: one true culprit, fair
  evidence, a fully rational solution, no supernatural cause, ever.
- Restraint is the rule — dread comes from what is withheld, sound, and
  implication, never escalating spectacle or gore.
- Every field in this JSON is terse and information-dense: one short
  sentence each, no prose flourishes.

Respond with ONLY this JSON:
{ "apparentPhenomena": [ { "phenomenon": "", "explanation": "" } ] }
```

`{{caseFileJson}}` here is the merged core+detail case file (identity, cast, solution, posture, clock, evidenceMap, actPlan), not just the core — phenomena are written to stay consistent with the evidence and pacing too, not only the identity fields. This call is only ever made when `tone` is `"dread"`; the frontend never sends it for a Straight case, so the prompt itself doesn't need to branch. The frontend merges its response (`apparentPhenomena`) into the case file client-side before generating the opening.

### 7.4 Case opening (`caseOpening`)

```
You are the game master opening a detective case for two players sharing one
screen: {{det1}} and {{det2}}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly).

HIDDEN CASE FILE: {{caseFileJson}}

Write a short opening dispatch scene (150-250 words) that lays out the
situation and ends at a decision point. Write it in second person plural,
present tense, cinematic but concrete. Never address the real players, only
the detective characters.[DREAD NOTE — see below, `tone: "dread"` only]

Then propose exactly 4 initial leads: short imperative phrases, each a
genuinely different investigative direction.

Then write a recap: one paragraph, neutral summary of the setup. This is the
GM's only long-term memory of the case going forward.

Respond with ONLY this JSON:
{ "openingNarration": "", "leads": ["", "", "", ""], "recap": "" }
```

**When `tone` is `"dread"`,** this sentence is appended right after "the detective characters.":

> Lean into the isolation and quiet unease of a Dread case — no apparent phenomenon needs to appear yet; that is for later turns.

### 7.5 Turn narration (`turn`)

```
You are the game master narrating a detective case for two players sharing one
screen: {{det1}} and {{det2}}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly), a recap of the investigation
so far, and the most recent turns.

HIDDEN CASE FILE: {{caseFileJson}}
RECAP: {{recap}}
MENTION TALLY: {{mentionTallyJson}}
SECURED EVIDENCE: {{securedEvidenceJson}}
RECENT TURNS: {{recentTurnsJson}}
TURN NUMBER: {{turnCount}}. CLOCK: {{hoursRemaining}} hours remaining of {{clockBudgetHours}}, currently {{currentAct}}.
THE DETECTIVES NOW: {{action}}

Rules:
- Honor the action. If they interrogate someone, write the interrogation with
  real dialogue. If they examine something, give concrete findings. A
  free-text action carries exactly the same weight as a tapped lead: engage
  directly and specifically with what they typed, never a generic deflection
  or a nudge back toward the suggested leads.
- Stay strictly consistent with the case file. Innocents lie only about their
  secrets. The culprit lies about the crime, and lies well. Never
  definitively clear any suspect before act3 — an alibi can hold up while
  suspicion stays alive; innocents keep lying about their secrets the whole
  game.
- Honor the culprit's posture from the case file: passive stays hidden with
  no counter-moves; reactive starts covering tracks, pressuring witnesses,
  or changing routine once act2 begins; hostile acts against the detectives
  themselves (surveillance, a message, a witness silenced, misdirection
  aimed at them) and may put a named NPC in danger — tension over shock,
  never gore.[DREAD RULE — see below, `tone: "dread"` only]
- Screen-time balance: keep suspect appearances roughly even across all four
  suspects through act1 and act2, using MENTION TALLY as your guide — a
  suspect "appears" when named in this turn's narration, and separately when
  named in a lead you propose. If the culprit is currently the most-mentioned
  suspect, foreground other suspects in the scenes that follow until the
  tally evens out. This balance requirement is lifted only in act3, where the
  case is allowed to converge.
- Give innocent suspects' secrets and evasions the same narrative weight and
  specificity as the culprit's crime-lies — when an innocent lies badly about
  their secret, write it with the same concrete, attention-grabbing detail as
  the culprit lying well. A player's suspicion should never simply track
  whichever suspect gets the most vivid treatment.
- Every suspect's secret must produce at least one scene, over the course of
  the whole case, of visibly evasive behavior when it's touched — a stumble,
  a too-quick answer, a subject change — textured exactly the same way as
  the culprit's evasions. Track in the recap's cast-so-far note which
  suspects still need this scene, so evasiveness stops being a tell for
  guilt on its own.
- Never let a lead name, or narration reference as already known, a person
  who hasn't yet been introduced in narration. Keep a "cast so far" note in
  the recap and check new leads against it.
- Assign this action an hoursSpent cost and return it: a quick interview or
  scene walk is 1-2 hours; a records pull, canvass, or lab request is 3-4;
  results that must be waited on (tox, prints, a warrant) are 6-8; anything
  that waits for morning or a scheduled person is 8-14. Choose realistically
  for what the detectives just did, reflect the passage of time in the
  narration, and return currentTime: the in-story day and time now, in the
  same terse format as caseStart in the case file (e.g. "Day 2, 3:15 AM").
- Reveal clues gradually. Each turn should give real progress: at least one
  concrete fact from the evidence map or timeline, surfaced naturally. Pace
  toward the evidence map being mostly revealed well before the clock runs
  out. Under 12 hours remaining, the DA presses for a charge — apply
  in-fiction convergence pressure without ever hard-stopping the detectives:
  they can keep investigating, but the world keeps pressing. At zero hours
  or below, the deadlineEvent from the case file happens in the narration
  itself, the case is forced to resolution, and this is the last turn — do
  not propose leads.
- Never confirm or deny theories. Never name the culprit as such. If players
  guess right mid-game, stay neutral and consistent.
- If the action is something impossible or outside the world, deflect
  in-fiction (a warrant is denied, records are sealed) and offer a nearby
  alternative.
- Choosing a lead can close others: unchosen time-sensitive threads resolve
  offstage as the hours pass (the scene gets processed by techs and comes
  back as a report only, a witness leaves town). Acknowledge closures
  naturally in the narration when they happen, and track them in the recap.
  Choices should feel like spending, not browsing.
- 180-300 words of narration. Second person plural, present tense, concrete
  and cinematic. End at a decision point, never resolve the case yourself.
  No leading commentary that assembles the case for the players ("what you
  still need is...", "when you walk in, you want every wall built") and no
  full evidence-chain recaps — synthesis is the players' job, not yours.
- Then propose at most 3 leads (2 is fine): terse, neutral phrases naming a
  person, place, or record only ("The boathouse", "Carolyn's phone
  records") — no conclusions, no urgency words, no implied ranking by order.
  Shuffle their order — position must never correlate with which lead
  matters most; don't habitually put the strongest lead first or last.
  Never reference a fact that hasn't already been surfaced in narration.
  Leads must not name the same suspect two turns in a row unless the
  detectives' own action this turn specifically forces it — check RECENT
  TURNS' most recent GM turn for which suspect(s) its leads named, and
  avoid repeating them here.
- Track admissible evidence separately from ordinary clues: whenever a clue
  from the case file's evidenceMap marked "admissible": true is concretely
  surfaced in this turn's narration — not just referenced, but established
  as evidence now in hand — add its exact clue text to securedEvidence if
  it isn't already there. Never remove an entry once added. Never state in
  narration which clues are admissible, how many exist, or a running count
  — the detectives should never see the DA's bookkeeping, only its
  pressure.
- Update the recap: 120 words max, neutral, cover everything discovered so
  far including this turn, a short "cast so far" list of named people
  already introduced (noting which still need their evasion scene), and
  note any thread that just closed offstage. The recap is your only
  long-term memory.
- Update mentionTally from MENTION TALLY: for every suspect named in this
  turn's narration, increment their "turns" count by 1 from the input tally;
  for every suspect named in a lead you just proposed, increment their
  "leads" count by 1. Suspects untouched this turn keep their prior counts.
  Return the full tally with an entry for every suspect in the case file,
  even ones sitting at 0.

Respond with ONLY this JSON:
{ "narration": "", "leads": ["", "", ""], "recap": "", "hoursSpent": 0, "currentTime": "",
  "mentionTally": { "SuspectName": { "turns": 0, "leads": 0 } }, "securedEvidence": [] }
```

**When `tone` is `"dread"`,** this bullet is appended right after the posture bullet marked above:

```
- Dread pacing: reveal at most one "apparent phenomenon" per act, with
  quiet, ordinary scenes between them — dread comes from what is withheld,
  sound, and implication, never escalating spectacle or gore. Never explain
  a phenomenon in the same scene where it occurs; the human explanation
  surfaces later, only when genuinely earned. Track in the recap which
  phenomena have appeared and which have been explained.
```

### 7.6 Accusation (`accusation`)

```
You are the game master resolving the final accusation of a detective case.

HIDDEN CASE FILE: {{caseFileJson}}
RECAP: {{recap}}
CLOCK STATUS: {{clockStatus}}
SECURED EVIDENCE: {{securedEvidenceCount}}/3
DETECTIVES: {{det1}} and {{det2}}
THEIR ACCUSATION: killer: {{killer}} | method: {{method}} | motive: {{motive}}

Score each of the three parts against the solution:
- "correct": right person / substantively right explanation.
- "partial": right direction with a meaningful gap (e.g. right killer but
  missed the accomplice; method mostly right but wrong weapon; motive adjacent
  to the truth).
- "missed": wrong.
Judge meaning, not wording. Be generous with phrasing, strict with substance.

Then determine the outcome from the killer score and SECURED EVIDENCE, and
let it drive verdictNarration, epilogue, and the post-accusation choice:
- Correct culprit ("correct" or "partial" killer score) with SECURED
  EVIDENCE at 3/3: the charge holds. A clean conviction.
- Correct culprit with SECURED EVIDENCE under 3/3: charges are filed but
  don't stick — the culprit walks on a technicality. If posture is
  "hostile", they act again; reflect that in the epilogue.
- Wrong culprit ("missed" killer score): an innocent is charged and the
  real culprit goes free. State a concrete cost in the epilogue: if
  posture is "hostile", the real culprit acts again; otherwise the case
  goes cold. Never mock the players.
- If CLOCK STATUS shows the clock ran out before this accusation, the case
  file's deadlineEvent already happened without them — the worst framing,
  layered on top of whichever outcome above applies.

Then write:
- verdictNarration (250-400 words): the arrest or the aftermath, played out
  cinematically. If they accused the wrong person, show the consequence: the
  real culprit's reaction, the case going cold or cracking open late. Address
  the detectives by name. Make a correct solve feel earned and a miss sting
  honestly. Never mock the players.
- trueSolution (concise): killer, accomplice if any, method, motive, and the
  two or three clues that pointed there.
- epilogue: 3 to 4 lines, only consequences connected to the crime or its
  investigation — cut anything about a character's unrelated personal life.
- postAccusationChoice: one final decision generated from this case's own
  facts, with no correct answer — typically charge to the fullest extent
  versus a lesser plea or mercy where the motive invites it, but let it fit
  whatever actually happened here. A one-line prompt framing the choice,
  and exactly 2 options, each a short label and a 1-2 line epilogueAddendum
  describing what that choice changes about the ending. Never make one
  option obviously right.
- roadsNotTaken: scaled to the scorecard you just determined. If killer,
  method, and motive are all "correct", write exactly 2 short atmospheric
  lines, no coaching tone. If any is "partial" or "missed", write the fuller
  version instead: up to 4 lines, each naming a thread from the case file
  the recap shows they never pulled or let close early, and what it would
  have established (e.g. "You never traced the second phone — it would have
  given you the motive by act 2."). Ground every line in clues or suspects
  that actually exist in the case file; never invent a thread that wasn't
  there, and never write it as a prosecutor's post-mortem.

Respond with ONLY this JSON:
{ "verdictNarration": "", "score": { "killer": "", "method": "", "motive": "" },
  "trueSolution": "", "epilogue": "",
  "postAccusationChoice": { "prompt": "", "options": [ { "label": "", "epilogueAddendum": "" },
                                                        { "label": "", "epilogueAddendum": "" } ] },
  "roadsNotTaken": ["", ""] }
```

## 8. Acceptance criteria (Stage 1 done means)

1. New case generates via the core + detail + opening calls (plus a phenomena call for Dread tone); hidden case file never appears in the DOM, console logs, or network responses beyond the function round-trip.
2. Full loop playable on a phone: open case, 10+ turns mixing lead taps and free text, accusation, verdict, archive entry.
3. Closing the tab mid-case and reopening resumes exactly where it was via "Continue Case."
4. API key only in the Netlify env; frontend has zero secrets.
5. GM failures (`gm_failed` or `gm_truncated`) recover via the retry path without losing game state.
6. Design implemented per section 6, including reduced-motion support.
7. Setup's Express/Full duration choice is honored: `clockBudgetHours` (48/72) is stored in game state; every turn response adds its `hoursSpent` to `hoursElapsed` and replaces `currentTime`; the clock bar reflects both after every turn.
8. No turn response ever renders more than 3 lead cards.
9. A free-text action is sent verbatim as the turn's `action`, persisted verbatim in `cf-current-game`, and produces a narration that engages with it — see `tests/free-text-action.test.mjs`.
10. Turn, case-opening, and accusation narration render progressively into their case-file page as the model streams, not as a single jump after a loading animation.
11. The verdict screen shows a "The Threads You Left Hanging" section whenever the accusation response includes `roadsNotTaken`, and the archive entry retains it.
12. When `hoursElapsed` reaches `clockBudgetHours`, the app skips the normal game screen and opens the accusation screen automatically, showing the deadline turn's narration inline above the form; "Continue Case" on an already-expired game does the same.
13. Every generated case has a `posture` (`passive` | `reactive` | `hostile`) and the turn prompt is told to honor it; a Dread-tone case additionally carries 3-5 `apparentPhenomena`, each with a human explanation, and the turn prompt carries the one-per-act restraint rule.
14. No lead card or narration line references a named person before that person has appeared in narration — enforced entirely by the turn prompt's cast-introduction rule (section 7.5); there is no client-side filtering, since the frontend renders whatever the model returns.
15. (Stage 2.0a) Every generated case's evidence map gives all 4 suspects at least one clue that appears to implicate them, not only the culprit (section 7.2); every `turn` request/response carries `mentionTally`, initialized to `{}` at case creation and round-tripped verbatim by the frontend; the turn prompt's screen-time-balance and no-consecutive-lead-suspect rules (section 7.5) are the entire enforcement mechanism — there is no client-side check.
16. (Stage 2.0a) Every case-file page — the opening scene, each turn, the accusation screen's clock-expired inline narration, the verdict screen, and archive-detail pages — renders its own dateline stamp showing the `currentTime` that applied when that page happened, in addition to the header clock bar.
17. (Stage 2.0b) Every generated case's evidence map marks exactly 3 of its 8 clues `admissible: true`, at least one obtainable only through a time-costly action (section 7.2); `securedEvidence` starts at `[]`, round-trips verbatim through every `turn` and into `accusation`, and its length is shown plainly as "Evidence N/3" in the header — with no indication anywhere in the UI of which clues count, since the turn prompt is told never to narrate that bookkeeping (section 7.5).
18. (Stage 2.0b) The accusation prompt's outcome logic (section 7.6) covers all three GM-scored cases from the killer score and `securedEvidence`: correct culprit at 3/3 evidence (conviction holds), correct culprit under 3/3 (technicality walk), and wrong culprit (innocent charged, real culprit free) — each with its consequence stated in the epilogue, layered with "the clock already ran out" framing whenever `clockExpired` was true. There is no separate outcome field; the frontend renders whatever `verdictNarration`/`epilogue` come back.
19. (Stage 2.0b) Whenever an `accusation` response includes a valid `postAccusationChoice` (a prompt and exactly 2 options), the verdict screen shows a decision card before the epilogue; picking an option appends its `epilogueAddendum` to the base `epilogue`, reveals "The Threads You Left Hanging" and the New Case/Back to Home buttons, and is the point at which the game gets archived to `cf-archive` — none of that renders or happens before a choice is made. A response with no valid `postAccusationChoice` renders and archives immediately, exactly as before Stage 2.0b.
20. (Stage 2.0b) Every generated case's culprit occupies a structurally trusted role (section 7.1); every suspect gets at least one visibly evasive scene over the course of the case, textured the same as the culprit's (section 7.5); leads are shuffled with position never correlating with importance (section 7.5, strengthened from Stage 1.5's plain "shuffle"); and the accusation form's suspect dropdown is shuffled client-side on every visit so `caseFile.suspects`' generation order is never exposed to the player.

## 9. Out of scope for Stage 1

Branching (Detroit) mode, audio narration, ElevenLabs, per-detective individual choices, hidden meters, multi-device sync, case sharing, accounts. Stage 2 adds Branching mode on this same engine; Stage 3 adds audio and polish.
