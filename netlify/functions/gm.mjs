// Same-directory import: Netlify bundles each function in isolation, so a
// parent-directory relative import (the old '../../prompts.js') is not
// reachable at runtime — only files under netlify/functions/ get packaged
// with the function.
import {
  buildNewCaseSkeletonPrompt,
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
// returns — that silence is what was killing newCaseSkeleton at 60s.
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
    case 'newCaseSkeleton': {
      const { detectives = [], flavor, customRequest } = body;
      prompt = buildNewCaseSkeletonPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        flavor: flavor || 'Surprise us',
        customRequest: customRequest || '',
      });
      maxTokens = 2800;
      // no narrationField: the case file is data, never shown as prose
      break;
    }
    case 'caseOpening': {
      const { caseFile, detectives = [] } = body;
      prompt = buildCaseOpeningPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
      });
      maxTokens = 1000;
      narrationField = 'openingNarration';
      break;
    }
    case 'turn': {
      const { caseFile, recap, recentTurns, action, detectives = [], turnCount, decisionBudget = 20, currentAct = 'act1' } = body;
      prompt = buildTurnPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
        recap: recap || '',
        recentTurnsJson: JSON.stringify(recentTurns || []),
        turnCount,
        decisionBudget,
        currentAct,
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

  return streamResult(prompt, maxTokens, narrationField);
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
// newCaseSkeleton, whose caseFile is data and never shown as prose.
function streamResult(prompt, maxTokens, narrationField) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const fieldStreamer = narrationField ? new JsonStringFieldStreamer(narrationField) : null;

      let result;
      try {
        result = await runAnthropicStream(prompt, maxTokens, (deltaText) => {
          send({ type: 'progress' });
          if (fieldStreamer) {
            const decoded = fieldStreamer.push(deltaText);
            if (decoded) send({ type: 'narration-delta', text: decoded });
          }
        });
      } catch (e) {
        console.error(`gm stream error: ${e && e.message}`);
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
// Scoped deliberately narrow: our four response shapes always put the
// narration-bearing field first and it's always a plain string (never
// nested), so a small buffer-and-rescan state machine is enough — no need
// for a general streaming JSON parser.
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
async function runAnthropicStream(prompt, maxTokens, onDelta) {
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
    console.error(`anthropic error: status=${res.status} elapsedMs=${Date.now() - startedAt} maxTokens=${maxTokens} body=${errBody}`);
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
  console.log(`anthropic stream done: elapsedMs=${elapsedMs} maxTokens=${maxTokens} stopReason=${stopReason} textLen=${text.length}`);

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
