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
  cv:      join(ROOT, 'cv.md'),
  profile: join(ROOT, 'config', 'profile.yml'),
};

const args = process.argv.slice(2);
let jobsFile = '';
let top = 5;
let modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

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
  modelName = 'gemini-2.0-flash';
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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  try {
    const result = await model.generateContent([
      { text: rankSystemPrompt },
      { text: `CANDIDATE RESUME:\n${cvContent}\n\nLIST OF JOBS TO RANK:\n${JSON.stringify(jobsForLlm, null, 2)}\n\n(IMPORTANT: Map each output job back to its original URL from the jobs list)` }
    ]);
    const responseText = result.response.text();
    
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
