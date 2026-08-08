// Prompt templates for the GM, verbatim from SPEC.md section 7.
// Exported as builder functions so gm.mjs can interpolate {{placeholders}}
// without a template engine or build step. Lives next to gm.mjs (rather than
// at the repo root) because the bundled function can only resolve imports
// from within its own directory — a parent-directory relative import is not
// reachable at runtime once Netlify packages the function.

// Case generation is split into up to three calls, each individually well
// under the platform's ~60s ceiling even in a worst-case fully-buffered
// response: the core (identity, cast, solution, clock, posture) establishes
// the ground truth, the detail pass builds the investigable surface (clues,
// pacing) on top of it, and — Dread tone only — a third call adds the
// apparent phenomena. Splitting phenomena out keeps the detail pass itself
// terse enough to stay well under 1800 max_tokens even with the widest
// evidence map; the phenomena call is capped at 1000 max_tokens (see
// gm.mjs). Each call receives whatever's already been generated as context
// so the whole case stays consistent.

function buildNewCaseCorePrompt({ det1, det2, flavor, tone, customRequest }) {
  const isDread = tone === 'dread';

  const dreadRequirement = isDread ? `
- Dread tone: generate the case around isolation — a place with a history,
  a community that won't talk, a prior incident that echoes into this one.
  Dread cases skew reactive or hostile posture.` : '';

  return `You are the case architect for a two-player detective game. Generate the
core of a complete, self-consistent crime case that will be narrated over
many turns and finished with a second detail pass. The players never see
this file; it is the hidden ground truth the narrator must obey.

Detectives: ${det1} and ${det2}.
Requested flavor: ${flavor}. Tone: ${tone}. Player request to honor if present: "${customRequest}".

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
- A case clock: caseStart (the in-story day and time the investigation
  begins, terse, e.g. "Day 1, 9:40 PM") and a deadlineEvent — one specific
  event invented from this case's own facts that occurs when the clock
  expires (a suspect's flight, a body released for cremation, a witness
  leaving protective custody, a trust executing). Never a generic "time
  runs out."
- What makes this case good: a motive rooted in a personal wound, not only
  mechanics; a culprit whose competence explains why they weren't caught
  earlier; a solution whose emotional logic will land when it's eventually
  revealed, not just its evidentiary logic.${dreadRequirement}
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
}`;
}

function buildNewCaseDetailPrompt({ det1, det2, coreCaseFileJson }) {
  return `You are the case architect finishing the investigable surface of a detective
case for two players sharing one screen: ${det1} and ${det2}. Below is the
core of the case already established — ground truth you must stay perfectly
consistent with.

CORE CASE FILE: ${coreCaseFileJson}

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
                     "redHerring": false } ],
  "actPlan": { "act1": "", "act2": "", "act3": "" }
}`;
}

function buildNewCasePhenomenaPrompt({ det1, det2, caseFileJson }) {
  return `You are the case architect adding Dread-tone apparent phenomena to a
detective case for two players sharing one screen: ${det1} and ${det2}. Below
is the case already established — ground truth you must stay perfectly
consistent with.

CASE FILE: ${caseFileJson}

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
{ "apparentPhenomena": [ { "phenomenon": "", "explanation": "" } ] }`;
}

function buildCaseOpeningPrompt({ det1, det2, caseFileJson, tone }) {
  const isDread = tone === 'dread';
  const toneNote = isDread
    ? ' Lean into the isolation and quiet unease of a Dread case — no apparent phenomenon needs to appear yet; that is for later turns.'
    : '';

  return `You are the game master opening a detective case for two players sharing one
screen: ${det1} and ${det2}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly).

HIDDEN CASE FILE: ${caseFileJson}

Write a short opening dispatch scene (150-250 words) that lays out the
situation and ends at a decision point. Write it in second person plural,
present tense, cinematic but concrete. Never address the real players, only
the detective characters.${toneNote}

Then propose exactly 4 initial leads: short imperative phrases, each a
genuinely different investigative direction.

Then write a recap: one paragraph, neutral summary of the setup. This is the
GM's only long-term memory of the case going forward.

Respond with ONLY this JSON:
{ "openingNarration": "", "leads": ["", "", "", ""], "recap": "" }`;
}

function buildTurnPrompt({ det1, det2, caseFileJson, recap, mentionTallyJson, recentTurnsJson, turnCount, clockBudgetHours, hoursRemaining, currentAct, tone, action }) {
  const isDread = tone === 'dread';
  const dreadRule = isDread ? `
- Dread pacing: reveal at most one "apparent phenomenon" per act, with
  quiet, ordinary scenes between them — dread comes from what is withheld,
  sound, and implication, never escalating spectacle or gore. Never explain
  a phenomenon in the same scene where it occurs; the human explanation
  surfaces later, only when genuinely earned. Track in the recap which
  phenomena have appeared and which have been explained.` : '';

  return `You are the game master narrating a detective case for two players sharing one
screen: ${det1} and ${det2}. Below is the HIDDEN case file (ground truth you
must never contradict and never reveal directly), a recap of the investigation
so far, and the most recent turns.

HIDDEN CASE FILE: ${caseFileJson}
RECAP: ${recap}
MENTION TALLY: ${mentionTallyJson}
RECENT TURNS: ${recentTurnsJson}
TURN NUMBER: ${turnCount}. CLOCK: ${hoursRemaining} hours remaining of ${clockBudgetHours}, currently ${currentAct}.
THE DETECTIVES NOW: ${action}

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
  never gore.${dreadRule}
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
  Shuffle their order. Never reference a fact that hasn't already been
  surfaced in narration. Leads must not name the same suspect two turns in a
  row unless the detectives' own action this turn specifically forces it —
  check RECENT TURNS' most recent GM turn for which suspect(s) its leads
  named, and avoid repeating them here.
- Update the recap: 120 words max, neutral, cover everything discovered so
  far including this turn, a short "cast so far" list of named people
  already introduced, and note any thread that just closed offstage. The
  recap is your only long-term memory.
- Update mentionTally from MENTION TALLY: for every suspect named in this
  turn's narration, increment their "turns" count by 1 from the input tally;
  for every suspect named in a lead you just proposed, increment their
  "leads" count by 1. Suspects untouched this turn keep their prior counts.
  Return the full tally with an entry for every suspect in the case file,
  even ones sitting at 0.

Respond with ONLY this JSON:
{ "narration": "", "leads": ["", "", ""], "recap": "", "hoursSpent": 0, "currentTime": "",
  "mentionTally": { "SuspectName": { "turns": 0, "leads": 0 } } }`;
}

function buildAccusationPrompt({ caseFileJson, recap, det1, det2, killer, method, motive }) {
  return `You are the game master resolving the final accusation of a detective case.

HIDDEN CASE FILE: ${caseFileJson}
RECAP: ${recap}
DETECTIVES: ${det1} and ${det2}
THEIR ACCUSATION: killer: ${killer} | method: ${method} | motive: ${motive}

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
- epilogue: 3 to 4 lines, only consequences connected to the crime or its
  investigation — cut anything about a character's unrelated personal life.
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
  "trueSolution": "", "epilogue": "", "roadsNotTaken": ["", ""] }`;
}

export {
  buildNewCaseCorePrompt,
  buildNewCaseDetailPrompt,
  buildNewCasePhenomenaPrompt,
  buildCaseOpeningPrompt,
  buildTurnPrompt,
  buildAccusationPrompt,
};
