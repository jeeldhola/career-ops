#!/usr/bin/env node

/**
 * tailor-cv.mjs — Tailor resume and generate PDF
 *
 * Usage:
 *   node tailor-cv.mjs [--url <url> --company <company> --role <role>] [--report-id <id>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// Bootstrap environment variables
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // optional
}

import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  shared:       join(ROOT, 'modes', '_shared.md'),
  oferta:       join(ROOT, 'modes', 'oferta.md'),
  pdfMode:      join(ROOT, 'modes', 'pdf.md'),
  cv:           join(ROOT, 'cv.md'),
  reports:      join(ROOT, 'reports'),
  profile:      join(ROOT, 'config', 'profile.yml'),
  template:     join(ROOT, 'templates', 'cv-template.html'),
};

const args = process.argv.slice(2);
let url = '';
let companyArg = '';
let roleArg = '';
let reportId = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    url = args[++i];
  } else if (args[i] === '--company' && args[i + 1]) {
    companyArg = args[++i];
  } else if (args[i] === '--role' && args[i + 1]) {
    roleArg = args[++i];
  } else if (args[i] === '--report-id' && args[i + 1]) {
    reportId = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  }
}

if (modelName === 'gemini-2.5-flash') {
  modelName = 'gemini-2.0-flash';
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
  let finalReportId = null;
  let reportContent = '';
  let jdText = '';

  // ── STEP 1: Get/Generate Job Description & Report ────────────────────────
  if (url) {
    // We are given a URL — scrape and evaluate first
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      jdText = await page.evaluate(() => {
        const selectorsToRemove = ['nav', 'header', 'footer', 'script', 'style', 'iframe', 'noscript'];
        const doc = document.body.cloneNode(true);
        selectorsToRemove.forEach(sel => {
          doc.querySelectorAll(sel).forEach(el => el.remove());
        });
        return doc.innerText || doc.textContent || '';
      });
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
      console.error('❌  Error: Scraped job description text is too short.');
      process.exit(1);
    }

    // Call Gemini to get evaluation report
    const sharedContext  = readFile(PATHS.shared, 'modes/_shared.md');
    const ofertaLogic    = readFile(PATHS.oferta, 'modes/oferta.md');
    const cvContent      = readFile(PATHS.cv,     'cv.md');

    const evalSystemPrompt = `You are career-ops. Evaluate job against CV. Output full report and SCORE_SUMMARY.`;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    
    let evaluationText = '';
    try {
      const result = await model.generateContent([
        { text: evalSystemPrompt },
        { text: `CANDIDATE RESUME:\n${cvContent}\n\nEVAL LOGIC:\n${sharedContext}\n${ofertaLogic}\n\nJOB DESCRIPTION:\n${jdText}` }
      ]);
      evaluationText = result.response.text();
    } catch (err) {
      console.error('❌  Gemini evaluation failed:', err.message);
      process.exit(1);
    }

    // Save report
    const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
    let company = companyArg || 'unknown';
    let role = roleArg || 'unknown';
    let score = '3.0';
    if (summaryMatch) {
      const block = summaryMatch[1];
      const mC = block.match(/COMPANY:\s*(.+)/);
      const mR = block.match(/ROLE:\s*(.+)/);
      const mS = block.match(/SCORE:\s*(.+)/);
      company = companyArg || (mC ? mC[1].trim() : 'unknown');
      role = roleArg || (mR ? mR[1].trim() : 'unknown');
      score = mS ? mS[1].trim() : '3.0';
    }

    const num = nextReportNumber();
    finalReportId = parseInt(num);
    const today = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = `${num}-${companySlug}-${today}.md`;
    const reportPath = join(PATHS.reports, filename);

    reportContent = `# Evaluation: ${company} — ${role}
Score: ${score}/5
Date: ${today}

${evaluationText}`;

    writeFileSync(reportPath, reportContent, 'utf-8');
  } else if (reportId) {
    // Find the report file in reports/ matching 0XX-*.md
    finalReportId = parseInt(reportId);
    const prefix = String(finalReportId).padStart(3, '0');
    const files = readdirSync(PATHS.reports);
    const filename = files.find(f => f.startsWith(prefix) && f.endsWith('.md'));
    if (!filename) {
      console.error(`❌  Error: Report not found for ID: ${reportId}`);
      process.exit(1);
    }
    reportContent = readFile(join(PATHS.reports, filename), `reports/${filename}`);
  } else {
    console.error('❌  Error: Either --url or --report-id is required.');
    process.exit(1);
  }

  // ── STEP 2: Load cv.md & profile.yml ──────────────────────────────────────
  const cvContent = readFile(PATHS.cv, 'cv.md');
  const pdfModeLogic = readFile(PATHS.pdfMode, 'modes/pdf.md');

  let profile = {};
  if (existsSync(PATHS.profile)) {
    try {
      profile = yaml.load(readFileSync(PATHS.profile, 'utf-8')) || {};
    } catch (err) {
      console.warn(`⚠️  Could not read profile.yml: ${err.message}`);
    }
  }

  // ── STEP 3: Call Gemini to generate tailored fields ─────────────────────
  console.log(`🤖  Tailoring resume using Gemini (${modelName})...`);

  const tailorSystemPrompt = `You are career-ops.
Your job is to tailor the candidate's cv.md to match the provided job description/evaluation report.
Follow the rules in pdf.md exactly. Do not invent any experience, only adjust emphasis and language.

Output your response as a valid JSON object only. Do not wrap it in markdown block or any text.
The JSON object must contain the following keys representing HTML CV segments:
- LANG: either "en" or "es"
- PAGE_WIDTH: "8.5in" (if company is in US/Canada) or "210mm" (else)
- SECTION_SUMMARY: section title (e.g. "Professional Summary")
- SUMMARY_TEXT: customized professional summary text rich in JD keywords
- SECTION_COMPETENCIES: section title (e.g. "Core Competencies")
- COMPETENCIES: HTML string of span tags, e.g. "<span class=\\"competency-tag\\">Keyword</span>" (6-8 tags)
- SECTION_EXPERIENCE: section title (e.g. "Work Experience")
- EXPERIENCE: HTML string representing all work experiences. Each job is inside:
  <div class="job">
    <div class="job-header">
      <span class="job-company">Company Name</span>
      <span class="job-period">Period</span>
    </div>
    <div class="job-role">Role <span class="job-location">Location</span></div>
    <ul>
      <li>Bullet point 1...</li>
    </ul>
  </div>
- SECTION_PROJECTS: section title (e.g. "Projects")
- PROJECTS: HTML string representing top 3-4 relevant projects:
  <div class="project">
    <div class="project-title">Project Name <span class="project-badge">Status/Type</span></div>
    <div class="project-desc">Description...</div>
    <div class="project-tech">Tech Stack...</div>
  </div>
- SECTION_EDUCATION: section title
- EDUCATION: HTML string of education items:
  <div class="edu-item">
    <div class="edu-header">
      <span class="edu-title">Degree</span>
      <span class="edu-org">School</span>
      <span class="edu-year">Year</span>
    </div>
    <div class="edu-desc">Details...</div>
  </div>
- SECTION_CERTIFICATIONS: section title
- CERTIFICATIONS: HTML string of certifications:
  <div class="cert-item">
    <span class="cert-title">Cert, <span class="cert-org">Issuer</span></span>
    <span class="cert-year">Year</span>
  </div>
- SECTION_SKILLS: section title
- SKILLS: HTML string of skills list:
  <div class="skills-grid">
    <div class="skill-item"><span class="skill-category">Technical:</span> Skill 1, Skill 2</div>
  </div>
`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  let tailoredData = {};
  try {
    const result = await model.generateContent([
      { text: tailorSystemPrompt },
      { text: `CANDIDATE GENERAL CV:\n${cvContent}\n\nTAILORING METHODOLOGY (pdf.md):\n${pdfModeLogic}\n\nEVALUATION REPORT/JD CONTEXT:\n${reportContent}` }
    ]);
    const responseText = result.response.text();
    tailoredData = JSON.parse(responseText);
  } catch (err) {
    console.error('❌  Gemini tailoring call or JSON parsing failed:', err.message);
    process.exit(1);
  }

  // ── STEP 4: Render Template HTML ──────────────────────────────────────────
  let templateHtml = readFile(PATHS.template, 'cv-template.html');

  // Fill personal profile values
  templateHtml = templateHtml
    .replace(/{{NAME}}/g, profile.name || '')
    .replace(/{{EMAIL}}/g, profile.email || '')
    .replace(/{{LOCATION}}/g, profile.location || '')
    .replace(/{{LINKEDIN_URL}}/g, profile.linkedin?.url || '')
    .replace(/{{LINKEDIN_DISPLAY}}/g, profile.linkedin?.display || '')
    .replace(/{{PORTFOLIO_URL}}/g, profile.portfolio?.url || '')
    .replace(/{{PORTFOLIO_DISPLAY}}/g, profile.portfolio?.display || '');

  // Handle phone and its separator cleanly
  if (profile.phone) {
    templateHtml = templateHtml.replace(/{{PHONE}}/g, profile.phone);
  } else {
    // Remove the phone placeholder span and the trailing separator
    templateHtml = templateHtml
      .replace(/<span>{{PHONE}}<\/span>/g, '')
      .replace(/<span class="separator">\|<\/span>/, '');
  }

  // Fill tailored fields
  const placeholders = [
    'LANG', 'PAGE_WIDTH', 'SECTION_SUMMARY', 'SUMMARY_TEXT',
    'SECTION_COMPETENCIES', 'COMPETENCIES', 'SECTION_EXPERIENCE', 'EXPERIENCE',
    'SECTION_PROJECTS', 'PROJECTS', 'SECTION_EDUCATION', 'EDUCATION',
    'SECTION_CERTIFICATIONS', 'CERTIFICATIONS', 'SECTION_SKILLS', 'SKILLS'
  ];

  placeholders.forEach(ph => {
    const val = tailoredData[ph] || '';
    templateHtml = templateHtml.replace(new RegExp(`{{${ph}}}`, 'g'), val);
  });

  // Resolve font paths to absolute file:// URLs so Playwright loaded content compiles with local fonts
  const fontsDir = resolve(ROOT, 'fonts');
  templateHtml = templateHtml.replace(
    /url\(['"]?\.\/fonts\//g,
    `url('file://${fontsDir.replace(/\\/g, '/')}/`
  );
  templateHtml = templateHtml.replace(
    /file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g,
    `file://$1.$2')`
  );

  // ── STEP 5: Compile to PDF ───────────────────────────────────────────────
  const prefix = String(finalReportId).padStart(3, '0');
  const files = readdirSync(PATHS.reports);
  const reportFilename = files.find(f => f.startsWith(prefix) && f.endsWith('.md'));
  
  const pdfFilename = reportFilename.replace('.md', '.pdf');
  const tempHtmlPath = join(PATHS.reports, `temp-${prefix}.html`);
  const finalPdfPath = join(PATHS.reports, pdfFilename);

  writeFileSync(tempHtmlPath, templateHtml, 'utf-8');

  console.log(`📄 Generating PDF: ${finalPdfPath}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Set content and resolve relative assets locally
    await page.setContent(templateHtml, {
      waitUntil: 'networkidle',
      baseURL: `file://${PATHS.reports.replace(/\\/g, '/')}/`,
    });
    
    await page.evaluate(() => document.fonts.ready);
    
    const paperFormat = (tailoredData.PAGE_WIDTH || '').includes('8.5in') ? 'letter' : 'a4';

    await page.pdf({
      path: finalPdfPath,
      format: paperFormat,
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.6in',
        bottom: '0.6in',
        left: '0.6in',
      },
      preferCSSPageSize: false,
    });
    
    await browser.close();
    console.log(`✅ CV Tailored & Saved successfully.`);
  } catch (err) {
    console.error(`❌ Playwright PDF compile failed: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    try { unlinkSync(tempHtmlPath); } catch (_) {}
    process.exit(1);
  }

  // Cleanup temporary HTML file
  try {
    unlinkSync(tempHtmlPath);
  } catch (_) {}

  // Output JSON Summary for python endpoints
  console.log('\n---JSON_SUMMARY---');
  console.log(JSON.stringify({
    report_id: finalReportId,
    pdf_path: finalPdfPath
  }, null, 2));
  console.log('---END_JSON_SUMMARY---');
})();
