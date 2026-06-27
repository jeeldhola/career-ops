#!/usr/bin/env node

/**
 * compile-pdf.mjs — Compile HTML segments and profile metadata to formatted PDF
 *
 * Usage:
 *   node compile-pdf.mjs --json-file <jsonPath> --output-pdf <pdfPath>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  template: join(ROOT, 'templates', 'cv-template.html'),
  reports: join(ROOT, 'reports'),
};

const args = process.argv.slice(2);
let jsonFile = '';
let outputPdf = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json-file' && args[i + 1]) {
    jsonFile = args[++i];
  } else if (args[i] === '--output-pdf' && args[i + 1]) {
    outputPdf = args[++i];
  }
}

if (!jsonFile || !outputPdf) {
  console.error('❌ Error: Both --json-file and --output-pdf arguments are required.');
  process.exit(1);
}

if (!existsSync(jsonFile)) {
  console.error(`❌ Error: JSON input file not found at: ${jsonFile}`);
  process.exit(1);
}

// Read input JSON
const input = JSON.parse(readFileSync(jsonFile, 'utf-8'));
const candidate = input.candidate || {};
const htmlFields = input.html_fields || {};

// Read template
const isCoverLetter = !!input.is_cover_letter;
const templatePath = isCoverLetter
  ? join(ROOT, 'templates', 'cover-letter-template.html')
  : PATHS.template;

if (!existsSync(templatePath)) {
  console.error(`❌ Error: Template not found at: ${templatePath}`);
  process.exit(1);
}
let templateHtml = readFileSync(templatePath, 'utf-8');

// Replace Candidate Placeholders
let linkedinUrl = candidate.linkedin || '';
if (linkedinUrl && !linkedinUrl.startsWith('http')) {
  linkedinUrl = 'https://' + linkedinUrl;
}
const cleanDisplayUrl = (url) => {
  if (!url) return '';
  return url.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
};

let linkedinDisplay = cleanDisplayUrl(candidate.linkedin);

let portfolioUrl = candidate.portfolio || candidate.portfolio_url || '';
if (portfolioUrl && !portfolioUrl.startsWith('http')) {
  portfolioUrl = 'https://' + portfolioUrl;
}
let portfolioDisplay = cleanDisplayUrl(portfolioUrl);

let githubUrl = candidate.github || '';
if (githubUrl && !githubUrl.startsWith('http')) {
  githubUrl = 'https://' + githubUrl;
}
let githubDisplay = cleanDisplayUrl(githubUrl);

templateHtml = templateHtml
  .replace(/{{NAME}}/g, candidate.fullName || candidate.full_name || '')
  .replace(/{{EMAIL}}/g, candidate.email || '')
  .replace(/{{LOCATION}}/g, candidate.location || '')
  .replace(/{{LINKEDIN_URL}}/g, linkedinUrl)
  .replace(/{{LINKEDIN_DISPLAY}}/g, linkedinDisplay)
  .replace(/{{GITHUB_URL}}/g, githubUrl)
  .replace(/{{GITHUB_DISPLAY}}/g, githubDisplay)
  .replace(/{{PORTFOLIO_URL}}/g, portfolioUrl)
  .replace(/{{PORTFOLIO_DISPLAY}}/g, portfolioDisplay);

// Handle conditional spans (phone, github, portfolio, target role)
const targetRole = htmlFields.TARGET_ROLE || candidate.targetRole || '';
if (targetRole) {
  templateHtml = templateHtml.replace(/{{TARGET_ROLE}}/g, targetRole);
} else {
  templateHtml = templateHtml.replace(/<span class="role-span">[\s\S]*?<\/span>/g, '');
}

const phone = candidate.phone || '';
if (phone) {
  templateHtml = templateHtml.replace(/{{PHONE}}/g, phone);
} else {
  templateHtml = templateHtml.replace(/<span class="phone-span">[\s\S]*?<\/span>/g, '');
}

if (!githubUrl) {
  templateHtml = templateHtml.replace(/<span class="github-span">[\s\S]*?<\/span>/g, '');
}

if (!portfolioUrl) {
  templateHtml = templateHtml.replace(/<span class="portfolio-span">[\s\S]*?<\/span>/g, '');
}

// Fill HTML fields
const placeholders = isCoverLetter
  ? ['LANG', 'PAGE_WIDTH', 'TARGET_ROLE', 'DATE', 'RECIPIENT', 'SUBJECT', 'SALUTATION', 'BODY', 'SIGNOFF']
  : [
      'LANG', 'PAGE_WIDTH', 'TARGET_ROLE', 'SECTION_SUMMARY', 'SUMMARY_TEXT',
      'SECTION_COMPETENCIES', 'COMPETENCIES', 'SECTION_EXPERIENCE', 'EXPERIENCE',
      'SECTION_PROJECTS', 'PROJECTS', 'SECTION_EDUCATION', 'EDUCATION',
      'SECTION_CERTIFICATIONS', 'CERTIFICATIONS', 'SECTION_SKILLS', 'SKILLS'
    ];

placeholders.forEach(ph => {
  const val = htmlFields[ph] || '';
  templateHtml = templateHtml.replace(new RegExp(`{{${ph}}}`, 'g'), val);
});

// Resolve font paths to absolute file:// URLs
const fontsDir = resolve(ROOT, 'fonts');
templateHtml = templateHtml.replace(
  /url\(['"]?\.\/fonts\//g,
  `url('file://${fontsDir.replace(/\\/g, '/')}/`
);
templateHtml = templateHtml.replace(
  /file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g,
  `file://$1.$2')`
);

// Compile to PDF using Playwright
console.log(`📄 Generating PDF: ${outputPdf}`);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Set content and resolve relative assets
  await page.setContent(templateHtml, {
    waitUntil: 'networkidle',
    baseURL: `file://${PATHS.reports.replace(/\\/g, '/')}/`,
  });

  await page.evaluate(() => document.fonts.ready);

  const paperFormat = (htmlFields.PAGE_WIDTH || '').includes('8.5in') ? 'letter' : 'a4';

  await page.pdf({
    path: outputPdf,
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
  console.log(`✅ PDF CV compiled successfully.`);
} catch (err) {
  console.error(`❌ Playwright PDF compile failed: ${err.message}`);
  if (browser) {
    try { await browser.close(); } catch (_) { }
  }
  process.exit(1);
}
