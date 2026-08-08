// Same-directory import: Netlify bundles each function in isolation, so a
// parent-directory relative import (the old '../../prompts.js') is not
// reachable at runtime — only files under netlify/functions/ get packaged
// with the function.
import {
  buildNewCaseCorePrompt,
  buildNewCaseDetailPrompt,
  buildNewCasePhenomenaPrompt,
  buildCaseOpeningPrompt,
  buildTurnPrompt,
  buildAccusationPrompt,
} from './prompts.mjs';

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Netlify Functions v2: default export takes a standard Request and returns
// a standard Response. Returning a Response whose body is a ReadableStream
// keeps the connection open past the platform's synchronous timeout, since
// bytes keep flowing instead of the function sitting silently until it
// returns. That alone isn't sufficient, though — see netlify.toml, which
// used to apply a catch-all [[headers]] rule to every path including this
// function, forcing Netlify's edge to buffer the response to attach headers
// and silently reintroducing the platform's buffered-invocation timeout.
// Case generation is also split into up to three calls (newCaseCore,
// newCaseDetail, and — Dread tone only — newCasePhenomena) so each stays
// safely under that ceiling even in a worst-case fully-buffered scenario,
// independent of whether streaming reaches the client. newCaseDetail on its
// own hit stop_reason=max_tokens at 1800 tokens once Dread's apparent-
// phenomena requirement was folded in (~40s elapsed) — splitting phenomena
// into their own call, rather than raising the cap, keeps every call's
// worst-case duration well clear of the 60s ceiling instead of trading one
// timeout risk for another.
export default async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse(400, { error: 'bad_request' });
  }

  let prompt;
  let maxTokens;
  let narrationField;

  switch (body.type) {
    case 'newCaseCore': {
      const { detectives = [], flavor, tone, customRequest } = body;
      prompt = buildNewCaseCorePrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        flavor: flavor || 'Surprise us',
        tone: tone || 'straight',
        customRequest: customRequest || '',
      });
      maxTokens = 1800;
      // no narrationField: the case file is data, never shown as prose
      break;
    }
    case 'newCaseDetail': {
      const { caseFile, detectives = [] } = body;
      prompt = buildNewCaseDetailPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        coreCaseFileJson: JSON.stringify(caseFile),
      });
      maxTokens = 1800;
      // no narrationField: same reasoning as newCaseCore
      break;
    }
    case 'newCasePhenomena': {
      const { caseFile, detectives = [] } = body;
      prompt = buildNewCasePhenomenaPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
      });
      maxTokens = 1000;
      // no narrationField: same reasoning as newCaseCore. Dread tone only —
      // the frontend never sends this request type for a straight case.
      break;
    }
    case 'caseOpening': {
      const { caseFile, detectives = [], tone } = body;
      prompt = buildCaseOpeningPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
        tone: tone || 'straight',
      });
      maxTokens = 1000;
      narrationField = 'openingNarration';
      break;
    }
    case 'turn': {
      const {
        caseFile, recap, mentionTally, recentTurns, action, detectives = [], turnCount,
        clockBudgetHours = 48, hoursRemaining, currentAct = 'act1', tone,
      } = body;
      prompt = buildTurnPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
        recap: recap || '',
        mentionTallyJson: JSON.stringify(mentionTally || {}),
        recentTurnsJson: JSON.stringify(recentTurns || []),
        turnCount,
        clockBudgetHours,
        hoursRemaining: hoursRemaining != null ? hoursRemaining : clockBudgetHours,
        currentAct,
        tone: tone || 'straight',
        action: action || '',
      });
      maxTokens = 1200;
      narrationField = 'narration';
      break;
    }
    case 'accusation': {
      const { caseFile, recap, accusation = {}, detectives = [] } = body;
      prompt = buildAccusationPrompt({
        caseFileJson: JSON.stringify(caseFile),
        recap: recap || '',
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        killer: accusation.killer || '',
        method: accusation.method || '',
        motive: accusation.motive || '',
      });
      maxTokens = 1800;
      narrationField = 'verdictNarration';
      break;
    }
    default:
      return jsonResponse(400, { error: 'bad_request' });
  }

  return streamResult(prompt, maxTokens, narrationField, body.type);
};

// The response body is newline-delimited JSON (NDJSON): zero or more
// `{"type":"progress"}` keep-alive lines while the model is generating,
// zero or more `{"type":"narration-delta","text":"..."}` lines carrying
// plain-text prose as it's decoded out of the streaming JSON (only for
// request types that have a narrationField — see below), and finally
// exactly one `{"type":"result","payload":{...}}` line as the last thing
// written before the stream closes. NDJSON keeps the envelope unambiguous
// even if the transport splits it across multiple TCP chunks — the
// frontend just buffers text and parses whenever it sees a newline.
//
// narrationField names the top-level JSON string key (e.g. "narration",
// "openingNarration", "verdictNarration") whose value should be surfaced
// progressively for typewriter-by-stream rendering. It's undefined for
// newCaseCore/newCaseDetail/newCasePhenomena, whose caseFile pieces are data
// and never shown as prose. requestType is passed through purely for the
// elapsedMs log line below, so a slow call is traceable to which of the (now
// six) request types it was.
function streamResult(prompt, maxTokens, narrationField, requestType) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const fieldStreamer = narrationField ? new JsonStringFieldStreamer(narrationField) : null;

      let result;
      try {
        result = await runAnthropicStream(prompt, maxTokens, requestType, (deltaText) => {
          send({ type: 'progress' });
          if (fieldStreamer) {
            const decoded = fieldStreamer.push(deltaText);
            if (decoded) send({ type: 'narration-delta', text: decoded });
          }
        });
      } catch (e) {
        console.error(`gm stream error: type=${requestType} ${e && e.message}`);
        send({ type: 'result', payload: { error: 'gm_failed' } });
        controller.close();
        return;
      }

      if (result.stopReason === 'max_tokens') {
        send({ type: 'result', payload: { error: 'gm_truncated' } });
        controller.close();
        return;
      }

      const parsed = tryParseJson(result.text);
      if (!parsed) {
        send({ type: 'result', payload: { error: 'gm_failed' } });
        controller.close();
        return;
      }

      send({ type: 'result', payload: parsed });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}

// Incrementally extracts the decoded value of one top-level JSON string
// field (e.g. "narration") as raw model output streams in piece by piece.
// Scoped deliberately narrow: our three narration-bearing response shapes
// (caseOpening, turn, accusation) always put the narration field first and
// it's always a plain string (never nested), so a small buffer-and-rescan
// state machine is enough — no need for a general streaming JSON parser.
class JsonStringFieldStreamer {
  constructor(fieldName) {
    this.needle = `"${fieldName}"`;
    this.raw = '';
    this.state = 'seek-key'; // seek-key -> seek-colon -> seek-quote -> in-string -> done
  }

  push(chunk) {
    this.raw += chunk;
    if (this.state === 'done') return '';

    if (this.state === 'seek-key') {
      const idx = this.raw.indexOf(this.needle);
      if (idx === -1) return '';
      this.raw = this.raw.slice(idx + this.needle.length);
      this.state = 'seek-colon';
    }

    if (this.state === 'seek-colon') {
      const idx = this.raw.indexOf(':');
      if (idx === -1) return '';
      this.raw = this.raw.slice(idx + 1);
      this.state = 'seek-quote';
    }

    if (this.state === 'seek-quote') {
      let i = 0;
      while (i < this.raw.length && /\s/.test(this.raw[i])) i++;
      if (i >= this.raw.length) {
        this.raw = this.raw.slice(i);
        return '';
      }
      if (this.raw[i] !== '"') {
        // Not a string value where we expected one — give up quietly;
        // the frontend just falls back to the loading screen for this call.
        this.state = 'done';
        return '';
      }
      this.raw = this.raw.slice(i + 1);
      this.state = 'in-string';
    }

    if (this.state === 'in-string') {
      let out = '';
      let i = 0;
      while (i < this.raw.length) {
        const ch = this.raw[i];
        if (ch === '\\') {
          if (i + 1 >= this.raw.length) break; // incomplete escape, wait for more input
          const esc = this.raw[i + 1];
          if (esc === 'u') {
            if (i + 6 > this.raw.length) break; // incomplete \uXXXX, wait for more input
            out += String.fromCharCode(parseInt(this.raw.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            const map = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
            out += esc in map ? map[esc] : esc;
            i += 2;
          }
        } else if (ch === '"') {
          this.state = 'done';
          i += 1;
          break;
        } else {
          out += ch;
          i += 1;
        }
      }
      this.raw = this.raw.slice(i);
      return out;
    }

    return '';
  }
}

// One Anthropic call per invocation — no in-function retries. The frontend's
// retry button already covers recovery; retrying in here just spends more
// of the same budget that got us into trouble in the first place.
async function runAnthropicStream(prompt, maxTokens, requestType, onDelta) {
  const startedAt = Date.now();
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error(`anthropic error: type=${requestType} status=${res.status} elapsedMs=${Date.now() - startedAt} maxTokens=${maxTokens} body=${errBody}`);
    throw new Error(`anthropic_error_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop(); // keep the trailing partial event for the next read

    for (const raw of events) {
      const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;

      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr) continue;

      let sseEvent;
      try {
        sseEvent = JSON.parse(jsonStr);
      } catch (e) {
        continue;
      }

      if (sseEvent.type === 'content_block_delta' && sseEvent.delta && typeof sseEvent.delta.text === 'string') {
        text += sseEvent.delta.text;
        onDelta(sseEvent.delta.text);
      } else if (sseEvent.type === 'message_delta' && sseEvent.delta && sseEvent.delta.stop_reason) {
        stopReason = sseEvent.delta.stop_reason;
      } else if (sseEvent.type === 'error') {
        throw new Error(`anthropic_stream_error: ${JSON.stringify(sseEvent.error)}`);
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`anthropic stream done: type=${requestType} elapsedMs=${elapsedMs} maxTokens=${maxTokens} stopReason=${stopReason} textLen=${text.length}`);

  return { text, stopReason };
}

function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
