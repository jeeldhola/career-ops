#!/usr/bin/env node

/**
 * rank-jobs.mjs — Rank a list of jobs against candidate CV using Gemini
 *
 * Reads a list of jobs from a JSON file, evaluates and ranks them, and outputs
 * a JSON array to stdout.
 *
 * Usage:
 *   node rank-jobs.mjs --jobs-file <path> [--top <n>]
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  cv: join(ROOT, 'cv.md'),
  profile: join(ROOT, 'config', 'profile.yml'),
};

const args = process.argv.slice(2);
let jobsFile = '';
let top = 5;
let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jobs-file' && args[i + 1]) {
    jobsFile = args[++i];
  } else if (args[i] === '--top' && args[i + 1]) {
    top = parseInt(args[++i]) || 5;
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  }
}

if (modelName === 'gemini-2.5-flash') {
  modelName = 'gemini-2.5-flash';
}

if (!jobsFile) {
  console.error('❌  Error: --jobs-file is required.');
  process.exit(1);
}

if (!existsSync(jobsFile)) {
  console.error(`❌  Error: Jobs file not found at: ${jobsFile}`);
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

(async () => {
  let rawJobs = [];
  try {
    rawJobs = JSON.parse(readFileSync(jobsFile, 'utf-8'));
  } catch (err) {
    console.error(`❌  Error: Failed to parse jobs-file as JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    // Return empty list if no input jobs
    console.log('[]');
    process.exit(0);
  }

  // Load CV and candidate context
  const cvContent = readFile(PATHS.cv, 'cv.md');

  // We only send the title, company, and description (shortened) of each job to stay under token limits
  const jobsForLlm = rawJobs.map((j, idx) => ({
    id: idx + 1,
    title: j.title || j.role || 'Unknown Role',
    company: j.company || 'Unknown Company',
    description: (j.description || '').slice(0, 800)
  }));

  const rankSystemPrompt = `You are career-ops.
Your job is to rank the list of job postings in order of matching relevance to the candidate's CV.
Select the top ${top} best matching jobs.

Output your response as a valid JSON array only. Do not wrap it in markdown block or any text.
The JSON array should contain objects with this schema:
[
  {
    "rank": 1,
    "title": "Job Title",
    "company": "Company Name",
    "url": "Original job posting URL",
    "match_score": 4.5, // decimal value between 1.0 and 5.0
    "match_reason": "Detailed explanation of why this job matches the CV profile",
    "archetype": "Detected role archetype",
    "key_alignment": ["Point 1", "Point 2"], // list of main strengths
    "potential_gaps": ["Gap 1", "Gap 2"] // list of gaps or areas where the candidate falls short
  }
]
`;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function callLLM(systemPrompt, userPrompt, jsonMode = true) {
    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const modelOptions = { model: modelName };
        if (jsonMode) {
          modelOptions.generationConfig = { responseMimeType: "application/json" };
        }
        const model = genAI.getGenerativeModel(modelOptions);
        const result = await model.generateContent([
          { text: systemPrompt },
          { text: userPrompt }
        ]);
        return result.response.text();
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
            temperature: 0.2
          };
          if (jsonMode) {
            body.response_format = { type: "json_object" };
          }

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

  try {
    const userPrompt = `CANDIDATE RESUME:\n${cvContent}\n\nLIST OF JOBS TO RANK:\n${JSON.stringify(jobsForLlm, null, 2)}\n\n(IMPORTANT: Map each output job back to its original URL from the jobs list)`;
    const responseText = await callLLM(rankSystemPrompt, userPrompt, true);

    // Parse the response to ensure it's valid JSON, then print it
    const rankedList = JSON.parse(responseText);

    // Map URL back to the output list (since LLM matches by title/company)
    const finalRanked = rankedList.map((item, index) => {
      // Find matching job in rawJobs to get URL
      const matchingJob = rawJobs.find(rj =>
        (rj.title || rj.role || '').toLowerCase() === item.title.toLowerCase() &&
        (rj.company || '').toLowerCase() === item.company.toLowerCase()
      ) || rawJobs[index] || {};

      return {
        rank: item.rank || (index + 1),
        title: item.title,
        company: item.company,
        url: matchingJob.url || matchingJob.job_url || item.url || '',
        match_score: item.match_score || 3.5,
        match_reason: item.match_reason || 'Matched via CV query.',
        archetype: item.archetype || 'General',
        key_alignment: item.key_alignment || [],
        potential_gaps: item.potential_gaps || []
      };
    });

    console.log(JSON.stringify(finalRanked, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('❌  Gemini ranking call or JSON parsing failed:', err.message);
    process.exit(1);
  }
})();
