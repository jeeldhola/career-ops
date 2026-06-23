#!/usr/bin/env node

/**
 * scrape-jd.mjs — Scrape job description text via Playwright
 *
 * Takes a job listing URL as an argument, loads it in headless Chromium,
 * extracts the page's text content, and writes it to stdout.
 *
 * Usage:
 *   node scrape-jd.mjs <url>
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scrape-jd.mjs <url>");
  process.exit(1);
}

const url = args[0];

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    
    // Navigate to URL
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for hydration (SPAs)
    await page.waitForTimeout(3000);
    
    // Extract page content
    const pageText = await page.evaluate(() => {
      // List of non-essential elements to strip
      const selectorsToRemove = [
        'nav', 'header', 'footer', 'script', 'style', 'iframe', 'noscript',
        '.header', '.footer', '#header', '#footer', '.nav', '.navigation',
        '.cookie-banner', '.cookie-consent', '.modal'
      ];
      
      // Clone body to avoid mutating the live DOM
      const doc = document.body.cloneNode(true);
      
      // Remove noisy elements
      selectorsToRemove.forEach(sel => {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      });
      
      return doc.innerText || doc.textContent || '';
    });
    
    const cleanText = pageText.trim();
    if (cleanText.length < 50) {
      // Fallback: if cleaning stripped too much, just return the raw body innerText
      const rawText = await page.evaluate(() => document.body?.innerText ?? '');
      console.log(rawText.trim());
    } else {
      console.log(cleanText);
    }
    
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error(`Scrape error: ${err.message}`);
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // ignore close errors
      }
    }
    process.exit(1);
  }
})();
