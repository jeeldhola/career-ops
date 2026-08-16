#!/usr/bin/env node
/**
 * research-prompt-updates.mjs — daily web-grounded research for the CV/cover
 * letter prompt "best practices" blocks.
 *
 * Uses Gemini's google_search grounding tool (real web search, not the
 * model's static training knowledge) to pull current, cited best-practice
 * guidance for the US job market, for two targets: resume writing and cover
 * letter writing.
 *
 * IMPORTANT — this script only produces candidate content. It does not touch
 * any prompt file itself; the Python caller (services/prompt_research_service.py)
 * is responsible for splicing the returned bullets into the delimited
 * AUTO_RESEARCH block and only doing so when success:true.
 *
 * Output: a single JSON object on stdout (see run_node_json in core/runner.py):
 *   {
 *     "cv_generator": { "success": bool, "bullets": string[], "citations": [{title,url}], "error"?: string },
 *     "cover_letter_generator": { ... same shape ... }
 *   }
 *
 * NOTE ON THE TOOLING: the installed @google/generative-ai SDK (v0.24.1) only
 * types the older `googleSearchRetrieval` tool (Gemini 1.5-era dynamic
 * retrieval), not the `google_search` tool used by Gemini 2.0+ models. Rather
 * than fight an outdated SDK, this script calls the Gemini REST API directly
 * with fetch(), the same pattern already used for the Groq fallback in
 * gemini-eval.mjs.
 *
 * Requires GEMINI_API_KEY in .env. No Groq fallback here on purpose — Groq
 * has no web-search grounding, so a "best effort without real research"
 * fallback would defeat the point of this script; on failure a target is
 * just reported success:false and the caller leaves that prompt file alone.
 */

try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

const apiKey = process.env.GEMINI_API_KEY || '';
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const currentYear = new Date().getFullYear();

const TARGETS = {
  cv_generator: {
    topic: 'resume/CV writing',
    query: `Using current, up-to-date web search results, list exactly 5 concise, specific, ` +
      `actionable best practices for writing a resume/CV for the US job market in ${currentYear}. ` +
      `Focus on things that materially change how a resume should be written or formatted — not ` +
      `generic advice like "be honest" or "check spelling". Each practice should be one sentence, ` +
      `specific enough that a professional resume writer could act on it directly.\n\n` +
      `Format your answer as a markdown bullet list, one practice per line, starting with "- ". ` +
      `Do not include any preamble, headers, numbering, or commentary — output ONLY the bullet list.`,
  },
  cover_letter_generator: {
    topic: 'cover letter writing',
    query: `Using current, up-to-date web search results, list exactly 5 concise, specific, ` +
      `actionable best practices for writing a cover letter for the US job market in ${currentYear}. ` +
      `Focus on things that materially change how a cover letter should be written or structured — ` +
      `not generic advice like "be honest" or "check spelling". Each practice should be one sentence, ` +
      `specific enough that a professional career coach could act on it directly.\n\n` +
      `Format your answer as a markdown bullet list, one practice per line, starting with "- ". ` +
      `Do not include any preamble, headers, numbering, or commentary — output ONLY the bullet list.`,
  },
};

// ---------------------------------------------------------------------------
// Extract "- bullet" lines from free text, defensively.
// ---------------------------------------------------------------------------
function extractBullets(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, '').trim())
    // Defensive: a bullet that itself looks like it's trying to inject
    // instructions (e.g. picked up from a low-quality/adversarial page in
    // the search results) gets dropped rather than spliced into a live
    // production prompt.
    .filter((line) => !/ignore\b.{0,25}\binstructions\b|disregard\b.{0,25}\binstructions\b|system prompt|you are now|act as if you/i.test(line))
    .filter((line) => line.length >= 20 && line.length <= 400);
}

function extractCitations(candidate) {
  try {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    return chunks
      .map((c) => c?.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title || '', url: w.uri || '' }))
      .filter((c) => c.url);
  } catch {
    return [];
  }
}

async function researchTarget(name, { topic, query }) {
  if (!apiKey) {
    return { success: false, bullets: [], citations: [], error: 'GEMINI_API_KEY not configured' };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { success: false, bullets: [], citations: [], error: `Gemini API ${res.status}: ${errText.slice(0, 300)}` };
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text || '').join('\n') || '';
    const bullets = extractBullets(text);
    const citations = extractCitations(candidate);

    if (bullets.length < 3) {
      return {
        success: false,
        bullets: [],
        citations: [],
        error: `Only extracted ${bullets.length} usable bullets for ${topic} (need >=3) — response may not have followed the format, or grounding produced low-quality content.`,
      };
    }

    return { success: true, bullets: bullets.slice(0, 5), citations, model: modelName };
  } catch (err) {
    return { success: false, bullets: [], citations: [], error: String(err?.message || err) };
  }
}

const results = {};
for (const [name, target] of Object.entries(TARGETS)) {
  results[name] = await researchTarget(name, target);
}

console.log(JSON.stringify(results));
