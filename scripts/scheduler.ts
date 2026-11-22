import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { generateLiteratureReviewLightweight, scoreExtractedArticles, deduplicatePapers } from '../services/geminiService.ts';
import type { Paper } from '../types.ts';
import { syncGmailEmails } from './syncGmail.ts';
import { validateExtraction, refineAndSave } from './validatePaperTitles.ts';
import { extractArticlesFromEmail } from '../services/emailArticleExtractor.ts';
import { indexPapers } from '../services/vectorService.ts';
import { GEMINI_FLASH_MODEL } from '../services/geminiModels.ts';

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

// Timezone-aware date formatting and midnight calculation using Intl.DateTimeFormat
function getTimezoneDateInfo(date: Date, timeZone: string) {
  const safeTimeZone = timeZone || 'Asia/Shanghai';
  const getParts = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: safeTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return {
      year: map.year,
      month: map.month,
      day: map.day,
      hour: map.hour,
      minute: map.minute,
      second: map.second,
    };
  };

  const p = getParts(date);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const timestamp = `${dateStr}T${p.hour}-${p.minute}-${p.second}`;
  const display = `${dateStr} ${p.hour}:${p.minute}:${p.second}`;

  // Calculate UTC epoch ms corresponding to 00:00:00 of `dateStr` in `safeTimeZone`
  const utcMidnightGuess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0);
  const guessParts = getParts(new Date(utcMidnightGuess));
  const tzAsUtc = Date.UTC(
    Number(guessParts.year),
    Number(guessParts.month) - 1,
    Number(guessParts.day),
    Number(guessParts.hour),
    Number(guessParts.minute),
    Number(guessParts.second)
  );
  const offsetMs = tzAsUtc - utcMidnightGuess;
  const startOfDayMs = utcMidnightGuess - offsetMs;

  return { dateStr, timestamp, display, startOfDayMs };
}

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
function findTodayReport(timezone: string, customTime?: Date | null): string | null {
  if (!fs.existsSync(reportsDir)) return null;

  const now = customTime || new Date();
  const { dateStr: todayStr } = getTimezoneDateInfo(now, timezone);

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

  // Generate timestamp in configured timezone
  const customTime = parseTimeArg();
  const now = customTime || new Date();
  if (customTime) {
    console.log(`[Scheduler] Using custom time: ${customTime.toISOString()}`);
  }
  const { timestamp, display } = getTimezoneDateInfo(now, currentConfig.timezone);

  console.log(`\n[${display} (${currentConfig.timezone})] Starting daily report generation...`);

  // Check for --sync-file argument first (for testing with specific file)
  // If specified, always process it regardless of existing paper list
  const customSyncFile = parseSyncFileArg();

  // Check if today's paper list already exists - skip extraction if so
  // BUT: if --sync-file is specified, we always process it (for testing)
  const existingPaperList = findTodayReport(currentConfig.timezone, customTime);
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
    const { dateStr: todayDateStr, startOfDayMs: todayStartMs } = getTimezoneDateInfo(nowForFilter, currentConfig.timezone);

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

  // Ensure all papers are indexed in vector database
  console.log(`[Scheduler] Checking vector indexing for ${papers.length} papers...`);
  try {
    await indexPapers(papers);
    console.log(`[Scheduler] Vector indexing check complete.`);
  } catch (vectorError) {
    console.error(`[Scheduler] Vector indexing failed:`, vectorError);
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

  // UPDATE the primary analysis file with the generated review instead of creating a new one
  if (filesToProcess && filesToProcess.length > 0) {
    const primaryFile = filesToProcess[0]; // The most recent one or the one we just created
    const primaryPath = path.join(syncedEmailsDir, primaryFile);
    
    if (fs.existsSync(primaryPath)) {
      try {
        const fileData = JSON.parse(fs.readFileSync(primaryPath, 'utf-8'));
        if (!fileData.summary) {
          fileData.summary = {};
        }
        
        fileData.summary.overview = `Daily literature review generated from ${reviewPapers.length} papers (out of ${papers.length} total) on ${new Date().toLocaleDateString()}. Top keywords: ${topKeywords.slice(0, 5).join(', ')}.`;
        fileData.summary.keyTrends = topKeywords.slice(0, 5).map(kw => `Research on ${kw}`);
        fileData.summary.topRecommendations = reviewPapers.slice(0, 5).map(p => p.title);
        fileData.summary.categorizedPapers = categorizedPapers;
        fileData.summary.academicReport = generatedReview;
        
        // Ensure the saved papers exactly match those used in the review (filtered by minScore)
        fileData.papers = reviewPapers;
        
        fs.writeFileSync(primaryPath, JSON.stringify(fileData, null, 2));
        console.log(`[Scheduler] Updated primary analysis file with review: ${primaryFile}`);
      } catch (e) {
        console.error(`[Scheduler] Failed to update analysis file with review:`, e);
      }
    }
  }

  console.log(`[Scheduler] Daily report generation completed at ${new Date().toLocaleString()}`);
}

// Manage active cron task with automatic hot-reload when scheduler.config.json changes
let activeTask: ReturnType<typeof cron.schedule> | null = null;
let lastScheduleSignature = '';

function applyScheduleFromConfig(isReload: boolean = false) {
  const cfg = loadConfig();
  const cronExpr = timeToCron(cfg.time);
  const signature = `${cfg.enabled}|${cronExpr}|${cfg.timezone}`;

  if (isReload && signature === lastScheduleSignature) {
    return;
  }

  if (activeTask) {
    activeTask.stop();
    activeTask = null;
  }

  lastScheduleSignature = signature;

  if (!isReload) {
    console.log(`[Scheduler] Starting ScholarPulse Daily Report Scheduler`);
    console.log(`[Scheduler] Text model: ${GEMINI_FLASH_MODEL}`);
    console.log(`[Scheduler] Reports will be saved to: ${reportsDir}`);
    console.log(`[Scheduler] Current time: ${new Date().toLocaleString()}`);
  } else {
    console.log(`\n[Scheduler] Detected config update — reloading schedule...`);
  }

  console.log(`[Scheduler] Enabled: ${cfg.enabled}`);
  console.log(`[Scheduler] Schedule: Every day at ${cfg.time} (${cronExpr})`);
  console.log(`[Scheduler] Timezone: ${cfg.timezone}`);
  console.log(`[Scheduler] Gmail Sync: ${cfg.syncEnabled ? `enabled (${cfg.syncHours}h, max ${cfg.syncLimit} emails)` : 'disabled'}`);
  console.log(`[Scheduler] Reuse recent sync: ${cfg.reuseRecentSyncMinutes > 0 ? `within ${cfg.reuseRecentSyncMinutes} min` : 'disabled'}`);
  console.log(`[Scheduler] Processing: batchSize=${cfg.batchSize}, batchDelay=${cfg.batchDelaySeconds}s, analysisLimit=${cfg.analysisLimit}, minScore=${cfg.minScore}`);

  if (!cfg.enabled) {
    console.log("[Scheduler] Scheduler is currently paused (enabled=false). Watching scheduler.config.json for changes...");
    return;
  }

  activeTask = cron.schedule(cronExpr, () => {
    generateDailyReport().catch(err => {
      console.error("[Scheduler] Error during daily report generation:", err);
    });
  }, {
    timezone: cfg.timezone
  });

  console.log("[Scheduler] Cron schedule active. Watching scheduler.config.json for live updates.\n");
}

applyScheduleFromConfig(false);

// Watch scheduler.config.json for hot-reload (no manual pm2 restart needed)
let reloadTimer: NodeJS.Timeout | null = null;
fs.watchFile(configPath, { interval: 3000 }, () => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      applyScheduleFromConfig(true);
    } catch (e) {
      console.error('[Scheduler] Failed to hot-reload config:', e);
    }
  }, 500);
});

// Run immediately on startup if --now flag is passed
if (process.argv.includes('--now')) {
  console.log("[Scheduler] --now flag detected. Running report generation immediately...");
  generateDailyReport().catch(err => {
    console.error("[Scheduler] Error during immediate report generation:", err);
  });
}
