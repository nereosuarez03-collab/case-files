# CASE FILES — Stage 1 Specification

Private two-player detective game. An AI game master (Claude API) generates a complete hidden case, then narrates it live while two detectives investigate and solve it together on one shared screen.

This document is the full brief for Stage 1. Build exactly this. Do not add features from "Out of scope."

---

## 1. Constraints

- Vanilla HTML, CSS, JS. Single-page PWA. No frameworks, no build step.
- Hosting: Netlify with auto-deploy from GitHub `main`.
- One Netlify Function (`netlify/functions/gm.js`) is the only backend. It holds the API key (env var `ANTHROPIC_API_KEY`) and proxies calls to the Anthropic API. The key must never reach the browser.
- Persistence: localStorage only. Keys: `cf-settings`, `cf-current-game`, `cf-archive`. Never rename these later without a migration function.
- Model: `claude-sonnet-4-6`. `max_tokens`: 1600 for the case skeleton, 1000 for the case opening, 1200 for turns, 1500 for accusation. Case generation is split across two calls to stay under the function platform's 60s invocation limit (see section 5). One Anthropic call per function invocation, no in-function retries — a slow retry inside the same invocation is what blows past the 60s limit, so recovery is the frontend's retry button, not a second attempt in gm.js.
- Players: exactly two detectives sharing one screen (they are on a video call together). No accounts, no auth, no multiplayer sync.

## 2. Repo and files

```
/index.html
/style.css
/app.js
/prompts.js          <- exports the three prompt templates (section 7), imported by gm.js at build via functions bundling or duplicated verbatim
/netlify/functions/gm.js
/manifest.webmanifest
/icons/
/netlify.toml
```

## 3. Game flow (Stage 1 = Deduction Mode only)

1. **Home screen.** Logo, "New Case" button, "Continue Case" (if `cf-current-game` exists), "Archive" list of finished cases.
2. **Setup screen.** Two name fields (Detective 1 / Detective 2, prefilled from `cf-settings` after first game). A "case flavor" selector: Murder / Disappearance / Heist / Surprise us. Optional free-text field: "Anything you want in this case?" Then "Open the case file."
3. **Case generation.** Two calls to the function, back to back under one continuous loading state (see section 6): `type: "newCaseSkeleton"` generates the hidden case file, then `type: "caseOpening"` generates the opening scene from it. The case file is never rendered anywhere in the UI, not even in a debug view.
4. **Investigation loop.** Each turn shows:
   - The narration for the current scene, rendered as a typed case-file page.
   - 3 to 5 tappable **lead cards** suggested by the GM (e.g. "Interrogate the widow," "Search the loading dock").
   - A free-text input, always available: the detectives can type anything ("check her shoe size", "ping-call the burner"). Free text is a first-class action, not a fallback. This is what makes the game feel alive.
   - A persistent **"Make an accusation"** button, always visible but visually secondary.
   Selecting a lead or submitting text sends `type: "turn"` and appends the result.
5. **Accusation.** A form with three fields: Killer (dropdown of suspect names + "Someone else" free text), Method (free text), Motive (free text). Confirm dialog: "Close the case? The DA only gives you one shot." Sends `type: "accusation"`.
6. **Verdict screen.** The GM's verdict narration, a scorecard (Killer / Method / Motive each marked correct, partial, or missed), the full true solution, and an epilogue. Buttons: "New Case" and "Back to home." The finished game (title, date, detectives, score, solution) is appended to `cf-archive` and `cf-current-game` is cleared.

Mode selection UI (Deduction vs Branching) should exist on the setup screen, but the Branching option is rendered disabled with a "Coming soon" tag. Do not implement it.

## 4. State model

`cf-current-game` (single JSON object):

```json
{
  "version": 1,
  "mode": "deduction",
  "createdAt": "ISO",
  "detectives": ["Nero", "Kenna"],
  "caseFile": { /* hidden skeleton, verbatim from newCase, never displayed */ },
  "recap": "GM-maintained running summary of the investigation so far",
  "turns": [
    { "role": "players", "action": "Walk the scene" },
    { "role": "gm", "narration": "...", "leads": ["...", "..."] }
  ],
  "turnCount": 4,
  "status": "active" | "solved"
}
```

Context management: every `turn` request sends the hidden `caseFile`, the `recap`, and only the **last 6 turns** verbatim. The GM returns an updated `recap` each turn; store it. This keeps token cost flat no matter how long the case runs.

## 5. Function API (`/.netlify/functions/gm`)

`POST` JSON. Four request types. The function builds the messages from the prompt templates in section 7, calls the Anthropic API once, and parses the model's JSON (strip ```json fences defensively). No in-function retries — one Anthropic call per invocation. The function logs the response's `stop_reason` on every call.

Two failure modes, both returned as `{ error: "..." }` with the same frontend handling: a "Static on the radio, try again" state with a retry button that resends the same request.
- `stop_reason === "max_tokens"`: the response was truncated before it could complete. Returned immediately as `{ error: "gm_truncated" }` without attempting to parse it — a truncated response can't produce valid JSON, so trying is wasted time against the 60s limit.
- Anything else that isn't valid JSON, or a non-2xx from Anthropic: `{ error: "gm_failed" }`.

New-case generation is split into two calls so neither exceeds the function platform's 60s invocation limit: `newCaseSkeleton` generates the hidden case file only (terse, information-dense fields — no prose), then `caseOpening` takes that case file and generates the narrated opening scene. The frontend runs them back to back under one continuous loading state and retries each independently — a failed `caseOpening` call resends only that request against the already-generated case file, it does not regenerate the skeleton.

| type | payload in | response out |
|---|---|---|
| `newCaseSkeleton` | `{ detectives, flavor, customRequest }` | `{ caseFile }` |
| `caseOpening` | `{ caseFile, detectives }` | `{ openingNarration, leads, recap }` |
| `turn` | `{ caseFile, recap, recentTurns, action, detectives, turnCount }` | `{ narration, leads, recap }` |
| `accusation` | `{ caseFile, recap, accusation: { killer, method, motive }, detectives }` | `{ verdictNarration, score: { killer, method, motive }, trueSolution, epilogue }` |

`score` values: `"correct" | "partial" | "missed"`.

## 6. Design direction

Subject: a nighttime case file shared by two people on a video call. The UI should feel like evidence, not like an app.

- **Palette:** `--ink #14161d` (app background), `--paper #efe8d8` (case-file pages), `--type #23201a` (text on paper), `--thread #b3382c` (evidence-board red: accents, the accusation button, stamps), `--pencil #8b8578` (secondary text, timestamps).
- **Type:** display and case headers in a typewriter face (`Special Elite` or `Courier Prime` via Google Fonts) used with restraint; body narration in a quiet readable serif (`Source Serif 4`); UI labels in the typewriter face at small sizes, letterspaced, uppercase.
- **Signature element:** every GM narration renders as a typed page clipped into the file: paper card, slightly rotated stamp reading `CASE 26-XXXX` in `--thread`, faint paper texture via CSS gradient only (no image assets). Lead cards look like index cards pinned below the page.
- **Loading states:** typewriter-style text that types out, cycling short lines ("Dispatch is calling it in…", "Pulling the records…"). No spinners.
- Dark app chrome around light paper pages. Motion minimal: pages fade-slide in, respect `prefers-reduced-motion`. Mobile-first at 380 px; it will mostly be played on phones.
- Quality floor: keyboard focus visible, tap targets 44 px, text ≥ 16 px on paper.

## 7. Game-master prompts

These four templates live in the function. `{{placeholders}}` are interpolated. All four end by demanding raw JSON with no markdown fences and no text outside the JSON object.

### 7.1 Case skeleton (`newCaseSkeleton`)

```
You are the case architect for a two-player detective game. Generate a complete,
self-consistent crime case that will be narrated over many turns. The players
never see this file; it is the hidden ground truth the narrator must obey.

Detectives: {{det1}} and {{det2}}.
Requested flavor: {{flavor}}. Player request to honor if present: "{{customRequest}}".

Requirements:
- Grounded and realistic. No supernatural elements. Adult tension is fine.
- A victim, a setting with atmosphere, and exactly 4 suspects.
- Exactly one culprit (an accomplice is allowed and encouraged sometimes).
- Every suspect has: name, age, relation to victim, a real motive, a claimed
  alibi, and a secret (which for innocents is unrelated to the murder). Each
  of those fields is one short sentence.
- A hidden timeline of the crime night: 6 lines maximum, one line each,
  minute-level where it matters.
- An evidence map of exactly 8 clues: each has where it is found, what it
  truly points to, and whether it is a red herring, one line each. At least
  2 red herrings. Clues must make the case FAIRLY solvable: a careful player
  following real clues can identify killer, method, and motive.
- One piece of physical evidence must contradict the killer's alibi.
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
    "evidenceMap": [ { "clue": "", "location": "", "pointsTo": "",
                       "redHerring": false } ]
  }
}
```

### 7.2 Case opening (`caseOpening`)

```
You are the game master opening a detective case for two players sharing one
screen: {{det1}} and {{det2}}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly).

HIDDEN CASE FILE: {{caseFileJson}}

Write a short opening dispatch scene (150-250 words) that lays out the
situation and ends at a decision point. Write it in second person plural,
present tense, cinematic but concrete. Never address the real players, only
the detective characters.

Then propose exactly 4 initial leads: short imperative phrases, each a
genuinely different investigative direction.

Then write a recap: one paragraph, neutral summary of the setup. This is the
GM's only long-term memory of the case going forward.

Respond with ONLY this JSON:
{ "openingNarration": "", "leads": ["", "", "", ""], "recap": "" }
```

### 7.3 Turn narration (`turn`)

```
You are the game master narrating a detective case for two players sharing one
screen: {{det1}} and {{det2}}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly), a recap of the investigation
so far, and the most recent turns.

HIDDEN CASE FILE: {{caseFileJson}}
RECAP: {{recap}}
RECENT TURNS: {{recentTurnsJson}}
TURN NUMBER: {{turnCount}}
THE DETECTIVES NOW: {{action}}

Rules:
- Honor the action. If they interrogate someone, write the interrogation with
  real dialogue. If they examine something, give concrete findings.
- Stay strictly consistent with the case file. Innocents lie only about their
  secrets. The culprit lies about the crime, and lies well.
- Reveal clues gradually. Each turn should give real progress: at least one
  concrete fact from the evidence map or timeline, surfaced naturally.
- Never confirm or deny theories. Never name the culprit as such. If players
  guess right mid-game, stay neutral and consistent.
- If the action is something impossible or outside the world, deflect
  in-fiction (a warrant is denied, records are sealed) and offer a nearby
  alternative.
- Escalate atmosphere as turnCount grows: after turn 10, the culprit may start
  reacting to the pressure (covering tracks, a warning, a mistake).
- 200-350 words of narration. Second person plural, present tense, concrete
  and cinematic. End at a decision point, never resolve the case yourself.
- Then propose 3 to 5 distinct leads: short imperative phrases, each a
  genuinely different investigative direction, at least one pointing toward
  un-touched evidence.
- Update the recap: 120 words max, neutral, cover everything discovered so
  far including this turn. The recap is your only long-term memory.

Respond with ONLY this JSON:
{ "narration": "", "leads": ["", "", ""], "recap": "" }
```

### 7.4 Accusation (`accusation`)

```
You are the game master resolving the final accusation of a detective case.

HIDDEN CASE FILE: {{caseFileJson}}
RECAP: {{recap}}
DETECTIVES: {{det1}} and {{det2}}
THEIR ACCUSATION: killer: {{killer}} | method: {{method}} | motive: {{motive}}

Score each of the three parts against the solution:
- "correct": right person / substantively right explanation.
- "partial": right direction with a meaningful gap (e.g. right killer but
  missed the accomplice; method mostly right but wrong weapon; motive adjacent
  to the truth).
- "missed": wrong.
Judge meaning, not wording. Be generous with phrasing, strict with substance.

Then write:
- verdictNarration (250-400 words): the arrest or the aftermath, played out
  cinematically. If they accused the wrong person, show the consequence: the
  real culprit's reaction, the case going cold or cracking open late. Address
  the detectives by name. Make a correct solve feel earned and a miss sting
  honestly. Never mock the players.
- trueSolution (concise): killer, accomplice if any, method, motive, and the
  two or three clues that pointed there.
- epilogue: 3 to 5 short lines on what happens to the people of the case
  afterward.

Respond with ONLY this JSON:
{ "verdictNarration": "", "score": { "killer": "", "method": "", "motive": "" },
  "trueSolution": "", "epilogue": "" }
```

## 8. Acceptance criteria (Stage 1 done means)

1. New case generates in one call; hidden case file never appears in the DOM, console logs, or network responses beyond the function round-trip.
2. Full loop playable on a phone: open case, 10+ turns mixing lead taps and free text, accusation, verdict, archive entry.
3. Closing the tab mid-case and reopening resumes exactly where it was via "Continue Case."
4. API key only in the Netlify env; frontend has zero secrets.
5. GM JSON parse failures recover via the retry path without losing game state.
6. Design implemented per section 6, including reduced-motion support.

## 9. Out of scope for Stage 1

Branching (Detroit) mode, audio narration, ElevenLabs, per-detective individual choices, hidden meters, multi-device sync, case sharing, accounts. Stage 2 adds Branching mode on this same engine; Stage 3 adds audio and polish.
