<div align="center">
<img alt="ScholarPulse Banner" src="./scholarpulse.jfif" />
</div>

# ScholarPulse

An AI-powered academic paper tracking and literature review tool. Automatically syncs emails from academic alert services (Google Scholar, bioRxiv, Nature, etc.), extracts papers using Gemini AI, and generates daily literature reviews.

Details, can be seen in [[./ACADEMIC_REPORT.md]]

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
  "minScore": 10,
  "reviewPaperLimit": 50
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
| `reviewPaperLimit` | Max papers for literature review (0 = no limit, default: 50) |

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
│ - Save analysis file    │    │ - Process emails → extract papers│
│ - Generate paper list   │    │ - Save analysis-{timestamp}.json │
└─────────────────────────┘    └─────────────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Load papers from analysis files (last 24 hours)         │
│ - Read all analysis-*.json from synced_emails/                  │
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
│ - Truncate to top N papers (reviewPaperLimit)                   │
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
| Nature | 1.3x | +30% score boost |
| Cell Press | 1.3x | +30% score boost |
| AHA Journals | 1.2x | +20% score boost |
| Elsevier | 1.1x | +10% score boost |
| Springer | 1.1x | +10% score boost |
| Google Scholar | 0.8x | -20% score reduction |
| bioRxiv/medRxiv | 0.7x | -30% score reduction |

**Example**: A bioRxiv paper with raw AI score of 50 becomes 35 after weighting (50 × 0.7), while a Nature paper with raw score 50 becomes 65 (50 × 1.3).

This ensures that when `minScore` filtering is applied, peer-reviewed papers from prestigious journals are more likely to be retained.

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
| `/oauth2callback` | GET | Handle OAuth2 callback |

## Changelog

### 2026-01-15 (Update 2)
- **Added**: Smart extraction skipping in scheduler
  - If today's paper list (`daily_papers_YYYY-MM-DD*.md`) already exists in `reports/`, skips Gmail sync and AI paper extraction
  - Still generates fresh `daily_review_*.md` using existing analysis files
  - Saves API calls when only regenerating the literature review
- **Added**: `reviewPaperLimit` config option for truncating papers in review generation
  - Default: 50 papers (top by relevance score)
  - Set to 0 for no limit
  - Prevents token overflow when processing large paper lists (e.g., 132 papers)
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

