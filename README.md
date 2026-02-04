<div align="center">
<img alt="ScholarPulse Banner" src="./scholarpulse.jfif" />
</div>

# ScholarPulse

An AI-powered academic paper tracking and literature review tool. Automatically syncs emails from academic alert services (Google Scholar, bioRxiv, Nature, etc.), extracts papers using Gemini AI, and generates daily literature reviews.

Details, can be seen in [ACADEMIC_REPORT](./ACADEMIC_REPORT.md)

| Feature | Manual Alerts | Reference Managers | ScholarPulse |
|---------|---------------|-------------------|--------------|
| Automatic email processing | No | Partial | Yes |
| AI relevance scoring | No | No | Yes |
| Source quality weighting | No | No | Yes |
| Automated literature review | No | No | Yes |
| Multi-source aggregation | Manual | Limited | Automatic |
| Scheduled operation | No | No | Yes |
| Custom keyword filtering | No | Yes | Yes |

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Run as Background Service (pm2)

To keep the app running persistently (survives terminal close):

1. Install pm2:
   ```bash
   npm install -g pm2
   ```

2. Start the app:
   ```bash
   pm2 start "npm run dev" --name scholarpulse
   ```

3. Save and enable auto-start on reboot:
   ```bash
   pm2 save
   pm2 startup
   ```
   Then run the sudo command it outputs.

**Useful pm2 commands:**
- `pm2 status` - Check status
- `pm2 logs scholarpulse` - View logs
- `pm2 restart scholarpulse` - Restart app
- `pm2 stop scholarpulse` - Stop app

## Scheduled Daily Reports

The app includes a scheduler that automatically generates daily reports from synced emails at a configured time.

### Setup Scheduler

1. Start the scheduler as a separate pm2 process:
   ```bash
   pm2 start "npm run scheduler" --name scholarpulse-scheduler
   ```

2. To generate a report immediately on startup:
   ```bash
   pm2 start "npm run scheduler:now" --name scholarpulse-scheduler
   ```

3. Save pm2 configuration:
   ```bash
   pm2 save
   ```

### Configure Schedule

You can configure the scheduler via the web UI or by editing `scheduler.config.json`:

**Via Web UI:**
1. Go to Settings
2. Find the "Scheduled Reports" section
3. Enable/disable scheduling, set time and timezone
4. Restart the scheduler: `pm2 restart scholarpulse-scheduler`

**Via Config File (`scheduler.config.json`):**
```json
{
  "enabled": true,
  "time": "08:00",
  "timezone": "Asia/Shanghai",
  "syncEnabled": true,
  "syncHours": 24,
  "syncLimit": 200,
  "reuseRecentSyncMinutes": 60,
  "batchSize": 20,
  "batchDelaySeconds": 5,
  "analysisLimit": 200,
  "minScore": 10
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable the scheduler |
| `time` | Daily run time (HH:mm format) |
| `timezone` | Timezone for scheduling |
| `syncEnabled` | Auto-sync emails from Gmail before processing |
| `syncHours` | Hours of emails to fetch (e.g., 24 = last 24 hours) |
| `syncLimit` | Maximum number of emails to fetch |
| `reuseRecentSyncMinutes` | Skip Gmail sync if a sync file exists within this time (0 = always sync) |
| `batchSize` | Number of emails to process per batch |
| `batchDelaySeconds` | Delay between batches in seconds (helps with rate limiting, 0 = no delay) |
| `analysisLimit` | Maximum papers to analyze per batch |
| `minScore` | Minimum relevance score to include papers |

### Paper Title Validation & Hallucination Detection

The scheduler includes automatic validation to detect AI hallucinations (papers that don't exist in the original emails):

**How it works:**
1. After paper extraction, each paper title is validated against the original email content
2. Multiple matching strategies are used: exact match, normalized match (ignoring case/punctuation), and partial match
3. Papers not found in the original emails are flagged as potential hallucinations
4. A refined analysis file is generated with hallucinated papers removed
5. The initial extraction file is automatically deleted, leaving only the refined version

**Validation output:**
```
[Scheduler] Validation: 45/50 papers validated (90.0%)
[Scheduler] ⚠️  5 papers not found in emails (potential hallucinations)
[Scheduler]   - Paper Title That Was Hallucinated...
[Scheduler] Generating refined analysis (removing hallucinations)...
[Scheduler] Refined: 45 papers kept, 5 removed
```

**Manual validation:**
```bash
# Validate the most recent extraction
npm run validate

# Validate and generate refined files (removes hallucinations)
npm run validate:refine

# Validate specific files
npx tsx scripts/validatePaperTitles.ts --sync synced_emails/sync-xxx.json --analysis synced_emails/analysis-xxx.json
```

**Refined output files:**
- `synced_emails/analysis-{timestamp}.json` - Refined analysis with validated papers only
- `reports/daily_review_refined_{timestamp}.md` - Full literature review (Gemini-generated)
- `reports/daily_papers_refined_{timestamp}.md` - Simple paper list for easy copying

### Smart Extraction Skipping

The scheduler intelligently avoids redundant paper extraction:

- **If today's paper list already exists** (`daily_papers_YYYY-MM-DD*.md` in `reports/`):
  - Skips Gmail sync
  - Skips AI paper extraction
  - Skips generating new paper list
  - **Still generates** a fresh `daily_review_*.md` using existing analysis data

This saves API calls and processing time when you only need to regenerate the literature review (e.g., after updating keywords or minScore settings).

#### Scheduler Logic Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    generateDailyReport()                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Check: Does today's paper list exist in reports/?               │
│        (daily_papers_YYYY-MM-DD*.md)                            │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
         YES (skipExtraction=true)      NO (skipExtraction=false)
              │                               │
              ▼                               ▼
┌─────────────────────────┐    ┌─────────────────────────────────┐
│ SKIP:                   │    │ Step 1: Get emails              │
│ - Gmail sync            │    │ - Check recent sync file        │
│ - AI paper extraction   │    │ - Or sync from Gmail            │
│ - Save analysis file    │    │ - Smart paper extraction:       │
│ - Generate paper list   │    │   • Pre-extract paper blocks    │
│                         │    │   • Hybrid batching (tokens +   │
│                         │    │     same-email grouping)        │
│                         │    │ - Save analysis-{timestamp}.json │
└─────────────────────────┘    └─────────────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Load papers from analysis files (TODAY only)            │
│ - Read analysis-*.json from synced_emails/ created today        │
│ - (Uses --hours rolling window if --hours < 24 specified)       │
│ - Deduplicate papers                                            │
│ - Sort by relevance                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
         skipExtraction=true           skipExtraction=false
              │                               │
              ▼                               ▼
┌─────────────────────────┐    ┌─────────────────────────────────┐
│ SKIP generating         │    │ Generate daily_papers_*.md      │
│ daily_papers_*.md       │    │                                 │
└─────────────────────────┘    └─────────────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ ALWAYS: Generate daily_review_*.md                              │
│ - Use all papers above minScore (already sorted by relevance)   │
│ - Generate review with AI                                       │
│ - Append reference list                                         │
│ - Save analysis-{timestamp}.json (review papers)                │
└─────────────────────────────────────────────────────────────────┘
```

### Settings Synchronization

The scheduler shares settings with the web app:

- **Processing settings** (`batchSize`, `analysisLimit`, `minScore`) are automatically synced from the web app to `scheduler.config.json` when you change them in Settings
- **Keywords** are automatically synced to `keywords.json` when you modify them in the web app

This ensures the scheduler uses the same processing parameters as the web app.

### Timeout Settings

The scheduler includes built-in timeout handling for network requests:

- **API timeout**: 2 minutes per Gemini API call
- **Proxy connection timeout**: 30 seconds
- **Proxy request timeout**: 2 minutes

These settings help prevent hanging requests when processing large batches through a proxy.

### Automatic Email Syncing (Server-Side Auth)

For fully automatic operation (sync emails + generate reports), you need to set up server-side Gmail authorization with refresh tokens:

**Step 1: Get OAuth2 Credentials**
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create or select a project
3. Create OAuth 2.0 Client ID (Web application type)
4. Add `http://localhost:3000/oauth2callback` to Authorized redirect URIs
5. Note down the **Client ID** and **Client Secret**

**Step 2: Configure in Web UI**
1. Open the web app and go to Settings
2. Scroll to "Server-Side Gmail Authorization" section
3. Enter your Client ID and Client Secret
4. Click "Save Configuration"
5. Click "Authorize Gmail Access" and complete the OAuth flow

**Step 3: Verify**
Once authorized, you'll see "Server-Side Auth Active" in Settings. The scheduler will now automatically:
1. Sync emails from Gmail at the scheduled time
2. Process emails through AI
3. Generate daily reports

**Manual Sync:**
```bash
npm run sync
```

**Reset Server-Side Gmail Authorization:**

If you need to reset the Gmail authorization (e.g., switch accounts, fix auth errors):

1. Delete the tokens file:
   ```bash
   rm oauth2_tokens.json
   ```

2. Restart the server:
   ```bash
   pm2 restart scholarpulse
   ```

3. Re-authorize via Settings → Server-Side Gmail Authorization → "Authorize with Google"

**Proxy Configuration (for restricted networks):**

If you're behind a firewall or need a proxy to access Google services, add proxy settings to `.env.local`:

```bash
# Proxy for Google services
HTTPS_PROXY=http://localhost:7897
HTTP_PROXY=http://localhost:7897
```

Then restart the server: `pm2 restart scholarpulse`

If you see "fetch failed" errors during OAuth authorization, it usually means the proxy is not configured or not running.

**Troubleshooting: Token Expires Every 7 Days**

If your refresh token stops working after exactly 7 days:
1. This happens because your Google Cloud Project is in **"Testing"** status.
2. **Solution**: Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials/consent) > **OAuth consent screen**.
3. Click the **"Publish App"** (or "Push to production") button.
4. You may see a warning about verification ("App not verified"). For personal use, you can safely ignore this. The 7-day limit will be removed.

### View Scheduled Reports

1. Open the web app
2. Click "Daily Reports" in the sidebar
3. Browse and download generated reports

Reports are saved to the `reports/` directory with timestamps.

### Scheduler Commands

| Command | Description |
|---------|-------------|
| `npm run scheduler` | Start scheduler (waits for scheduled time) |
| `npm run scheduler:now` | Start scheduler and generate report immediately |
| `pm2 logs scholarpulse-scheduler` | View scheduler logs |
| `pm2 restart scholarpulse-scheduler` | Restart after config changes |

**Testing Parameters:**

```bash
# Override time for testing (useful for testing date-based logic)
npx tsx scripts/scheduler.ts --now --time=2026-01-15T08:00:00

# Override hours to process (e.g., last 3 hours only)
npx tsx scripts/scheduler.ts --now --hours=3

# Use a specific synced emails file (skips Gmail sync)
npx tsx scripts/scheduler.ts --now --sync-file=synced_emails/sync-1768521623185.json

# Combine parameters for precise testing
npx tsx scripts/scheduler.ts --now --sync-file=synced_emails/sync-1768521623185.json --hours=3
```

## Manual Processing Scripts

### Sync Gmail Emails

Manually sync emails from Gmail (requires server-side auth):

```bash
npm run sync
# Or with custom parameters (hours, limit):
npx tsx scripts/syncGmail.ts 48 100  # Last 48 hours, max 100 emails
```

### Aggregate and Process

Process analysis files and generate literature review:

```bash
npx tsx scripts/aggregate_and_process.ts
```

**Options:**
- `--minScore <number>`: Override minimum relevance score (default: reads from `scheduler.config.json`)

**Example:**
```bash
# Use higher minScore to filter more aggressively
npx tsx scripts/aggregate_and_process.ts --minScore 40
```

**Output:**
- `consolidated_papers.md`: List of all papers above minScore
- `literature_review.md`: AI-generated literature review

### minScore Filtering

The `minScore` setting controls which papers are included in reports:

- **Default**: 20 (configured in `scheduler.config.json`)
- **Per-batch filtering**: Papers are filtered immediately after each batch extraction, preventing large email sources (like bioRxiv with 40+ papers) from overwhelming the system
- **Recommendation**: Increase to 30-50 if you're getting too many irrelevant papers

### Source-Based Score Weighting

Relevance scores are automatically adjusted based on the paper source to prioritize peer-reviewed publications:

| Source | Weight | Effect |
|--------|--------|--------|
| Nature, Cell, Science, Lancet, NEJM | 1.5x | +50% score boost |
| Circulation, EHJ, Blood, Nature/Cell subsidiary journals | 1.3x | +30% score boost |
| Cell Press (Cell Reports, iScience, STAR Protocols) | 1.2x | +20% score boost |
| PNAS, JAMA, AHA subsidiary (Hypertension, Stroke) | 1.2x | +20% score boost |
| Elsevier, Springer, Advanced Science | 1.0x | No score change |
| Conference/Proceedings | 0.8x | -20% score reduction |
| Scientific Reports | 0.75x | -25% score reduction |
| Google Scholar | 0.7x | -30% score reduction |
| bioRxiv/medRxiv | 0.6x | -40% score reduction |
| Frontiers, MDPI | 0.5x | -50% score reduction |
| Hindawi | 0.45x | -55% score reduction |
| iCell | 0.4x | -60% score reduction |
| Unknown sources | 0.2x | -80% score reduction |

**Example**: A Frontiers paper with raw score of 60 becomes 30 after weighting (60 × 0.5), while a Nature paper with raw score 60 becomes 90 (60 × 1.5).

This ensures that when `minScore` filtering is applied, peer-reviewed papers from prestigious journals are more likely to be retained.

### Hybrid Relevance Scoring

The relevance score combines AI semantic understanding with deterministic keyword matching:

```
Final Score = max(0, min(100, AI Base Score + Keyword Bonus - Penalties)) × Source Weight
```

**Keyword Bonus Structure:**

| Match Type | Bonus |
|------------|-------|
| Exact keyword in title | +20 |
| Partial word match in title (>3 chars) | +10 |
| Exact keyword in snippet/content | +10 |
| Partial word match in snippet (>3 chars) | +5 |

**Penalty Structure (for irrelevant research areas):**

| Match Type | Penalty |
|------------|---------|
| Penalty keyword in title | -25 |
| Penalty keyword in snippet/content | -15 |
| **No keyword match** (non-preprint only) | **-20** |

Note: No-match penalty is NOT applied to preprints (bioRxiv, medRxiv, arXiv) since they already have heavy source weight penalties.

**Configuration (`keywords.json`):**

```json
{
  "keywords": ["Aortic Disease", "Marfan Syndrome", "organoid", "AI virtual cell", "single-cell proteomics"],
  "penaltyKeywords": ["cancer", "tumor", "oncology", "adenocarcinoma", "carcinoma", "melanoma", "leukemia", "lymphoma", "metastasis", "fish", "zebrafish"]
}
```

**Example scoring:**

| Paper Title | Source | AI Base | Bonus | Penalty | Before Weight | ×Weight | Final |
|-------------|--------|---------|-------|---------|---------------|---------|-------|
| "Single-cell proteomics of aortic organoids" | Nature | 60 | +40 | 0 | 100 | ×1.3 | **100** |
| "MAPK14 in abdominal aortic aneurysm" | Circulation | 45 | +10 | 0 | 55 | ×1.2 | **66** |
| "Lorentz VAE for single-cell transcriptomic" | Frontiers | 60 | +10 | 0 | 70 | ×0.5 | **35** |
| "Riemannian Metric Learning for Spatial Multiomics" | bioRxiv | 50 | 0 | 0 (no no-match for preprint) | 50 | ×0.6 | **30** |
| "Tumor microenvironment in lung adenocarcinoma" | Google Scholar | 60 | 0 | -70 (-50 penalty, -20 no-match) | 0 | ×0.7 | **0** |
| "Random unrelated paper" | Hindawi | 40 | 0 | -20 (no-match) | 20 | ×0.45 | **9** |

This hybrid approach ensures:
- Papers with exact keyword matches always rank higher
- Irrelevant research areas (e.g., cancer when studying cardiovascular disease) are deprioritized
- Semantic understanding from AI catches related terms
- Consistent, predictable scoring for your research interests

## Web UI Features

### System Logs Viewer

The app includes a real-time system logs viewer for debugging and monitoring:

1. Click the terminal icon in the header to toggle the log panel
2. View color-coded log entries (info/success/warn/error)
3. Click "Clear" to reset the log history

Logs are stored in memory (up to 1000 entries) and include timestamps. This is useful for:
- Debugging API issues
- Monitoring email processing progress
- Tracking authentication status

### Email History & Recovery

Previous analysis sessions are automatically saved and can be restored:

1. Look for the "History" section in the sidebar
2. Click any previous session to reload its results
3. Sessions are grouped by date for easy navigation

Analysis files are stored in `synced_emails/` as `analysis-{timestamp}.json`.

### Export Raw Email Data

Export synced emails as JSON for backup or external processing:

1. After syncing emails, click the "Export Raw" button
2. Emails are saved to the `synced_emails/` folder
3. File format: `emails-{timestamp}.json`

### Individual Email Analysis

In the Preview tab, you can analyze emails individually:

1. Expand any email to see its content
2. Click "Analyze" to extract papers from that specific email
3. View extracted papers inline before processing the full batch

### Error Recovery

If the app crashes, an error boundary provides recovery options:

- **Clear Cache & Reload**: Clears all localStorage and reloads the app
- Use this if you encounter persistent errors or corrupted state

## Browser-Based Gmail OAuth

For interactive use in the browser, the app uses Google Identity Services for authentication.

### Token Management

- Access tokens are automatically saved to localStorage
- Tokens are validated before API calls (with 1-minute expiry buffer)
- On app reload, tokens are automatically restored if still valid

### nip.io Domain Support

When accessing the app via IP address (e.g., `http://192.168.1.100:3000`), OAuth redirects may fail due to Google's restrictions on IP-based redirect URIs.

**Solution**: Use nip.io domains

1. The app automatically detects IP-based access
2. A suggestion appears in Settings under "Google Integration Setup"
3. Access via `http://192.168.1.100.nip.io:3000` instead
4. Add this domain to your Google OAuth authorized redirect URIs

## Supported Email Sources

The app automatically detects and processes emails from these academic alert services:

| Source | Email Address | Score Weight |
|--------|---------------|--------------|
| Google Scholar | scholaralerts-noreply@google.com | 0.8x |
| bioRxiv/medRxiv | openRxiv-mailer@alerts.highwire.org | 0.7x |
| Cell Press | cellpress@notification.elsevier.com | 1.3x |
| Nature | ealert@nature.com, alerts@nature.com | 1.3x |
| AHA Journals | ahajournals@ealerts.heart.org | 1.2x |

The Gmail query automatically searches all these sources when syncing.

## Intelligent Article Extraction

The app uses **cheerio** (a jQuery-like HTML parser) to intelligently extract articles from academic email alerts before sending them to the AI. This provides significant improvements in accuracy and efficiency.

### How It Works

```
Raw Email HTML (1808 KB) → Cheerio Parser → Structured Articles (38 KB) → AI Processing
```

1. **Source Detection**: Identifies email source from the `From:` header
2. **Pattern Matching**: Uses source-specific HTML patterns to extract articles
3. **Title Extraction**: Captures exact titles from link text (no AI interpretation needed)
4. **Content Filtering**: Removes navigation, footers, and non-article content
5. **Structured Output**: Formats as clean `TITLE/SOURCE/AUTHORS/ABSTRACT` blocks

### Source-Specific Extractors

| Source | Pattern | Special Handling |
|--------|---------|------------------|
| Cell Press | `<a href="cell.com/fulltext">` links | Extracts title from link text |
| Nature | `<span style="font-size:18px">` + links | Filters to Research sections only |
| bioRxiv/medRxiv | DOI patterns, `<a href="biorxiv.org">` | Handles plain-text and HTML formats |
| AHA Journals | `<span style="font-weight:bold">` in links | Supports nested styling |
| Google Scholar | `<h3><a class="gse_alrt_title">` | Standard Google format |

### Efficiency Gains

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Content sent to AI | 1808 KB | 38 KB | 98% reduction |
| Estimated tokens | ~452,000 | ~9,500 | 97% saved |
| Title accuracy | AI parses HTML | Exact from source | No hallucination |
| Nature articles | 102 (all sections) | 31 (Research only) | 70% filtered |

### Fallback Behavior

If article extraction fails for any email, the system automatically falls back to the original raw HTML preprocessing (URL/snippet placeholders). This ensures robustness while still benefiting from extraction when possible.

## Testing & Debugging Scripts

### Test API Connection

Test basic Gemini API connectivity:

```bash
npx tsx scripts/test_api.ts
```

### Test Proxy Connection

Test Gemini API through your configured proxy:

```bash
npx tsx scripts/test_proxy.ts
```

This uses the `HTTPS_PROXY` environment variable from `.env.local`.

## API Endpoints Reference

The app exposes these internal API endpoints (available when running `npm run dev`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/save-emails` | POST | Save synced emails to disk |
| `/api/history` | GET | List recent analysis files |
| `/api/load-report` | GET | Load analysis file by filename |
| `/api/scheduled-reports` | GET | List all scheduled reports |
| `/api/load-scheduled-report` | GET | Load report markdown content |
| `/api/scheduler-config` | GET/POST | Get/save scheduler configuration |
| `/api/keywords` | GET/POST | Get/save keywords list |
| `/api/oauth2/config` | GET/POST | OAuth2 client configuration |
| `/api/oauth2/auth-url` | GET | Get Google authorization URL |
| `/api/oauth2/status` | GET | Check token validity status |
| `/api/validate-refine` | POST | Validate papers and generate refined analysis |
| `/oauth2callback` | GET | Handle OAuth2 callback |

## Changelog

### 2026-02-04
- **Updated**: Journal relevance scoring weights to better reflect prestige and impact
  - **Tier 1 (1.5x)**: Nature, Cell, Science, The Lancet, NEJM
  - **Tier 2 (1.3x)**: Circulation, European Heart Journal, Blood, Nature/Cell subsidiary journals
  - **Tier 3 (1.2x)**: High-quality specialty journals (PNAS, JAMA, AHA subsidiaries, Cell Press subsidiaries)
  - **Baseline (1.0x)**: Elsevier, Springer, Advanced Science (no score change)
- **Updated**: `SOURCE_MAP` to include explicit mapping for European Heart Journal (`etoc@oup.com`) and Blood (`blood@hematology.org`).

### 2026-02-01
- **Changed**: Reverted from Tailscale-based external access to a local network `nip.io` scheme.
- **Improved**: Configured Vite and OAuth2 redirect URIs to use the local network IP (`192.168.10.9.nip.io`) for easier access within the same LAN without complex tunneling.
- **Fixed**: Removed Tailscale "serve" proxy to ensure the application runs exclusively on the local network/localhost.
- **Improved**: Integrated `penaltyKeywords` into the web app's analysis pipeline. Updated `App.tsx` to pass keywords from `KeywordManager` to all email processing functions (`analyzeSingleEmail`, `processSelectedEmails`, and `handleImport`), ensuring consistency between the web UI and the batch scheduler.

### 2026-01-28
- **Fixed**: Journal recognition for specific AHA journals
  - "Circulation: Heart Failure" and "Circulation: Genomic and Precision Medicine" are now correctly identified by their full names instead of being lumped under generic "Circulation".
- **Fixed**: Penalty keyword persistence in large-scale processing
  - Fixed a bug where penalty keywords were lost when emails were split into multiple chunks for processing in `geminiService.ts`.
- **Improved**: Expanded the default penalty keyword list in `keywords.json` to further reduce noise from non-relevant research areas including Plants & Agriculture, Oncology, and other model organisms.

### 2026-01-27
- **Added**: New journal weight configurations
  - **Communications Biology**: 1.0x (Nature Portfolio)
  - **Advanced Science**: 1.0x (Wiley)
  - **Cell Reports Methods**: 1.2x (Cell Press subsidiary)
- **Fixed**: Journal detection from email subject lines
  - "Communications Biology" is now explicitly recognized as a Nature Portfolio journal
  - "Cell Reports Methods" is now explicitly recognized as a Cell Press journal
  - Improved matching priority: specific journal names (e.g., "Cell Reports Methods") are now checked before shorter parent names (e.g., "Cell Reports") to prevent misidentification
- **Improved**: Source multiplier logic
  - Updated fuzzy matching in `geminiService.ts` to support the new journals and ensure consistent scoring multipliers

### 2026-01-24
- **Fixed**: AI hallucination filtering in scoring pipeline
  - Papers returned by AI that don't match any original extracted article are now filtered out
  - Prevents hallucinated papers from appearing in analysis results
  - Uses fuzzy matching (exact, normalized, substring) to match AI output back to original articles
- **Fixed**: Chain-of-thought reasoning leaking into paper titles
  - AI sometimes included scoring rationale in title fields (e.g., "Paper Title Reference to arterial/vascular... Score: 45")
  - Added pattern-based cleaning to detect and remove leaked reasoning from titles
  - Patterns include: "Reference to...", "Score: X", "(Weak connection)", "Wait,", "Let's use", etc.
- **Improved**: AI prompt for paper scoring
  - Stricter instructions: "Output ONLY valid JSON - NO explanations, NO reasoning, NO chain-of-thought"
  - Emphasizes copying TITLE, AUTHORS, and SOURCE fields EXACTLY as provided
  - Added required fields to JSON schema for better validation
- **Improved**: Paper title matching
  - Now uses original article title from extraction, not AI's potentially modified version
  - Ensures consistency between extracted and scored papers
- **Added**: Journal weight configurations
  - STAR Protocols: 1.2x (Cell Press subsidiary journal)
  - iCell: 0.4x (low-quality journal)
  - Updated fuzzy matching to handle these journal patterns

### 2026-01-23 (Update 3)
- **NEW**: Intelligent Article Extraction with Cheerio HTML Parser
  - Added `emailArticleExtractor.ts` using cheerio for semantic HTML parsing
  - Extracts exact paper titles directly from HTML structure (prevents AI hallucination)
  - Source-specific extractors for: Cell Press, Nature, bioRxiv/medRxiv, AHA Journals, Google Scholar
  - **98% content reduction**: 1808 KB raw emails → 38 KB structured content
  - ~450,000 tokens saved per processing run
- **Improved**: Hybrid approach for `processScholarEmails()` (Web App)
  - Pre-extracts articles using cheerio before sending to AI
  - Keeps stable single-API-call pattern (no batching complexity)
  - Falls back to raw preprocessing if extraction fails
  - AI receives clean structured format: `TITLE: ..., SOURCE: ..., AUTHORS: ..., ABSTRACT: ...`
- **Improved**: Nature email processing
  - Filters to only "Research" sections: News & Views, Reviews, Articles
  - Skips editorials, news, opinions, and other non-research content
  - 73% size reduction for Nature emails (217 KB → 58 KB research content)
  - **NEW**: Extracts specific journal name from subject (e.g., "Nature Medicine", "Nature Aging")
- **Improved**: Cell Press title extraction
  - Extracts exact titles from `<a>` link text (not descriptions)
  - Fixes title hallucination issue (e.g., "BRAIN-MAGNET" incorrect subtitle)
- **Improved**: bioRxiv/medRxiv extraction
  - Added plain-text DOI pattern extraction for highwire alert format
  - Now extracts articles from both HTML links and plain-text emails
- **Improved**: AHA Journals extraction
  - Added support for `<span style="font-weight:bold">` inside `<a>` tag pattern
  - Fixes extraction failure on large Hypertension emails (248 KB)
- **Removed**: `reviewPaperLimit` config option
  - All papers above `minScore` are now included in reviews (no truncation)
  - Simplifies processing: one analysis file with all filtered papers

### 2026-01-23 (Update 2)
- **Improved**: Scheduler robustness with automatic retries for failed chunks
  - When a chunk fails during lightweight processing (e.g., due to network timeouts), it is now queued for retry
  - Added a secondary retry pass that runs after the main processing loop
  - Includes a 5-second backoff delay before retrying failed chunks
  - Significantly improves success rate on unstable network connections

### 2026-01-23
- **Added**: Full support for English and Chinese language options
  - Supported in both the Web UI and the batch processing script (via `--lang` flag)
- **Fixed**: `ECONNRESET` error in OAuth2 token manager when running behind a proxy
  - Added explicit `ProxyAgent` support to `OAuth2TokenManager` using `undici`
  - Ensures token refreshes and code exchanges correctly utilize the configured proxy
- **Fixed**: TypeScript compilation error in `geminiService.ts`
  - Removed unsupported `fetch` property from `GoogleGenAI` configuration
  - Improved reliability by relying on global `fetch` patching in `loadEnv.ts`

### 2026-01-17 (Update 2)
- **Added**: Paper title validation and hallucination detection
  - New `scripts/validatePaperTitles.ts` validates extracted paper titles against original email content
  - Uses multiple matching strategies: exact, normalized (case/punctuation insensitive), and partial matching
  - Handles HTML entities and unicode normalization
  - Integrated into scheduler: runs automatically after paper extraction
  - Web app integration: `/api/validate-refine` endpoint for manual validation
- **Added**: Automatic refinement of analysis files
  - Hallucinated papers are automatically removed after validation
  - Generates refined analysis file with validated papers only
  - Initial extraction file is deleted after refinement (keeps only one analysis file)
  - Sets `__refinedComplete` flag to skip duplicate analysis file creation
- **Added**: New npm scripts
  - `npm run validate` - Validate most recent extraction
  - `npm run validate:refine` - Validate and generate refined files
- **Added**: Refined report generation
  - `daily_review_refined_{timestamp}.md` - Full Gemini-generated literature review
  - `daily_papers_refined_{timestamp}.md` - Simple paper list for easy copying
  - Papers sorted by relevance score in all output files
- **Improved**: Scheduler now produces only one analysis file (the refined version)
  - Previously: Initial extraction + refined + final review = 3 files
  - Now: Only the refined analysis file is kept

### 2026-01-17
- **Fixed**: "Unknown Source" weight reduced from 0.75 to 0.3 to properly penalize papers without identifiable sources
- **Fixed**: Default source multiplier for unrecognized journals changed from 1.0 to 0.2
  - Previously, unknown journals like "Kernel Methods for Omics Data Mining" got 1.0x (no penalty)
  - Now properly penalized as unrecognized sources
- **Fixed**: Stricter matching for "Science" journal to prevent false positives
  - Previously: Any source containing "science" got 1.3x boost (e.g., "Marine Life Science & Technology")
  - Now: Only matches exact "Science" or sources starting with "Science " (e.g., "Science Translational Medicine")
- **Improved**: Unified scoring prompts across all components
  - Web app (`processScholarEmails`), scheduler (`processScholarEmailsLightweight`), and test script (`testScoring.ts`) now use identical scoring criteria
  - Added detailed examples in prompts for more consistent AI scoring
  - Changed testScoring.ts model from `gemini-2.0-flash` to `gemini-3-flash-preview` for consistency

### 2026-01-16
- **Added**: Aggressive penalty system for low-impact journals and unmatched papers
  - Low-impact journals: Frontiers/MDPI (0.5x), Hindawi (0.45x), bioRxiv (0.6x)
  - No keyword match penalty: -20 points
  - Papers from Frontiers with no keyword match effectively get halved score
- **Added**: Penalty keywords to deprioritize irrelevant research areas
  - Configure `penaltyKeywords` in `keywords.json` (e.g., "cancer", "tumor", "oncology")
  - Penalty keyword in title: -25, in snippet: -15
  - Papers like "Tumor microenvironment in lung adenocarcinoma" get -70 penalty (filtered out)
  - Formula: `Final Score = max(0, min(100, AI Base Score + Bonus - Penalty)) × Source Weight`
- **Added**: Hybrid relevance scoring combining AI semantic understanding with deterministic keyword matching
  - AI provides base score (0-100), then keyword bonus is added programmatically
  - Exact keyword in title: +20, partial match: +10
  - Exact keyword in snippet: +10, partial match: +5
  - Ensures papers with your keywords consistently rank higher
- **Added**: Journal/source extraction from Google Scholar citation lines
  - AI now extracts the actual journal name (e.g., "Circulation Research", "Nature Communications") from citation text
  - Previously all Google Scholar papers were marked as "Google Scholar"
- **Added**: AHA Journals email parsing support
  - New pattern matching for `ahajournals@ealerts.heart.org` emails
  - Extracts papers from AHA-specific HTML structure (font-size:18px;font-weight:bold links)
- **Improved**: Fuzzy source weight matching
  - Journal names containing "nature", "cell", "circulation" get appropriate multipliers
  - Handles variations like "Nature Communications", "Circulation Research"
  - Conference/proceedings papers get 0.9x multiplier
- **Added**: Command-line arguments for scheduler testing
  - `--time=YYYY-MM-DDTHH:mm:ss`: Override current time for testing (e.g., `--time=2026-01-15T08:00:00`)
  - `--hours=N`: Override sync hours (e.g., `--hours=3` to process last 3 hours only)
  - `--sync-file=PATH`: Use a specific synced emails file for testing (skips Gmail sync)
  - Example: `npx tsx scripts/scheduler.ts --now --sync-file=synced_emails/sync-1768521623185.json`
- **Fixed**: Analysis file filtering now uses "today" instead of rolling 24-hour window
  - Previous bug: Running at 8:00 AM would include yesterday's 8:00 AM files (within 24 hours)
  - Now: Only includes files from today (since midnight in configured timezone)
  - `--hours` < 24 still uses rolling window for testing purposes
- **Fixed**: Step 2 now uses only current extraction instead of aggregating old files
  - Previous bug: Extracted 37 papers in Step 1, but Step 2 showed 607 papers from old analysis files
  - Now: When Step 1 extracts papers, Step 2 uses **only** that extraction file
  - Old analysis files are only aggregated when skipping extraction (paper list already exists)
  - Prevents confusion when testing with `--hours` parameter
- **Improved**: Smart paper extraction with hybrid batching strategy
  - Pre-extracts individual paper blocks from emails using regex patterns
  - Google Scholar: Extracts by `gse_alrt_title` anchor tags
  - bioRxiv/medRxiv: Extracts by paper link patterns
  - Batches by **paper count + token estimation** instead of email count
  - Keeps papers from same email together when possible
  - Splits large emails (e.g., bioRxiv with 100+ papers) intelligently
  - Token limit: ~8000 tokens per batch for reliable LLM processing
  - Example output:
    ```
    [Scheduler] Pre-extracting paper blocks from 15 emails...
    [Scheduler] Found 127 paper blocks (~42000 tokens) across 15 emails
    [Scheduler] Processing 127 papers in 6 batches (max 8000 tokens, max 20 papers per batch)...
    [Scheduler] Processing batch 1/6 (18 papers, ~6200 tokens)...
    ```

### 2026-01-15 (Update 2)
- **Added**: Smart extraction skipping in scheduler
  - If today's paper list (`daily_papers_YYYY-MM-DD*.md`) already exists in `reports/`, skips Gmail sync and AI paper extraction
  - Still generates fresh `daily_review_*.md` using existing analysis files
  - Saves API calls when only regenerating the literature review
- **Added**: Reference list appended to daily_review output
- **Added**: Analysis file saved after review generation (for web app compatibility)
- **Improved**: Uses `gemini-3-flash-preview` for lightweight review generation (more stable through proxy)
- **Added**: Scheduler logic flow diagram in README

### 2026-01-15
- **Fixed**: Scheduler failing with "fetch failed" errors when processing emails through proxy
  - Added `processScholarEmailsLightweight()` function optimized for Node.js/proxy environments
  - Uses simpler JSON schema (title, authors, relevanceScore) that works reliably with proxy connections
  - Splits large emails into ~3000 character chunks by DOI patterns for reliable processing
  - Processes chunks sequentially with 2-second delays to avoid rate limiting
- **Benefit**: Scheduler now works reliably behind proxies where the full schema would timeout
- **Note**: Web app continues to use the full schema (works fine in browser without proxy issues)

### 2025-01-15 (Update 2)
- **Fixed**: bioRxiv email body extraction now properly handles nested MIME parts and preserves document structure
  - HTML-to-text conversion preserves newlines between papers (was collapsing everything into one line)
  - Each paper now clearly separated with title, authors, DOI on separate lines
- **Improved**: Per-batch minScore filtering for large email sources
  - Papers are now filtered by `minScore` immediately after each batch extraction
  - Prevents accumulating hundreds of low-relevance papers from sources like bioRxiv (which can have 40+ papers per email)
  - Reduces memory usage and processing time for `aggregate_and_process.ts`
- **Added**: Source-based score weighting
  - Papers from prestigious peer-reviewed journals (Nature, Cell Press, AHA) get score boosts (+20-30%)
  - Papers from preprints (bioRxiv/medRxiv) and general search (Google Scholar) get score reductions (-20-30%)
  - Makes minScore filtering more effective at prioritizing quality publications
- **Added**: minScore support in `aggregate_and_process.ts`
  - Reads `minScore` from `scheduler.config.json` (default: 20)
  - Can override via command line: `npx tsx scripts/aggregate_and_process.ts --minScore 30`
  - Output shows filtering stats: `Papers above minScore (20): X`

### 2025-01-15
- **Fixed**: `Cannot read properties of undefined (reading 'substring')` error when generating literature reviews for papers without snippets
- **Improved**: Removed `link` field from AI paper extraction to reduce token usage and improve model accuracy
  - URLs are now completely removed from email content before AI processing (not replaced with placeholders)
  - Links are no longer extracted by the AI model
  - Generated markdown reports no longer include link fields
  - Web UI conditionally shows "View Paper" button only when links are available
- **Benefit**: Cleaner input without URLs helps the AI model focus on paper content analysis rather than URL tracking

