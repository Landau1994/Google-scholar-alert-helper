import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { generateLiteratureReviewLightweight, processScholarEmailsLightweight, deduplicatePapers } from '../services/geminiService.ts';
import type { Paper } from '../types.ts';
import { syncGmailEmails } from './syncGmail.ts';

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
  reviewPaperLimit: number; // Max papers to include in literature review (0 = no limit)
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
    reviewPaperLimit: 50 // Default: top 50 papers for review generation
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
function findTodayReport(): string | null {
  if (!fs.existsSync(reportsDir)) return null;

  // Get today's date in UTC+8 (Asia/Shanghai)
  const now = new Date();
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

async function generateDailyReport(): Promise<void> {
  // Reload config first to get timezone
  const currentConfig = loadConfig();

  // Generate timestamp in configured timezone (simple UTC+8 for Asia/Shanghai)
  const now = new Date();
  const utcPlus8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const timestamp = utcPlus8.toISOString().slice(0, 19).replace(/[:.]/g, '-');

  console.log(`\n[${utcPlus8.toISOString().slice(0, 19).replace('T', ' ')}] Starting daily report generation...`);

  // Check if today's paper list already exists - skip extraction if so
  const existingPaperList = findTodayReport();
  const skipExtraction = !!existingPaperList;

  if (skipExtraction) {
    console.log(`[Scheduler] Today's paper list already exists: ${path.basename(existingPaperList!)}`);
    console.log('[Scheduler] Skipping paper extraction - will only generate review');
  }

  // Step 1: Get emails (from recent sync or new Gmail sync) - skip if paper list exists
  if (!skipExtraction) {
    let syncFilePath: string | null = null;

    // Check for recent sync file first
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

    // Process the synced emails if we have a sync file
    if (syncFilePath) {
    console.log('[Scheduler] Processing synced emails...');
    const syncedContent = fs.readFileSync(syncFilePath, 'utf-8');
    const rawEmails = JSON.parse(syncedContent);

    if (rawEmails.length > 0) {
      // Load keywords from localStorage backup or use defaults
      const keywordsPath = path.resolve(process.cwd(), 'keywords.json');
      let keywords = ['Aortic Disease', 'Marfan Syndrome', 'organoid', 'AI virtual cell', 'single-cell proteomics'];
      if (fs.existsSync(keywordsPath)) {
        try {
          keywords = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
        } catch (e) {
          console.warn('[Scheduler] Failed to load keywords, using defaults');
        }
      }

      // Process emails through AI using batch processing (like web app)
      const BATCH_SIZE = currentConfig.batchSize;
      const totalBatches = Math.ceil(rawEmails.length / BATCH_SIZE);
      let allPapers: Paper[] = [];

      console.log(`[Scheduler] Processing ${rawEmails.length} emails in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

      for (let i = 0; i < totalBatches; i++) {
        const start = i * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, rawEmails.length);
        const batch = rawEmails.slice(start, end);

        console.log(`[Scheduler] Processing batch ${i + 1}/${totalBatches} (${batch.length} emails)...`);

        const rawContent = batch.map((e: any) =>
          `--- EMAIL ID: ${e.id} ---\nFrom: ${e.from || 'Unknown'}\nSubject: ${e.subject}\n${e.body}\n\n`
        ).join('');

        try {
          const result = await processScholarEmailsLightweight(rawContent, keywords, currentConfig.analysisLimit);

          // Filter papers by minScore immediately after each batch extraction
          // This prevents accumulating too many low-relevance papers (e.g., from large bioRxiv emails)
          const filteredBatchPapers = result.papers.filter(p => p.relevanceScore >= currentConfig.minScore);
          allPapers = [...allPapers, ...filteredBatchPapers];
          console.log(`[Scheduler] Batch ${i + 1} complete: found ${result.papers.length} papers, ${filteredBatchPapers.length} above minScore (${currentConfig.minScore})`);
        } catch (batchError) {
          console.error(`[Scheduler] Error processing batch ${i + 1}:`, batchError);
          // Continue to next batch even if this one failed
        }

        // Add delay between batches (except after the last one)
        if (i < totalBatches - 1 && currentConfig.batchDelaySeconds > 0) {
          console.log(`[Scheduler] Waiting ${currentConfig.batchDelaySeconds}s before next batch...`);
          await delay(currentConfig.batchDelaySeconds * 1000);
        }
      }

      // Deduplicate (minScore already filtered per batch)
      const dedupedPapers = deduplicatePapers(allPapers);
      console.log(`[Scheduler] Total: ${allPapers.length} papers after per-batch filtering, ${dedupedPapers.length} unique`);

      if (dedupedPapers.length > 0) {
        // Save analysis result
        const analysisFilename = `analysis-${Date.now()}.json`;
        fs.writeFileSync(
          path.join(syncedEmailsDir, analysisFilename),
          JSON.stringify({ papers: dedupedPapers, summary: {} }, null, 2)
        );
        console.log(`[Scheduler] Analysis saved to ${analysisFilename}`);
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

  const allFiles = fs.readdirSync(syncedEmailsDir).filter(f => f.startsWith('analysis-') && f.endsWith('.json'));

  if (allFiles.length === 0) {
    console.log("[Scheduler] No analysis files found. Skipping report generation.");
    return;
  }

  // Parse timestamps and find files from the last 24 hours
  const nowMs = Date.now();
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  const fileInfos = allFiles.map(f => {
    const match = f.match(/analysis-(\d+)\.json/);
    return {
      filename: f,
      timestamp: match ? parseInt(match[1], 10) : 0
    };
  });

  // Filter files from the last 24 hours
  const recentFiles = fileInfos.filter(f => (nowMs - f.timestamp) <= TWENTY_FOUR_HOURS_MS);

  if (recentFiles.length === 0) {
    console.log("[Scheduler] No new analysis files in the last 24 hours. Skipping report generation.");
    return;
  }

  console.log(`[Scheduler] Processing ${recentFiles.length} files from the last 24 hours.`);

  let allPapers: Paper[] = [];

  for (const info of recentFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(syncedEmailsDir, info.filename), 'utf-8'));
      if (content.papers && Array.isArray(content.papers)) {
        allPapers.push(...content.papers);
      }
    } catch (e) {
      console.warn(`[Scheduler] Failed to read or parse ${info.filename}:`, e);
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
  let reviewPapers = papers.filter(p => p.relevanceScore >= currentConfig.minScore);

  // Truncate to top N papers if reviewPaperLimit is set (papers already sorted by relevance)
  if (currentConfig.reviewPaperLimit > 0 && reviewPapers.length > currentConfig.reviewPaperLimit) {
    console.log(`[Scheduler] Truncating from ${reviewPapers.length} to top ${currentConfig.reviewPaperLimit} papers for review`);
    reviewPapers = reviewPapers.slice(0, currentConfig.reviewPaperLimit);
  }

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
