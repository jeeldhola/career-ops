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
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
  tracker: join(ROOT, 'data', 'applications.md'),
};

// Parse command line arguments
const args = process.argv.slice(2);
let url = '';
let companyArg = '';
let roleArg = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
let metadataFile = '';
let reportId = '';

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
  } else if (args[i] === '--report-id' && args[i + 1]) {
    reportId = args[++i];
  }
}

if (modelName === 'gemini-2.5-flash') {
  modelName = 'gemini-2.5-flash';
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
      try { await browser.close(); } catch (_) { }
    }
    process.exit(1);
  }

  jdText = jdText.trim();
  if (jdText.length < 100) {
    console.error('❌  Error: Scraped job description text is too short (< 100 chars).');
    process.exit(1);
  }

  // 2. Load context files
  const sharedContext = readFile(PATHS.shared, 'modes/_shared.md');
  const ofertaLogic = readFile(PATHS.oferta, 'modes/oferta.md');
  const cvContent = readFile(PATHS.cv, 'cv.md');

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

  // 4. Call LLM API
  let evaluationText = '';
  try {
    evaluationText = await callLLM(systemPrompt, `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}`, metadataFile);
  } catch (err) {
    console.error('❌  Evaluation failed:', err.message);
    process.exit(1);
  }

  // 5. Parse evaluation score summary
  const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  let company = companyArg || 'unknown';
  let role = roleArg || 'unknown';
  let score = '?';
  let archetype = 'unknown';
  let legitimacy = 'unknown';

  if (summaryMatch) {
    const block = summaryMatch[1];
    const extract = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : 'unknown';
    };
    company = companyArg || extract('COMPANY');
    role = roleArg || extract('ROLE');
    score = extract('SCORE');
    archetype = extract('ARCHETYPE');
    legitimacy = extract('LEGITIMACY');
  }

  // 6. Save markdown report to reports/
  let filename = '';
  let num = '001';
  let reportContent = '';
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    num = reportId ? String(reportId).padStart(3, '0') : nextReportNumber();
    const today = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    filename = `${num}-${companySlug}-${today}.md`;
    const reportPath = join(PATHS.reports, filename);

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

    reportContent = `# ${company} — ${role}

- **Date:** ${today}
- **Score:** ${score}/5
- **Legitimacy:** ${legitimacy}
- **PDF:** pending
- **URL:** ${url}

<!-- Archetype: ${archetype} -->
<!-- Tool: Gemini (${modelName}) -->

---

${finalBody}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
  } catch (err) {
    console.error(`⚠️  Could not save report: ${err.message}`);
  }

  // 8. Output full evaluation and final JSON summary block
  console.log(reportContent || evaluationText);
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
