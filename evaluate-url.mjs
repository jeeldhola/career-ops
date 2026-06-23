#!/usr/bin/env node

/**
 * evaluate-url.mjs — Scrape and Evaluate a Job Offer from a URL via Gemini
 *
 * Scrapes job listing URL using Playwright, calls Gemini, writes a report to
 * reports/0XX-company-date.md, and outputs the markdown content along with
 * a JSON summary block for python integration.
 *
 * Usage:
 *   node evaluate-url.mjs --url <url> [--company <company>] [--role <role>] [--model <model>] [--metadata-file <path>]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

// Bootstrap environment variables from .env
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional
}

import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  shared:   join(ROOT, 'modes', '_shared.md'),
  oferta:   join(ROOT, 'modes', 'oferta.md'),
  cv:       join(ROOT, 'cv.md'),
  reports:  join(ROOT, 'reports'),
  tracker:  join(ROOT, 'data', 'applications.md'),
};

// Parse command line arguments
const args = process.argv.slice(2);
let url = '';
let companyArg = '';
let roleArg = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
let metadataFile = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    url = args[++i];
  } else if (args[i] === '--company' && args[i + 1]) {
    companyArg = args[++i];
  } else if (args[i] === '--role' && args[i + 1]) {
    roleArg = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--metadata-file' && args[i + 1]) {
    metadataFile = args[++i];
  }
}

if (modelName === 'gemini-2.5-flash') {
  modelName = 'gemini-2.0-flash';
}

if (!url) {
  console.error('❌  Error: --url is required.');
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌  Error: GEMINI_API_KEY not configured.');
  process.exit(1);
}

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

(async () => {
  let browser;
  let jdText = '';
  
  // 1. Scrape the URL
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    jdText = await page.evaluate(() => {
      const selectorsToRemove = [
        'nav', 'header', 'footer', 'script', 'style', 'iframe', 'noscript',
        '.header', '.footer', '#header', '#footer', '.nav', '.navigation',
        '.cookie-banner', '.cookie-consent', '.modal'
      ];
      const doc = document.body.cloneNode(true);
      selectorsToRemove.forEach(sel => {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      });
      return doc.innerText || doc.textContent || '';
    });
    
    if (!jdText || jdText.trim().length < 50) {
      jdText = await page.evaluate(() => document.body?.innerText ?? '');
    }
    
    await browser.close();
  } catch (err) {
    console.error(`Scrape failed: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    process.exit(1);
  }

  jdText = jdText.trim();
  if (jdText.length < 100) {
    console.error('❌  Error: Scraped job description text is too short (< 100 chars).');
    process.exit(1);
  }

  // 2. Load context files
  const sharedContext  = readFile(PATHS.shared,   'modes/_shared.md');
  const ofertaLogic    = readFile(PATHS.oferta,   'modes/oferta.md');
  const cvContent      = readFile(PATHS.cv,       'cv.md');

  // 3. Formulate the system prompt
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
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

  // 4. Call Gemini API
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
    },
  });

  let evaluationText = '';
  let usage = null;
  try {
    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
    ]);
    evaluationText = result.response.text();
    usage = result.response.usageMetadata;
  } catch (err) {
    console.error('❌  Gemini API error:', err.message);
    process.exit(1);
  }

  // 5. Parse evaluation score summary
  const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  let company    = companyArg || 'unknown';
  let role       = roleArg || 'unknown';
  let score      = '?';
  let archetype  = 'unknown';
  let legitimacy = 'unknown';

  if (summaryMatch) {
    const block = summaryMatch[1];
    const extract = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : 'unknown';
    };
    company    = companyArg || extract('COMPANY');
    role       = roleArg || extract('ROLE');
    score      = extract('SCORE');
    archetype  = extract('ARCHETYPE');
    legitimacy = extract('LEGITIMACY');
  }

  // 6. Save markdown report to reports/
  let filename = '';
  let num = '001';
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    num               = nextReportNumber();
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    filename          = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
  } catch (err) {
    console.error(`⚠️  Could not save report: ${err.message}`);
  }

  // 7. Write usageMetadata JSON file if requested
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

  // 8. Output full evaluation and final JSON summary block
  console.log(evaluationText);
  console.log('\n---JSON_SUMMARY---');
  console.log(JSON.stringify({
    report_id: parseInt(num) || 0,
    company: company,
    role: role,
    score: score,
    filename: filename
  }, null, 2));
  console.log('---END_JSON_SUMMARY---');
})();
