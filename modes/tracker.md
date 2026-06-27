# Mode: tracker — Application Tracker

Reads and displays `data/applications.md`.

**Tracker Format:**
```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```

Possible statuses: `Evaluated` → `Applied` → `Responded` → `Contacted` → `Interview` → `Offer` / `Rejected` / `Discarded` / `SKIP`

- `Applied` = the candidate submitted their application.
- `Responded` = a recruiter/company reached out and the candidate responded (inbound).
- `Contacted` = the candidate proactively reached out to someone at the company (outbound, e.g., LinkedIn power move).

If the user requests to update a status, edit the corresponding row.

Also display statistics:
- Total applications
- By status
- Average score
- % with generated PDF
- % with generated report
