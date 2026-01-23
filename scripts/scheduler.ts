import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { generateLiteratureReviewLightweight, scoreExtractedArticles, deduplicatePapers } from '../services/geminiService.ts';
import type { Paper } from '../types.ts';
import { syncGmailEmails } from './syncGmail.ts';
import { validateExtraction, refineAndSave } from './validatePaperTitles.ts';
import { extractArticlesFromEmail } from '../services/emailArticleExtractor.ts';

if (!process.env.VITE_GEMINI_API_KEY) {
  console.error("[Scheduler] No API Key found in .env.local");
  process.exit(1);
}

const syncedEmailsDir = path.resolve(process.cwd(), 'synced_emails');
const reportsDir = path.resolve(process.cwd(), 'reports');
const configPath = path.resolve(process.cwd(), 'scheduler.config.json');

// Ensure reports directory exists
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// Load scheduler config
interface SchedulerConfig {
  enabled: boolean;
  time: string; // HH:mm format
  timezone: string;
  syncEnabled: boolean; // Enable auto Gmail sync
  syncHours: number; // Hours of emails to fetch
  syncLimit: number; // Max emails to fetch
  reuseRecentSyncMinutes: number; // Skip sync if recent sync file exists within this time (0 = always sync)
  // Processing settings (matching web app)
  batchSize: number; // Number of emails per batch
  batchDelaySeconds: number; // Delay between batches (helps with rate limiting)
  analysisLimit: number; // Max papers to analyze per batch
  minScore: number; // Minimum relevance score to include
  scoreBatchSize: number; // Number of articles to score per API call
}

function loadConfig(): SchedulerConfig {
  const defaultConfig: SchedulerConfig = {
    enabled: true,
    time: '08:00',
    timezone: 'Asia/Shanghai',
    syncEnabled: true,
    syncHours: 24,
    syncLimit: 200,
    reuseRecentSyncMinutes: 60, // Default: reuse sync files from last hour
    // Match web app defaults
    batchSize: 20,
    batchDelaySeconds: 5, // Default: 5 seconds between batches
    analysisLimit: 200,
    minScore: 10,
    scoreBatchSize: 50 // Default: 50 articles per scoring batch
  };

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      return { ...defaultConfig, ...config };
    }
  } catch (e) {
    console.warn('[Scheduler] Failed to load config, using defaults:', e);
  }

  return defaultConfig;
}

function timeToCron(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return `${minutes} ${hours} * * *`;
}

// Delay helper for batch processing
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============ Smart Paper Extraction ============

interface ExtractedPaperBlock {
  emailId: string;
  emailFrom: string;
  emailSubject: string;
  paperHtml: string;  // The HTML/text block for this paper
  estimatedTitle: string;  // For logging/debugging
}

/**
 * Pre-extract individual paper blocks from emails using pattern matching.
 * This allows batching by paper count instead of email count.
 */
function preExtractPaperBlocks(rawEmails: any[]): ExtractedPaperBlock[] {
  const blocks: ExtractedPaperBlock[] = [];

  for (const email of rawEmails) {
    const body = email.body || '';
    const from = (email.from || '').toLowerCase();
    const subject = email.subject || '';
    const emailId = email.id || '';

    // Google Scholar format: papers are in <h3> tags with gse_alrt_title links
    if (from.includes('scholar') || from.includes('google')) {
      // Pattern: <h3...><a class="gse_alrt_title"...>Title</a></h3> followed by citation and snippet divs
      const scholarPattern = /<h3[^>]*>[\s\S]*?<a[^>]*class="gse_alrt_title"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>[\s\S]*?<div[^>]*style="color:#006621[^>]*>[\s\S]*?<\/div>(?:[\s\S]*?<div[^>]*class="gse_alrt_sni"[^>]*>[\s\S]*?<\/div>)?/gi;

      let match;
      let lastIndex = 0;
      const matches: { start: number; end: number; title: string }[] = [];

      while ((match = scholarPattern.exec(body)) !== null) {
        const title = match[1].replace(/<[^>]+>/g, '').trim();
        matches.push({ start: match.index, end: match.index + match[0].length, title });
        lastIndex = scholarPattern.lastIndex;
      }

      // Extract each paper block
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].start;
        const end = i + 1 < matches.length ? matches[i + 1].start : matches[i].end + 500; // Include some trailing content
        const paperHtml = body.slice(start, Math.min(end, body.length));

        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml,
          estimatedTitle: matches[i].title.substring(0, 50)
        });
      }

      // If no patterns matched, treat whole email as one block
      if (matches.length === 0 && body.length > 100) {
        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml: body,
          estimatedTitle: subject.substring(0, 50)
        });
      }
    }
    // bioRxiv/medRxiv format: papers are in table rows or divs with links
    else if (from.includes('biorxiv') || from.includes('medrxiv') || from.includes('highwire')) {
      // These emails typically list papers with links - extract by link patterns
      const linkPattern = /<a[^>]*href="[^"]*(?:biorxiv|medrxiv)[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let match;
      const paperLinks: { title: string; index: number }[] = [];

      while ((match = linkPattern.exec(body)) !== null) {
        const title = match[1].trim();
        if (title.length > 20 && !title.toLowerCase().includes('unsubscribe')) {
          paperLinks.push({ title, index: match.index });
        }
      }

      // Group into blocks (each link = one paper approximately)
      for (const link of paperLinks) {
        // Extract surrounding context (500 chars before and after)
        const start = Math.max(0, link.index - 200);
        const end = Math.min(body.length, link.index + 800);

        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml: body.slice(start, end),
          estimatedTitle: link.title.substring(0, 50)
        });
      }

      // If no papers found, treat whole email as one block
      if (paperLinks.length === 0 && body.length > 100) {
        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml: body,
          estimatedTitle: subject.substring(0, 50)
        });
      }
    }
    // AHA Journals format: papers are in <a> tags with specific styling + cite-info divs
    else if (from.includes('ahajournals') || from.includes('heart.org')) {
      // Pattern: <a style="...font-size:18px;font-weight:bold...">Title</a> followed by loa td and cite-info div
      // Use [\s\S]*? to handle multi-line titles (some titles span multiple lines in the HTML)
      const ahaPattern = /<a[^>]*style="[^"]*font-size:18px;font-weight:bold[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

      let match;
      const paperTitles: { title: string; index: number }[] = [];

      while ((match = ahaPattern.exec(body)) !== null) {
        // Remove HTML tags and normalize whitespace (handle multi-line titles)
        const title = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (title.length > 20) {
          paperTitles.push({ title, index: match.index });
        }
      }

      // Extract context around each paper (include authors and DOI)
      for (let i = 0; i < paperTitles.length; i++) {
        const start = Math.max(0, paperTitles[i].index - 100);
        const end = i + 1 < paperTitles.length
          ? paperTitles[i + 1].index
          : Math.min(body.length, paperTitles[i].index + 2000);

        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml: body.slice(start, end),
          estimatedTitle: paperTitles[i].title.substring(0, 50)
        });
      }

      // If no papers found, treat whole email as one block
      if (paperTitles.length === 0 && body.length > 100) {
        blocks.push({
          emailId,
          emailFrom: from,
          emailSubject: subject,
          paperHtml: body,
          estimatedTitle: subject.substring(0, 50)
        });
      }
    }
    // Cell Press and other formats: treat each email as one block
    else {
      blocks.push({
        emailId,
        emailFrom: from,
        emailSubject: subject,
        paperHtml: body,
        estimatedTitle: subject.substring(0, 50)
      });
    }
  }

  return blocks;
}

/**
 * Group paper blocks into batches, respecting max papers per batch.
 */
function batchPaperBlocks(blocks: ExtractedPaperBlock[], maxPapersPerBatch: number): ExtractedPaperBlock[][] {
  const batches: ExtractedPaperBlock[][] = [];

  for (let i = 0; i < blocks.length; i += maxPapersPerBatch) {
    batches.push(blocks.slice(i, i + maxPapersPerBatch));
  }

  return batches;
}

/**
 * Estimate token count for a paper block.
 * Rough estimation: ~4 characters per token for English text.
 */
function estimateTokens(block: ExtractedPaperBlock): number {
  const text = block.paperHtml + block.emailSubject;
  // Remove HTML tags for more accurate estimation
  const plainText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return Math.ceil(plainText.length / 4);
}

/**
 * Group paper blocks into batches using hybrid strategy:
 * 1. Try to keep papers from the same email together
 * 2. Respect token limit per batch
 * 3. Fall back to splitting large emails if needed
 */
function batchPaperBlocksHybrid(
  blocks: ExtractedPaperBlock[],
  maxTokensPerBatch: number = 8000,
  maxPapersPerBatch: number = 50
): ExtractedPaperBlock[][] {
  const batches: ExtractedPaperBlock[][] = [];

  // Group blocks by email first
  const byEmail = new Map<string, ExtractedPaperBlock[]>();
  for (const block of blocks) {
    const key = block.emailId;
    if (!byEmail.has(key)) {
      byEmail.set(key, []);
    }
    byEmail.get(key)!.push(block);
  }

  let currentBatch: ExtractedPaperBlock[] = [];
  let currentTokens = 0;

  // Process each email's papers
  for (const [emailId, emailBlocks] of byEmail) {
    const emailTokens = emailBlocks.reduce((sum, b) => sum + estimateTokens(b), 0);

    // Case 1: Email fits in current batch
    if (currentTokens + emailTokens <= maxTokensPerBatch &&
        currentBatch.length + emailBlocks.length <= maxPapersPerBatch) {
      currentBatch.push(...emailBlocks);
      currentTokens += emailTokens;
    }
    // Case 2: Email doesn't fit, but current batch has content - start new batch
    else if (currentBatch.length > 0) {
      batches.push(currentBatch);

      // Check if email itself exceeds limits (needs splitting)
      if (emailTokens > maxTokensPerBatch || emailBlocks.length > maxPapersPerBatch) {
        // Split large email into smaller batches
        const splitBatches = splitLargeEmailBlocks(emailBlocks, maxTokensPerBatch, maxPapersPerBatch);
        batches.push(...splitBatches.slice(0, -1)); // Add all but last
        currentBatch = splitBatches[splitBatches.length - 1] || [];
        currentTokens = currentBatch.reduce((sum, b) => sum + estimateTokens(b), 0);
      } else {
        currentBatch = [...emailBlocks];
        currentTokens = emailTokens;
      }
    }
    // Case 3: Current batch is empty, email exceeds limits - split it
    else {
      const splitBatches = splitLargeEmailBlocks(emailBlocks, maxTokensPerBatch, maxPapersPerBatch);
      batches.push(...splitBatches.slice(0, -1));
      currentBatch = splitBatches[splitBatches.length - 1] || [];
      currentTokens = currentBatch.reduce((sum, b) => sum + estimateTokens(b), 0);
    }
  }

  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Split a large email's paper blocks into smaller batches.
 */
function splitLargeEmailBlocks(
  blocks: ExtractedPaperBlock[],
  maxTokensPerBatch: number,
  maxPapersPerBatch: number
): ExtractedPaperBlock[][] {
  const batches: ExtractedPaperBlock[][] = [];
  let currentBatch: ExtractedPaperBlock[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    const blockTokens = estimateTokens(block);

    if (currentTokens + blockTokens <= maxTokensPerBatch &&
        currentBatch.length < maxPapersPerBatch) {
      currentBatch.push(block);
      currentTokens += blockTokens;
    } else {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [block];
      currentTokens = blockTokens;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Convert paper blocks back to email-like format for the AI processor.
 */
function blocksToContent(blocks: ExtractedPaperBlock[]): string {
  // Group by email to maintain context
  const byEmail = new Map<string, ExtractedPaperBlock[]>();
  for (const block of blocks) {
    const key = block.emailId;
    if (!byEmail.has(key)) {
      byEmail.set(key, []);
    }
    byEmail.get(key)!.push(block);
  }

  let content = '';
  for (const [emailId, emailBlocks] of byEmail) {
    const first = emailBlocks[0];
    content += `--- EMAIL ID: ${emailId} ---\n`;
    content += `From: ${first.emailFrom}\n`;
    content += `Subject: ${first.emailSubject}\n`;
    content += emailBlocks.map(b => b.paperHtml).join('\n\n');
    content += '\n\n';
  }

  return content;
}

// ============ End Smart Paper Extraction ============

// Find most recent sync file within the specified time range
function findRecentSyncFile(minutesAgo: number): string | null {
  if (minutesAgo <= 0) return null;

  if (!fs.existsSync(syncedEmailsDir)) return null;

  const now = Date.now();
  const cutoffTime = now - (minutesAgo * 60 * 1000);

  const syncFiles = fs.readdirSync(syncedEmailsDir)
    .filter(f => f.startsWith('sync-') && f.endsWith('.json'))
    .map(f => {
      const match = f.match(/sync-(\d+)\.json/);
      return {
        filename: f,
        timestamp: match ? parseInt(match[1], 10) : 0
      };
    })
    .filter(f => f.timestamp >= cutoffTime)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (syncFiles.length > 0) {
    return path.join(syncedEmailsDir, syncFiles[0].filename);
  }

  return null;
}

// Check if a report was already generated today (in reports folder)
function findTodayReport(customTime?: Date): string | null {
  if (!fs.existsSync(reportsDir)) return null;

  // Get today's date in UTC+8 (Asia/Shanghai)
  const now = customTime || new Date();
  const utcPlus8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayStr = utcPlus8.toISOString().slice(0, 10); // YYYY-MM-DD

  const reportFiles = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('daily_papers_') && f.endsWith('.md'))
    .filter(f => f.includes(todayStr));

  if (reportFiles.length > 0) {
    // Return the most recent one
    reportFiles.sort().reverse();
    return path.join(reportsDir, reportFiles[0]);
  }

  return null;
}

// Parse --time argument for testing (format: --time=2026-01-15T08:00:00 or --time=2026-01-15)
function parseTimeArg(): Date | null {
  const timeArg = process.argv.find(arg => arg.startsWith('--time='));
  if (timeArg) {
    const timeStr = timeArg.split('=')[1];
    const parsed = new Date(timeStr);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    console.warn(`[Scheduler] Invalid --time format: ${timeStr}. Use format like 2026-01-15T08:00:00`);
  }
  return null;
}

// Parse --hours argument to override syncHours config (e.g., --hours=3)
function parseHoursArg(): number | null {
  const hoursArg = process.argv.find(arg => arg.startsWith('--hours='));
  if (hoursArg) {
    const hours = parseInt(hoursArg.split('=')[1], 10);
    if (!isNaN(hours) && hours > 0) {
      return hours;
    }
    console.warn(`[Scheduler] Invalid --hours format: ${hoursArg}. Use format like --hours=3`);
  }
  return null;
}

// Parse --sync-file argument to use a specific synced emails file for testing
// e.g., --sync-file=synced_emails/sync-1768521623185.json
function parseSyncFileArg(): string | null {
  const syncFileArg = process.argv.find(arg => arg.startsWith('--sync-file='));
  if (syncFileArg) {
    const filePath = syncFileArg.split('=')[1];
    // Resolve relative to current working directory
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }
    console.warn(`[Scheduler] Sync file not found: ${filePath}`);
  }
  return null;
}

// Parse --debug flag for verbose output
function isDebugMode(): boolean {
  return process.argv.includes('--debug') || process.argv.includes('-v') || process.argv.includes('--verbose');
}

// Debug logger - only logs if debug mode is enabled
const debugLog = (message: string, ...args: any[]) => {
  if (isDebugMode()) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
};

async function generateDailyReport(): Promise<void> {
  // Reload config first to get timezone
  const currentConfig = loadConfig();

  // Override syncHours if --hours argument provided
  const customHours = parseHoursArg();
  if (customHours) {
    currentConfig.syncHours = customHours;
    console.log(`[Scheduler] Using custom sync hours: ${customHours}`);
  }

  // Generate timestamp in configured timezone (simple UTC+8 for Asia/Shanghai)
  // If --time argument provided, use that instead of current time
  const customTime = parseTimeArg();
  const now = customTime || new Date();
  if (customTime) {
    console.log(`[Scheduler] Using custom time: ${customTime.toISOString()}`);
  }
  const utcPlus8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const timestamp = utcPlus8.toISOString().slice(0, 19).replace(/[:.]/g, '-');

  console.log(`\n[${utcPlus8.toISOString().slice(0, 19).replace('T', ' ')}] Starting daily report generation...`);

  // Check for --sync-file argument first (for testing with specific file)
  // If specified, always process it regardless of existing paper list
  const customSyncFile = parseSyncFileArg();

  // Check if today's paper list already exists - skip extraction if so
  // BUT: if --sync-file is specified, we always process it (for testing)
  const existingPaperList = findTodayReport(customTime);
  let skipExtraction = !!existingPaperList;

  if (customSyncFile) {
    console.log(`[Scheduler] Using specified sync file: ${path.basename(customSyncFile)}`);
    if (skipExtraction) {
      console.log('[Scheduler] Overriding skip extraction for --sync-file testing');
      skipExtraction = false;
    }
  } else if (skipExtraction) {
    console.log(`[Scheduler] Today's paper list already exists: ${path.basename(existingPaperList!)}`);
    console.log('[Scheduler] Skipping paper extraction - will only generate review');
  }

  // Step 1: Get emails (from recent sync or new Gmail sync) - skip if paper list exists
  if (!skipExtraction) {
    let syncFilePath: string | null = null;

    // Use --sync-file if specified
    if (customSyncFile) {
      syncFilePath = customSyncFile;
    }
    // Check for recent sync file
    else {
      const recentSyncFile = findRecentSyncFile(currentConfig.reuseRecentSyncMinutes);
      if (recentSyncFile) {
        console.log(`[Scheduler] Found recent sync file (within ${currentConfig.reuseRecentSyncMinutes} min): ${path.basename(recentSyncFile)}`);
        syncFilePath = recentSyncFile;
      } else if (currentConfig.syncEnabled) {
        console.log('[Scheduler] Step 1: Syncing emails from Gmail...');
        try {
          const syncResult = await syncGmailEmails(currentConfig.syncHours, currentConfig.syncLimit);
          if (syncResult) {
            console.log(`[Scheduler] Gmail sync completed: ${syncResult}`);
            syncFilePath = syncResult;
          } else {
            console.log('[Scheduler] No new emails to sync');
          }
        } catch (e) {
          console.error('[Scheduler] Gmail sync failed:', e);
          console.log('[Scheduler] Continuing with existing analysis files...');
        }
      } else {
        console.log('[Scheduler] Gmail sync disabled, using existing analysis files');
      }
    }

    // Process the synced emails if we have a sync file
    if (syncFilePath) {
    console.log('[Scheduler] Processing synced emails...');
    const syncedContent = fs.readFileSync(syncFilePath, 'utf-8');
    const rawEmails = JSON.parse(syncedContent);

    if (rawEmails.length > 0) {
      // Load keywords from localStorage backup or use defaults
      const keywordsPath = path.resolve(process.cwd(), 'keywords.json');
      let keywords = ['Aortic Disease', 'Marfan Syndrome', 'organoid', 'AI virtual cell', 'single-cell proteomics'];
      let penaltyKeywords: string[] = [];
      if (fs.existsSync(keywordsPath)) {
        try {
          const keywordsData = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
          // Support both old array format and new object format
          if (Array.isArray(keywordsData)) {
            keywords = keywordsData;
          } else {
            keywords = keywordsData.keywords || keywords;
            penaltyKeywords = keywordsData.penaltyKeywords || [];
          }
        } catch (e) {
          console.warn('[Scheduler] Failed to load keywords, using defaults');
        }
      }
      if (penaltyKeywords.length > 0) {
        console.log(`[Scheduler] Loaded ${keywords.length} keywords and ${penaltyKeywords.length} penalty keywords`);
      }

      console.log(`[Scheduler] Processing ${rawEmails.length} emails...`);

      // Step 1: Extract all articles using emailArticleExtractor (efficient HTML parsing)
      console.log(`[Scheduler] Extracting articles from ${rawEmails.length} emails using ArticleExtractor...`);
      interface ExtractedArticle {
        title: string;
        authors?: string;
        abstract?: string;
        journal: string;
        doi?: string;
      }
      const allExtractedArticles: ExtractedArticle[] = [];

      for (const email of rawEmails) {
        try {
          const articles = extractArticlesFromEmail(
            email.body || '',
            email.from || '',
            email.subject || ''
          );
          for (const article of articles) {
            // Skip fallback articles (entire email as one article)
            if (article.journal === 'Unknown' && article.title === email.subject) {
              continue;
            }
            allExtractedArticles.push({
              title: article.title,
              authors: article.authors,
              abstract: article.abstract,
              journal: article.journal || 'Unknown',
              doi: article.doi
            });
          }
        } catch (e) {
          console.warn(`[Scheduler] Failed to extract from email: ${(email.subject || '').substring(0, 40)}`);
        }
      }

      console.log(`[Scheduler] Extracted ${allExtractedArticles.length} articles from ${rawEmails.length} emails`);

      // Step 2: Batch extracted articles for scoring
      const batches: ExtractedArticle[][] = [];
      for (let i = 0; i < allExtractedArticles.length; i += currentConfig.scoreBatchSize) {
        batches.push(allExtractedArticles.slice(i, i + currentConfig.scoreBatchSize));
      }

      let allPapers: Paper[] = [];
      console.log(`[Scheduler] Scoring ${allExtractedArticles.length} articles in ${batches.length} batch(es) (${currentConfig.scoreBatchSize} per batch)...`);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`[Scheduler] Scoring batch ${i + 1}/${batches.length} (${batch.length} articles)...`);

        try {
          const result = await scoreExtractedArticles(batch, keywords, currentConfig.analysisLimit, penaltyKeywords);

          // Filter papers by minScore immediately after each batch
          const filteredBatchPapers = result.papers.filter(p => p.relevanceScore >= currentConfig.minScore);
          allPapers = [...allPapers, ...filteredBatchPapers];
          console.log(`[Scheduler] Batch ${i + 1} complete: ${result.papers.length} scored, ${filteredBatchPapers.length} above minScore (${currentConfig.minScore})`);
        } catch (batchError) {
          console.error(`[Scheduler] Error scoring batch ${i + 1}:`, batchError);
          // Continue to next batch even if this one failed
        }

        // Add delay between batches to avoid rate limiting
        if (i < batches.length - 1 && currentConfig.batchDelaySeconds > 0) {
          console.log(`[Scheduler] Waiting ${currentConfig.batchDelaySeconds}s before next batch...`);
          await new Promise(resolve => setTimeout(resolve, currentConfig.batchDelaySeconds * 1000));
        }
      }

      // Deduplicate (minScore already filtered per batch)
      const dedupedPapers = deduplicatePapers(allPapers);
      console.log(`[Scheduler] Total: ${allPapers.length} papers after per-batch filtering, ${dedupedPapers.length} unique`);

      if (dedupedPapers.length > 0) {
        // Save extracted papers to analysis file immediately
        // This ensures Step 2 includes the newly extracted papers
        const extractionAnalysis = {
          papers: dedupedPapers,
          summary: {
            overview: `Extracted ${dedupedPapers.length} papers from ${rawEmails.length} emails`,
            keyTrends: [],
            topRecommendations: [],
            categorizedPapers: [],
            academicReport: '' // Will be filled after review generation
          }
        };
        let extractionFilename = `analysis-${Date.now()}.json`;
        fs.writeFileSync(
          path.join(syncedEmailsDir, extractionFilename),
          JSON.stringify(extractionAnalysis, null, 2)
        );
        console.log(`[Scheduler] Saved extracted papers to ${extractionFilename}`);

        // Validate paper titles against original emails
        if (syncFilePath) {
          console.log(`[Scheduler] Validating extracted paper titles against synced emails...`);
          try {
            const validationReport = await validateExtraction(
              syncFilePath,
              path.join(syncedEmailsDir, extractionFilename)
            );
            console.log(`[Scheduler] Validation: ${validationReport.validated}/${validationReport.totalPapers} papers validated (${validationReport.validationRate.toFixed(1)}%)`);
            if (validationReport.notFound > 0) {
              console.warn(`[Scheduler] ⚠️  ${validationReport.notFound} papers not found in emails (potential hallucinations)`);
              // Log the not-found papers for debugging
              const notFoundPapers = validationReport.results.filter(r => !r.found);
              for (const result of notFoundPapers.slice(0, 5)) { // Show first 5
                console.warn(`[Scheduler]   - ${result.paper.title.substring(0, 60)}...`);
              }
              if (notFoundPapers.length > 5) {
                console.warn(`[Scheduler]   ... and ${notFoundPapers.length - 5} more`);
              }

              // Generate refined analysis and report (without hallucinations)
              console.log(`[Scheduler] Generating refined analysis (removing hallucinations)...`);
              const refinedResult = await refineAndSave(validationReport);
              console.log(`[Scheduler] Refined: ${refinedResult.refinedCount} papers kept, ${refinedResult.removedCount} removed`);
              console.log(`[Scheduler] Refined analysis: ${path.basename(refinedResult.refinedAnalysisFile)}`);
              console.log(`[Scheduler] Refined report: ${path.basename(refinedResult.refinedReportFile)}`);

              // Delete the initial extraction file (we have the refined one now)
              const initialFilePath = path.join(syncedEmailsDir, extractionFilename);
              if (fs.existsSync(initialFilePath)) {
                fs.unlinkSync(initialFilePath);
                console.log(`[Scheduler] Deleted initial extraction: ${extractionFilename}`);
              }

              // Use refined file for subsequent steps
              extractionFilename = path.basename(refinedResult.refinedAnalysisFile);

              // Mark that we already have a complete refined file with literature review
              (globalThis as any).__refinedComplete = true;
            }
          } catch (validationError) {
            console.warn(`[Scheduler] Validation skipped:`, validationError);
          }
        }

        // Store the filename so Step 2 can use ONLY this file (not aggregate with old files)
        // This prevents confusion when testing with --hours parameter
        (globalThis as any).__currentExtractionFile = extractionFilename;
      } else {
        console.log('[Scheduler] No papers passed the minScore filter, skipping save');
      }
    }
    } // end if (syncFilePath)
  } // end if (!skipExtraction)

  // Step 2: Generate report from analysis files
  console.log('[Scheduler] Step 2: Generating report from analysis files...');

  if (!fs.existsSync(syncedEmailsDir)) {
    console.error("[Scheduler] synced_emails directory not found");
    return;
  }

  // If we just extracted papers, use ONLY that file (not old files)
  // This prevents accumulating papers from previous runs
  const currentExtractionFile = (globalThis as any).__currentExtractionFile;
  let filesToProcess: string[];

  if (currentExtractionFile && !skipExtraction) {
    // Use only the file we just created
    filesToProcess = [currentExtractionFile];
    console.log(`[Scheduler] Using only current extraction: ${currentExtractionFile}`);
    delete (globalThis as any).__currentExtractionFile;
  } else {
    // No new extraction - aggregate from existing analysis files
    const allFiles = fs.readdirSync(syncedEmailsDir).filter(f => f.startsWith('analysis-') && f.endsWith('.json'));

    if (allFiles.length === 0) {
      console.log("[Scheduler] No analysis files found. Skipping report generation.");
      return;
    }

    // Calculate today's start time (midnight) in configured timezone
    const nowForFilter = customTime || new Date();
    const nowMs = nowForFilter.getTime();

    // Get start of today in UTC+8 (Asia/Shanghai)
    const utcPlus8Now = new Date(nowMs + 8 * 60 * 60 * 1000);
    const todayDateStr = utcPlus8Now.toISOString().slice(0, 10); // YYYY-MM-DD
    const todayMidnightUtcPlus8 = new Date(todayDateStr + 'T00:00:00.000Z');
    const todayStartMs = todayMidnightUtcPlus8.getTime() - 8 * 60 * 60 * 1000;

    const fileInfos = allFiles.map(f => {
      const match = f.match(/analysis-(\d+)\.json/);
      return {
        filename: f,
        timestamp: match ? parseInt(match[1], 10) : 0
      };
    });

    // Filter files from today or by hours if specified
    let recentFiles;
    if (customHours && customHours < 24) {
      const hoursMs = customHours * 60 * 60 * 1000;
      recentFiles = fileInfos.filter(f => (nowMs - f.timestamp) <= hoursMs);
      console.log(`[Scheduler] Processing ${recentFiles.length} files from the last ${customHours} hours.`);
    } else {
      recentFiles = fileInfos.filter(f => f.timestamp >= todayStartMs);
      console.log(`[Scheduler] Processing ${recentFiles.length} files from today (${todayDateStr}).`);
    }

    if (recentFiles.length === 0) {
      console.log(`[Scheduler] No analysis files found for the specified time range. Skipping report generation.`);
      return;
    }

    filesToProcess = recentFiles.map(f => f.filename);
  }

  let allPapers: Paper[] = [];

  for (const filename of filesToProcess) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(syncedEmailsDir, filename), 'utf-8'));
      if (content.papers && Array.isArray(content.papers)) {
        allPapers.push(...content.papers);
      }
    } catch (e) {
      console.warn(`[Scheduler] Failed to read or parse ${filename}:`, e);
    }
  }

  console.log(`[Scheduler] Found ${allPapers.length} total papers.`);

  // Deduplicate
  const uniquePapers = new Map<string, Paper>();
  for (const p of allPapers) {
    const key = p.title.toLowerCase().trim();
    if (!uniquePapers.has(key)) {
      uniquePapers.set(key, p);
    } else {
      const existing = uniquePapers.get(key)!;
      if ((p.relevanceScore || 0) > (existing.relevanceScore || 0)) {
        uniquePapers.set(key, p);
      }
    }
  }

  const papers = Array.from(uniquePapers.values());
  console.log(`[Scheduler] Unique papers: ${papers.length}`);

  if (papers.length === 0) {
    console.log("[Scheduler] No papers to process after deduplication.");
    return;
  }

  // Sort by relevance
  papers.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

  // Generate Markdown List (skip if paper list already exists)
  if (!skipExtraction) {
    let mdContent = "# Daily Paper Report\n\n";
    mdContent += `Generated on ${new Date().toLocaleString()}\n`;
    mdContent += `Total Papers: ${papers.length}\n\n`;

    for (const [i, p] of papers.entries()) {
      mdContent += `## ${i + 1}. ${p.title}\n`;
      mdContent += `**Authors:** ${p.authors ? p.authors.join(', ') : 'Unknown'}\n`;
      mdContent += `**Source:** ${p.source} (${p.date})\n`;
      mdContent += `**Score:** ${p.relevanceScore}\n`;
      if (p.snippet) mdContent += `**Snippet:** ${p.snippet}\n`;
      mdContent += `\n---\n\n`;
    }

    const papersFilename = `daily_papers_${timestamp}.md`;
    fs.writeFileSync(path.join(reportsDir, papersFilename), mdContent);
    console.log(`[Scheduler] Created '${papersFilename}'`);
  }

  // Aggregate keywords
  const keywordCounts = new Map<string, number>();
  for (const p of papers) {
    if (p.matchedKeywords) {
      for (const k of p.matchedKeywords) {
        const normalized = k.toLowerCase().trim();
        if (normalized) {
          keywordCounts.set(normalized, (keywordCounts.get(normalized) || 0) + 1);
        }
      }
    }
  }

  const topKeywords = Array.from(keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(e => e[0]);

  console.log("[Scheduler] Top keywords:", topKeywords);

  // Generate Literature Review
  // Filter papers by minScore to ensure only relevant papers are included in the review
  // Papers are already sorted by relevance score (descending)
  let reviewPapers = papers.filter(p => p.relevanceScore >= currentConfig.minScore);

  console.log(`[Scheduler] Starting Literature Review generation with ${reviewPapers.length} papers...`);
  let generatedReview = '';
  try {
    let review = await generateLiteratureReviewLightweight(reviewPapers, topKeywords);

    // Append reference list
    let references = "\n\n---\n\n## References / 参考文献\n\n";
    for (const [i, p] of reviewPapers.entries()) {
      const authorStr = p.authors ? p.authors.join(", ") : "Unknown";
      references += `[${i + 1}] ${authorStr}. "${p.title}". ${p.source || 'Unknown Source'}${p.date ? `, ${p.date}` : ''}.\n\n`;
    }
    review += references;
    generatedReview = review;

    const reviewFilename = `daily_review_${timestamp}.md`;
    fs.writeFileSync(path.join(reportsDir, reviewFilename), review);
    console.log(`[Scheduler] Created '${reviewFilename}'`);
  } catch (e) {
    console.error("[Scheduler] Failed to generate review:", e);
  }

  // Save analysis file with papers used for review (like web app results)
  // Build categorized papers by keyword
  const categorizedPapers: { keyword: string; paperIds: string[] }[] = [];
  const keywordMap = new Map<string, string[]>();
  for (const p of reviewPapers) {
    if (p.matchedKeywords) {
      for (const kw of p.matchedKeywords) {
        if (!keywordMap.has(kw)) {
          keywordMap.set(kw, []);
        }
        keywordMap.get(kw)!.push(p.id);
      }
    }
  }
  for (const [keyword, paperIds] of keywordMap) {
    categorizedPapers.push({ keyword, paperIds });
  }

  // Skip creating another analysis file if refined version was already created
  if (!(globalThis as any).__refinedComplete) {
    const analysisForReview = {
      papers: reviewPapers,
      summary: {
        overview: `Daily literature review generated from ${reviewPapers.length} papers (out of ${papers.length} total) on ${new Date().toLocaleDateString()}. Top keywords: ${topKeywords.slice(0, 5).join(', ')}.`,
        keyTrends: topKeywords.slice(0, 5).map(kw => `Research on ${kw}`),
        topRecommendations: reviewPapers.slice(0, 5).map(p => p.title),
        categorizedPapers: categorizedPapers,
        academicReport: generatedReview
      }
    };
    const analysisReviewFilename = `analysis-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(syncedEmailsDir, analysisReviewFilename),
      JSON.stringify(analysisForReview, null, 2)
    );
    console.log(`[Scheduler] Saved review analysis to ${analysisReviewFilename}`);
  } else {
    console.log(`[Scheduler] Skipping duplicate analysis file (refined version already created)`);
  }

  console.log(`[Scheduler] Daily report generation completed at ${new Date().toLocaleString()}`);
}

// Load configuration
const config = loadConfig();
const CRON_SCHEDULE = timeToCron(config.time);

console.log(`[Scheduler] Starting ScholarPulse Daily Report Scheduler`);
console.log(`[Scheduler] Enabled: ${config.enabled}`);
console.log(`[Scheduler] Schedule: Every day at ${config.time} (${CRON_SCHEDULE})`);
console.log(`[Scheduler] Timezone: ${config.timezone}`);
console.log(`[Scheduler] Gmail Sync: ${config.syncEnabled ? `enabled (${config.syncHours}h, max ${config.syncLimit} emails)` : 'disabled'}`);
console.log(`[Scheduler] Reuse recent sync: ${config.reuseRecentSyncMinutes > 0 ? `within ${config.reuseRecentSyncMinutes} min` : 'disabled'}`);
console.log(`[Scheduler] Processing: batchSize=${config.batchSize}, batchDelay=${config.batchDelaySeconds}s, analysisLimit=${config.analysisLimit}, minScore=${config.minScore}`);
console.log(`[Scheduler] Reports will be saved to: ${reportsDir}`);
console.log(`[Scheduler] Current time: ${new Date().toLocaleString()}`);

if (!config.enabled) {
  console.log("[Scheduler] Scheduler is disabled in config. Exiting...");
  console.log("[Scheduler] To enable, set 'enabled: true' in scheduler.config.json or via the web UI Settings.");
  process.exit(0);
}

// Schedule the task
cron.schedule(CRON_SCHEDULE, () => {
  generateDailyReport().catch(err => {
    console.error("[Scheduler] Error during daily report generation:", err);
  });
}, {
  timezone: config.timezone
});

console.log("[Scheduler] Scheduler is running. Press Ctrl+C to stop.\n");

// Run immediately on startup if --now flag is passed
if (process.argv.includes('--now')) {
  console.log("[Scheduler] --now flag detected. Running report generation immediately...");
  generateDailyReport().catch(err => {
    console.error("[Scheduler] Error during immediate report generation:", err);
  });
}
