const { buildNewCasePrompt, buildTurnPrompt, buildAccusationPrompt } = require('../../prompts.js');

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'bad_request' });
  }

  let prompt;
  let maxTokens;

  switch (body.type) {
    case 'newCase': {
      const { detectives = [], flavor, customRequest } = body;
      prompt = buildNewCasePrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        flavor: flavor || 'Surprise us',
        customRequest: customRequest || '',
      });
      maxTokens = 3000;
      break;
    }
    case 'turn': {
      const { caseFile, recap, recentTurns, action, detectives = [], turnCount } = body;
      prompt = buildTurnPrompt({
        det1: detectives[0] || 'Detective One',
        det2: detectives[1] || 'Detective Two',
        caseFileJson: JSON.stringify(caseFile),
        recap: recap || '',
        recentTurnsJson: JSON.stringify(recentTurns || []),
        turnCount,
        action: action || '',
      });
      maxTokens = 1500;
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
      maxTokens = 1500;
      break;
    }
    default:
      return json(400, { error: 'bad_request' });
  }

  const parsed = await callModelWithRetry(prompt, maxTokens);
  if (!parsed) {
    return json(200, { error: 'gm_failed' });
  }

  return json(200, parsed);
};

async function callModelWithRetry(prompt, maxTokens) {
  try {
    const first = await callModel(prompt, maxTokens);
    const parsedFirst = tryParseJson(first);
    if (parsedFirst) return parsedFirst;
  } catch (e) {
    // fall through to retry
  }

  try {
    const retryPrompt = `${prompt}\n\nRespond with valid JSON only.`;
    const second = await callModel(retryPrompt, maxTokens);
    const parsedSecond = tryParseJson(second);
    if (parsedSecond) return parsedSecond;
  } catch (e) {
    // fall through to null
  }

  return null;
}

async function callModel(prompt, maxTokens) {
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
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`anthropic_error_${res.status}`);
  }

  const data = await res.json();
  return data && data.content && data.content[0] ? data.content[0].text : '';
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

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
