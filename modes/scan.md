# Mode: scan — Portal Scanner (Job Discovery)

Scans configured job portals, filters by title relevance, and adds new offers to the pipeline for later evaluation.

> **Note (v1.5+):** The default scanner (`scan.mjs` / `npm run scan`) is **zero-token** and only queries public APIs of Greenhouse, Ashby, and Lever directly. The levels using Playwright/WebSearch described below represent the **agentic** flow (run by Claude/Codex), not what `scan.mjs` itself does. If a company does not have a Greenhouse/Ashby/Lever API, `scan.mjs` will ignore it; in those cases, the agent must manually perform Level 1 (Playwright) or Level 3 (WebSearch).

## Recommended Execution

Run as a subagent so it doesn't consume main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

## Configuration

Read `portals.yml` which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery).
- `tracked_companies`: Specific companies with `careers_url` for direct navigation.
- `title_filter`: positive/negative/seniority_boost keywords for title filtering.

## Discovery Strategy (3 Levels)

### Level 1 — Direct Playwright (PRIMARY)

**For each company in `tracked_companies`:** Navigate to their `careers_url` with Playwright (`browser_navigate` + `browser_snapshot`), read ALL visible job listings, and extract the title + URL of each. This is the most reliable method because:
- It views the page in real-time (not Google-cached results).
- It works with SPAs (Ashby, Lever, Workday).
- It detects new offers instantly.
- It doesn't rely on Google indexing.

**Every company MUST have a `careers_url` in portals.yml.** If it doesn't have one, search for it once, save it, and use it in future scans.

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with a public API or structured feed, use the JSON/XML response as a fast complement to Level 1. It is faster than Playwright and reduces visual scraping errors.

**Current Support (variables within `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; offer details `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing Conventions by Provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build public URL if not in payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read full JD, make GET to detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (depends on tenant) → `title`, `externalPath` or URL built from host

### Level 3 — WebSearch Queries (BROAD DISCOVERY)

`search_queries` with `site:` filters cover portals transversally (all Ashby, all Greenhouse, etc.). Useful for discovering NEW companies that are not yet in `tracked_companies`, though results might be delayed.

**Execution Priority:**
1. Level 1: Playwright → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

The levels are additive — all are executed, and results are mixed and deduplicated.

## Workflow

1. **Read Configuration**: `portals.yml`
2. **Read History**: `data/scan-history.tsv` → URLs already seen.
3. **Read Dedup Sources**: `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Playwright Scan** (parallel in batches of 3-5):
   For each company in `tracked_companies` with `enabled: true` and defined `careers_url`:
   a. `browser_navigate` to the `careers_url`.
   b. `browser_snapshot` to read all job listings.
   c. If the page has filters/departments, navigate the relevant sections.
   d. For each job listing, extract: `{title, url, company}`.
   e. If the page paginates results, navigate additional pages.
   f. Accumulate in candidate list.
   g. If `careers_url` fails (404, redirect), try `scan_query` as fallback and note to update the URL.

5. **Level 2 — ATS APIs / Feeds** (parallel):
   For each company in `tracked_companies` with defined `api:` and `enabled: true`:
   a. WebFetch the API/feed URL.
   b. If `api_provider` is defined, use its parser; if not defined, infer by domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`).
   c. For **Ashby**, send POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query of `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only contains basic metadata. For each relevant item, read `id`, make GET to `https://{company}.bamboohr.com/careers/{id}/detail`, and extract the full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as public URL if it exists; otherwise use the detail URL.
   e. For **Workday**, send POST JSON with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results are exhausted.
   f. For each job, extract and normalize: `{title, url, company}`.
   g. Accumulate in candidate list (dedup with Level 1).

6. **Level 3 — WebSearch Queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Run WebSearch with the defined `query`.
   b. From each result, extract: `{title, url, company}`:
      - **title**: from result title (before " @ " or " | ").
      - **url**: result URL.
      - **company**: after " @ " in title, or extract from domain/path.
   c. Accumulate in candidate list (dedup with Level 1+2).

7. **Filter by Title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in the title (case-insensitive).
   - 0 keywords from `negative` must appear.
   - `seniority_boost` keywords give priority but are not mandatory.

8. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen.
   - `applications.md` → normalized company + role already evaluated.
   - `pipeline.md` → exact URL already in pending or processed.

8.5. **Verify Liveness of WebSearch Results (Level 3)** — BEFORE adding to pipeline:

   WebSearch results can be outdated (Google caches results for weeks or months). To avoid evaluating expired postings, verify every new Level 3 URL with Playwright. Levels 1 and 2 are inherently real-time and do not require this step.

   For each new Level 3 URL (sequential — NEVER Playwright in parallel):
   a. `browser_navigate` to the URL.
   b. `browser_snapshot` to read the content.
   c. Classify:
      - **Active**: visible job title + role description + visible Apply/Submit button in main content. Do not count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects here when posting is closed).
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found".
        - Only navbar and footer visible, no JD content (content < ~300 chars).
   d. If expired: register in `scan-history.tsv` with status `skipped_expired` and discard.
   e. If active: proceed to step 9.

   **Do not interrupt the entire scan if one URL fails.** If `browser_navigate` errors (timeout, 403, etc.), mark as `skipped_expired` and proceed to the next.

9. **For each verified new offer passing filters**:
   a. Add to `pipeline.md` under "Pendientes" (Pending): `- [ ] {url} | {company} | {title}`.
   b. Register in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`.

10. **Title-filtered offers**: register in `scan-history.tsv` with status `skipped_title`.
11. **Duplicate offers**: register with status `skipped_dup`.
12. **Expired offers (Level 3)**: register with status `skipped_expired`.

## Title and Company Extraction from WebSearch Results

WebSearch results come in formats like: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns by portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If a non-publicly accessible URL is found:
1. Save the JD to `jds/{company}-{role-slug}.md`.
2. Add to pipeline.md as: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`.

## Scan History

`data/scan-history.tsv` tracks ALL seen URLs:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output Summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries executed: N
Offers found: N total
Filtered by title: N relevant
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-ops pipeline to evaluate new offers.
```

## Managing careers_url

Each company in `tracked_companies` must have a `careers_url` — the direct link to their jobs page. This avoids searching for it every time.

**RULE: Always use the company's corporate jobs page; only fall back to the direct ATS endpoint if no corporate page exists.**

The `careers_url` should point to the company's own job page whenever available. Many companies use Workday, Greenhouse, or Lever under the hood but expose vacancy IDs only through their corporate domain. Using the direct ATS URL when a corporate page exists can cause false 410 errors because job IDs do not match.

| ✅ Correct (Corporate) | ❌ Incorrect as first choice (Direct ATS) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the direct ATS URL, navigate first to the company's main website and find their corporate careers page. Use the direct ATS URL only if the company lacks their own jobs page.

**Known Patterns by Platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; details `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** Company's own URL (e.g., `https://openai.com/careers`)

**API/Feed Patterns by Platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; details `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` does not exist** for a company:
1. Try the pattern of its known platform.
2. If it fails, perform a quick WebSearch: `"{company}" careers jobs`.
3. Navigate with Playwright to confirm it works.
4. **Save the found URL in portals.yml** for future scans.

**If `careers_url` returns 404 or redirect:**
1. Note in the output summary.
2. Try `scan_query` as a fallback.
3. Mark for manual update.

## Maintaining portals.yml

- **ALWAYS save `careers_url`** when adding a new company.
- Add new queries as interesting roles or portals are discovered.
- Disable queries with `enabled: false` if they generate too much noise.
- Adjust filtering keywords as target roles evolve.
- Add companies to `tracked_companies` when you want to track them closely.
- Periodically verify `careers_url` — companies change their ATS platforms.
