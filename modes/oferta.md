# Mode: oferta — Full Evaluation A-G (Ultra-Concise)

**CRITICAL RULE OF BREVITY:**
This report must be extremely short (under 300 words total). Avoid all tables, boilerplate text, and introductions. Use bullet points and single-sentence answers. No section should have more than 2-3 lines.

When the candidate inputs a job offer, generate the following blocks:

## Step 0 — Archetype Detection
- Archetype: <detected archetype>

## Block A — Role Summary
- **TL;DR**: [1-sentence summary of the role]
- **Key Info**: [Domain, Seniority, Remote status, and Team size if mentioned]

## Block B — CV Match
- **Key Matches**: [2-3 brief bullet points mapping key JD requirements to CV skills]
- **Gaps & Mitigation**: [Max 2 gaps, each with a 1-sentence mitigation strategy]

## Block C — Leveling & Strategy
- **Leveling**: [1-sentence comparing JD level vs candidate natural level]
- **Strategy**: [1-sentence tip to position candidate as senior]

## Block D — Comp & Market Demand
- **Comp**: [1-sentence estimate of salary range and market competitiveness]
- **Demand**: [1-sentence trend on market demand]

## Block E — Tailoring Plan
- **CV & LinkedIn Changes**: [Max 2 key modifications to highlight target skills]

## Block F — Interview Plan
- **Key STAR Stories**: [Max 2 short stories matching JD, each in 1 sentence]
- **Case Study**: [1-sentence recommendation]
- **Red Flag**: [1 critical question and 1-sentence response]

## Block G — Posting Legitimacy
- **Assessment**: [High Confidence / Proceed with Caution / Suspicious]
- **Key Signals**: [2 brief bullet points explaining the assessment]

---

## Post-evaluation

**ALWAYS** after generating blocks A-G:

### 1. Save Report .md

Save the complete evaluation to `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = next sequential number (3 digits, zero-padded)
- `{company-slug}` = lowercase company name, no spaces (use hyphens)
- `{YYYY-MM-DD}` = current date

**Report format:**

```markdown
# Evaluation: {Company} — {Role}

**Date:** {YYYY-MM-DD} | **Archetype:** {detected} | **Score:** {X/5} | **Legitimacy:** {Assessment}

---

## A) Role Summary
(Block A content)

## B) CV Match
(Block B content)

## C) Leveling & Strategy
(Block C content)

## D) Comp & Market Demand
(Block D content)

## E) Tailoring Plan
(Block E content)

## F) Interview Plan
(Block F content)

## G) Posting Legitimacy
(Block G content)
```

### 2. Register in Tracker

**ALWAYS** register in `data/applications.md`:
- Next sequential number
- Current date
- Company
- Role
- Score: average match (1-5)
- Status: `Evaluada`
- PDF: ❌
- Report: relative link to the report .md (e.g. `[001](reports/001-company-2026-01-01.md)`)

**Tracker format:**

```markdown
| # | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
```
