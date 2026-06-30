#!/usr/bin/env node
/**
 * gemini-eval.mjs — Gemini-powered Job Offer Evaluator for career-ops
 *
 * A free-tier alternative to the Claude-based pipeline.
 * Reads evaluation logic from modes/oferta.md + modes/_shared.md,
 * reads the user's resume from cv.md, and evaluates a Job Description
 * passed as a command-line argument.
 *
 * Usage:
 *   node gemini-eval.mjs "Paste full JD text here"
 *   node gemini-eval.mjs --file ./jds/my-job.txt
 *
 * Requires:
 *   GEMINI_API_KEY in .env (or environment variable)
 *
 * Free-tier model: gemini-2.5-flash (generous quota, no billing required)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  // Primary evaluation logic lives in these two mode files
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  // Canonical skill path referenced in Issue #344
  evaluate: join(ROOT, '.claude', 'skills', 'career-ops', 'SKILL.md'),
  cv: join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
  tracker: join(ROOT, 'data', 'applications.md'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini Evaluator (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Google Gemini instead of Claude.

  USAGE
    node gemini-eval.mjs "<JD text>"
    node gemini-eval.mjs --file ./jds/my-job.txt
    node gemini-eval.mjs --model gemini-2.5-flash "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Gemini model to use (default: gemini-2.5-flash)
    --no-save        Do not save report to reports/ directory
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
    node gemini-eval.mjs --file ./jds/openai-swe.txt
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
let saveReport = true;
let metadataFile = '';
let reportId = '';
let companyArg = '';
let roleArg = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--metadata-file' && args[i + 1]) {
    metadataFile = args[++i];
  } else if (args[i] === '--report-id' && args[i + 1]) {
    reportId = args[++i];
  } else if (args[i] === '--company' && args[i + 1]) {
    companyArg = args[++i];
  } else if (args[i] === '--role' && args[i + 1]) {
    roleArg = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

// Lazy import — only used when saving
let readdirSync;
try {
  ({ readdirSync } = await import('fs'));
} catch { /* already imported above via named exports */ }
// Use named import fallback
if (!readdirSync) {
  readdirSync = (await import('fs')).readdirSync;
}

// ---------------------------------------------------------------------------
// Prompt optimization helpers (saves tokens and boosts speed)
// ---------------------------------------------------------------------------
function pruneSharedContext(text) {
  if (!text) return '';
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Split by headings and keep only evaluation-related parts
  const sections = text.split(/(?=## )/);
  const kept = sections.filter(sec => {
    const header = sec.trim().split('\n')[0].toLowerCase();
    if (header.includes('global rules') || header.includes('professional writing') || header.includes('tools') || header.includes('sources of truth')) {
      return false;
    }
    return true;
  });
  return kept.join('\n').trim();
}

function pruneOfertaLogic(text) {
  if (!text) return '';
  // Strip out post-evaluation / tracking instructions (LLM does not need to know this)
  const idx = text.indexOf('## Post-evaluation');
  if (idx !== -1) {
    text = text.slice(0, idx);
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const rawShared = readFile(PATHS.shared, 'modes/_shared.md');
const rawOferta = readFile(PATHS.oferta, 'modes/oferta.md');
const cvContent = readFile(PATHS.cv, 'cv.md');

// Prune context files dynamically for the LLM (preserving raw JD text as requested)
const sharedContext = pruneSharedContext(rawShared);
const ofertaLogic = pruneOfertaLogic(rawOferta);
const optimizedJdText = jdText;

// ---------------------------------------------------------------------------
// Build the system prompt (mirrors the Claude skill router logic)
// ---------------------------------------------------------------------------
const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. Keep the output ultra-concise, brief, and direct-to-the-point.
   - Limit the entire report to under 300 words total.
   - Absolutely NO tables or verbose paragraphs. Use only short bullet points and single-sentence answers.
   - Follow the structure defined in oferta.md exactly.
4. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callLLM(systemPrompt, userPrompt, metadataFile = '') {
  if (apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192,
        },
      });
      const result = await model.generateContent([
        { text: systemPrompt },
        { text: userPrompt }
      ]);
      const evaluationText = result.response.text();
      const usage = result.response.usageMetadata;
      if (metadataFile && usage) {
        try {
          const usageJson = {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          };
          writeFileSync(metadataFile, JSON.stringify(usageJson, null, 2), 'utf-8');
        } catch (err) {
          console.warn(`⚠️  Could not write metadata file: ${err.message}`);
        }
      }
      return evaluationText;
    } catch (err) {
      console.warn(`⚠️  Gemini API call failed: ${err.message}. Trying Groq fallback...`);
    }
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  const groqModel = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

  if (groqApiKey) {
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const body = {
          model: groqModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.4,
          max_tokens: 8000
        };

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });

        if (res.status === 429) {
          const resText = await res.text();
          attempt++;
          if (attempt >= maxRetries) {
            throw new Error(`HTTP 429 - ${resText}`);
          }
          let waitMs = 5000;
          const match = resText.match(/try again in ([\d.]+)s/i);
          if (match) {
            waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 1000;
          }
          console.warn(`⚠️  Groq rate limited (429). Retrying attempt ${attempt}/${maxRetries} in ${waitMs / 1000}s...`);
          await sleep(waitMs);
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        }

        const data = await res.json();
        const content = data.choices[0].message.content;

        if (metadataFile && data.usage) {
          try {
            const usageJson = {
              prompt_tokens: data.usage.prompt_tokens || 0,
              completion_tokens: data.usage.completion_tokens || 0,
              total_tokens: data.usage.total_tokens || 0
            };
            writeFileSync(metadataFile, JSON.stringify(usageJson, null, 2), 'utf-8');
          } catch (err) {
            // ignore
          }
        }

        return typeof content === 'string' ? content.trim() : content;
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) {
          console.error(`❌  Groq API call failed after ${maxRetries} attempts: ${err.message}`);
          throw err;
        }
        console.warn(`⚠️  Groq API error: ${err.message}. Retrying in 3s...`);
        await sleep(3000);
      }
    }
  }

  throw new Error("No LLM API (Gemini or Groq) is configured and succeeded.");
}

// ---------------------------------------------------------------------------
// Call LLM API
// ---------------------------------------------------------------------------
console.log(`🤖  Calling LLM API (${modelName})... this may take 30-60 seconds.\n`);

let evaluationText;
try {
  evaluationText = await callLLM(systemPrompt, `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${optimizedJdText}`, metadataFile);
} catch (err) {
  console.error('❌  Evaluation API error:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company = 'unknown';
let role = 'unknown';
let score = '?';
let archetype = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  // Prefer CLI-passed company/role hints over LLM-extracted ones
  company = companyArg || extract('COMPANY');
  role = roleArg || extract('ROLE');
  score = extract('SCORE');
  archetype = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// ---------------------------------------------------------------------------
// Format and Display evaluation
// ---------------------------------------------------------------------------
const today = new Date().toISOString().split('T')[0];
const cleanedText = evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim();
let finalBody = cleanedText;
const firstHeaderIdx = cleanedText.indexOf('## ');
if (firstHeaderIdx !== -1) {
  finalBody = cleanedText.slice(firstHeaderIdx).trim();
} else {
  const firstHeaderIdx2 = cleanedText.indexOf('##');
  if (firstHeaderIdx2 !== -1) {
    finalBody = cleanedText.slice(firstHeaderIdx2).trim();
  }
}

const reportContent = `# ${company} — ${role}

- **Date:** ${today}
- **Score:** ${score}/5
- **Legitimacy:** ${legitimacy}
- **PDF:** pending

<!-- Archetype: ${archetype} -->
<!-- Tool: Gemini (${modelName}) -->

---

${finalBody}
`;

console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by Google Gemini');
console.log('═'.repeat(66) + '\n');
console.log(reportContent);

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    const num = reportId ? String(reportId).padStart(3, '0') : nextReportNumber();
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = `${num}-${companySlug}-${today}.md`;
    const reportPath = join(PATHS.reports, filename);

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);

    // Append tracker entry reminder
    console.log(`\n📊  Tracker entry (add to data/applications.md):`);
    console.log(`    | ${num} | ${today} | ${company} | ${role} | ${score} | Evaluada | ❌ | [${num}](reports/${filename}) |`);
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
