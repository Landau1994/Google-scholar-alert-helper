/**
 * Paper Title Validation Script
 *
 * Validates that extracted paper titles exist in the original synced emails.
 * This helps detect potential AI hallucinations where the model invents paper titles.
 *
 * Usage:
 *   bun run scripts/validatePaperTitles.ts [--sync <sync-file>] [--analysis <analysis-file>] [--verbose]
 *
 * If no files specified, uses the most recent sync/analysis pair.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables for Gemini API
import './loadEnv.ts';

// Import types and services
import type { Paper, RawEmail } from '../types';
import { generateLiteratureReviewLightweight } from '../services/geminiService.ts';

// Directory containing synced emails and analysis
const SYNCED_EMAILS_DIR = path.join(__dirname, '..', 'synced_emails');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const KEYWORDS_FILE = path.join(__dirname, '..', 'keywords.json');

interface ValidationResult {
  paper: Paper;
  found: boolean;
  matchType: 'exact' | 'normalized' | 'partial' | 'not_found';
  matchDetails?: string;
}

interface ValidationReport {
  syncFile: string;
  analysisFile: string;
  totalPapers: number;
  validated: number;
  notFound: number;
  validationRate: number;
  results: ValidationResult[];
}

/**
 * Normalize text for comparison:
 * - Lowercase
 * - Decode HTML entities
 * - Remove extra whitespace
 * - Remove special characters
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    // Normalize unicode characters
    .normalize('NFKD')
    // Remove diacritics
    .replace(/[\u0300-\u036f]/g, '')
    // Normalize quotes and dashes
    .replace(/[""'']/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract significant words from a title (for partial matching).
 * Filters out common words and short words.
 */
function extractSignificantWords(title: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'can', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'its',
    'their', 'this', 'that', 'these', 'those', 'using', 'based', 'via'
  ]);

  return normalizeText(title)
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word));
}

/**
 * Check if a title exists in the email content.
 * Returns match type: exact, normalized, partial, or not_found.
 */
function checkTitleInContent(title: string, content: string): { found: boolean; matchType: ValidationResult['matchType']; details?: string } {
  // Skip very short or invalid titles
  if (!title || title.length < 10) {
    return { found: false, matchType: 'not_found', details: 'Title too short or invalid' };
  }

  const normalizedTitle = normalizeText(title);
  const normalizedContent = normalizeText(content);

  // Check 1: Exact match (after basic normalization)
  if (normalizedContent.includes(normalizedTitle)) {
    return { found: true, matchType: 'exact' };
  }

  // Check 2: Try with more aggressive normalization (remove all non-alphanumeric)
  const ultraNormalizedTitle = normalizedTitle.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  const ultraNormalizedContent = normalizedContent.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');

  if (ultraNormalizedContent.includes(ultraNormalizedTitle)) {
    return { found: true, matchType: 'normalized' };
  }

  // Check 3: Partial match - check if significant words appear together
  const significantWords = extractSignificantWords(title);

  if (significantWords.length >= 3) {
    // For longer titles, require at least 70% of significant words to match
    const matchedWords = significantWords.filter(word => ultraNormalizedContent.includes(word));
    const matchRatio = matchedWords.length / significantWords.length;

    if (matchRatio >= 0.7) {
      // Additional check: ensure words appear somewhat close together
      // Find positions of matched words in content
      const positions = matchedWords.map(word => {
        const idx = ultraNormalizedContent.indexOf(word);
        return idx;
      }).filter(idx => idx >= 0);

      if (positions.length >= 2) {
        const minPos = Math.min(...positions);
        const maxPos = Math.max(...positions);
        // Words should be within ~500 chars of each other (typical title + context)
        if (maxPos - minPos < 500) {
          return {
            found: true,
            matchType: 'partial',
            details: `Matched ${matchedWords.length}/${significantWords.length} words: ${matchedWords.slice(0, 5).join(', ')}`
          };
        }
      }
    }
  }

  // Check 4: Try matching first significant N words (handles truncated titles)
  if (significantWords.length >= 4) {
    const firstWords = significantWords.slice(0, 4).join(' ');
    if (ultraNormalizedContent.includes(firstWords)) {
      return {
        found: true,
        matchType: 'partial',
        details: `Matched first 4 significant words: "${firstWords}"`
      };
    }
  }

  return {
    found: false,
    matchType: 'not_found',
    details: `Significant words: ${significantWords.slice(0, 5).join(', ')}`
  };
}

/**
 * Find the most recent sync file.
 */
function findMostRecentSyncFile(): string | null {
  const files = fs.readdirSync(SYNCED_EMAILS_DIR)
    .filter(f => f.startsWith('sync-') && f.endsWith('.json'))
    .sort((a, b) => {
      const tsA = parseInt(a.replace('sync-', '').replace('.json', ''));
      const tsB = parseInt(b.replace('sync-', '').replace('.json', ''));
      return tsB - tsA; // Descending (most recent first)
    });

  return files.length > 0 ? path.join(SYNCED_EMAILS_DIR, files[0]) : null;
}

/**
 * Find the most recent analysis file.
 */
function findMostRecentAnalysisFile(): string | null {
  const files = fs.readdirSync(SYNCED_EMAILS_DIR)
    .filter(f => f.startsWith('analysis-') && f.endsWith('.json'))
    .sort((a, b) => {
      const tsA = parseInt(a.replace('analysis-', '').replace('.json', ''));
      const tsB = parseInt(b.replace('analysis-', '').replace('.json', ''));
      return tsB - tsA; // Descending (most recent first)
    });

  return files.length > 0 ? path.join(SYNCED_EMAILS_DIR, files[0]) : null;
}

/**
 * Find the analysis file corresponding to a sync file (by timestamp proximity).
 */
function findMatchingAnalysisFile(syncFile: string): string | null {
  const syncTs = parseInt(path.basename(syncFile).replace('sync-', '').replace('.json', ''));

  const analysisFiles = fs.readdirSync(SYNCED_EMAILS_DIR)
    .filter(f => f.startsWith('analysis-') && f.endsWith('.json'))
    .map(f => ({
      file: path.join(SYNCED_EMAILS_DIR, f),
      ts: parseInt(f.replace('analysis-', '').replace('.json', ''))
    }))
    .filter(f => f.ts >= syncTs) // Analysis should be after sync
    .sort((a, b) => a.ts - b.ts); // Ascending (closest first)

  // Return the analysis file that's closest to (but after) the sync file
  // Allow up to 1 hour difference
  if (analysisFiles.length > 0 && analysisFiles[0].ts - syncTs < 3600000) {
    return analysisFiles[0].file;
  }

  return null;
}

/**
 * Load and combine all email body content from a sync file.
 */
function loadEmailContent(syncFile: string): string {
  const data = JSON.parse(fs.readFileSync(syncFile, 'utf-8'));
  const emails: RawEmail[] = Array.isArray(data) ? data : data.emails || [];

  // Combine all email bodies, subjects, and snippets
  const content = emails.map(email => {
    return [
      email.subject || '',
      email.snippet || '',
      email.body || ''
    ].join('\n');
  }).join('\n\n');

  return content;
}

/**
 * Load papers from an analysis file.
 */
function loadPapers(analysisFile: string): Paper[] {
  const data = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
  return data.papers || [];
}

/**
 * Validate all paper titles against email content.
 */
function validatePaperTitles(
  syncFile: string,
  analysisFile: string,
  verbose: boolean = false
): ValidationReport {
  console.log(`\n📧 Loading emails from: ${path.basename(syncFile)}`);
  const emailContent = loadEmailContent(syncFile);
  console.log(`   Content size: ${(emailContent.length / 1024).toFixed(1)} KB`);

  console.log(`📄 Loading papers from: ${path.basename(analysisFile)}`);
  const papers = loadPapers(analysisFile);
  console.log(`   Total papers: ${papers.length}`);

  console.log(`\n🔍 Validating paper titles...\n`);

  const results: ValidationResult[] = [];
  let validated = 0;
  let notFound = 0;

  for (const paper of papers) {
    const { found, matchType, details } = checkTitleInContent(paper.title, emailContent);

    results.push({
      paper,
      found,
      matchType,
      matchDetails: details
    });

    if (found) {
      validated++;
      if (verbose) {
        console.log(`✅ [${matchType.toUpperCase()}] ${paper.title.substring(0, 60)}...`);
        if (details) console.log(`   ${details}`);
      }
    } else {
      notFound++;
      console.log(`❌ NOT FOUND: ${paper.title}`);
      if (details) console.log(`   ${details}`);
      console.log(`   Source: ${paper.source}, Score: ${paper.relevanceScore}`);
    }
  }

  const validationRate = papers.length > 0 ? (validated / papers.length) * 100 : 0;

  return {
    syncFile,
    analysisFile,
    totalPapers: papers.length,
    validated,
    notFound,
    validationRate,
    results
  };
}

/**
 * Print validation report summary.
 */
function printReport(report: ValidationReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('📊 VALIDATION REPORT');
  console.log('='.repeat(60));
  console.log(`Sync File:     ${path.basename(report.syncFile)}`);
  console.log(`Analysis File: ${path.basename(report.analysisFile)}`);
  console.log('');
  console.log(`Total Papers:  ${report.totalPapers}`);
  console.log(`Validated:     ${report.validated} (${report.validationRate.toFixed(1)}%)`);
  console.log(`Not Found:     ${report.notFound}`);
  console.log('');

  // Breakdown by match type
  const byMatchType = {
    exact: report.results.filter(r => r.matchType === 'exact').length,
    normalized: report.results.filter(r => r.matchType === 'normalized').length,
    partial: report.results.filter(r => r.matchType === 'partial').length,
    not_found: report.results.filter(r => r.matchType === 'not_found').length
  };

  console.log('Match Type Breakdown:');
  console.log(`  Exact match:      ${byMatchType.exact}`);
  console.log(`  Normalized match: ${byMatchType.normalized}`);
  console.log(`  Partial match:    ${byMatchType.partial}`);
  console.log(`  Not found:        ${byMatchType.not_found}`);
  console.log('');

  // List papers not found (potential hallucinations)
  if (report.notFound > 0) {
    console.log('⚠️  POTENTIAL HALLUCINATIONS (papers not found in emails):');
    console.log('-'.repeat(60));
    for (const result of report.results.filter(r => !r.found)) {
      console.log(`• ${result.paper.title}`);
      console.log(`  Authors: ${result.paper.authors.join(', ')}`);
      console.log(`  Source: ${result.paper.source}, Score: ${result.paper.relevanceScore}`);
      console.log('');
    }
  }

  // Overall assessment
  console.log('='.repeat(60));
  if (report.validationRate >= 95) {
    console.log('✅ EXCELLENT: Very high validation rate, extraction is reliable.');
  } else if (report.validationRate >= 85) {
    console.log('⚠️  GOOD: Most papers validated, some may need review.');
  } else if (report.validationRate >= 70) {
    console.log('⚠️  WARNING: Moderate validation rate, review unvalidated papers.');
  } else {
    console.log('❌ CRITICAL: Low validation rate, many potential hallucinations.');
  }
  console.log('='.repeat(60));
}

/**
 * Export function for use by other scripts (scheduler, etc.)
 */
export async function validateExtraction(
  syncFile?: string,
  analysisFile?: string
): Promise<ValidationReport> {
  const sync = syncFile || findMostRecentSyncFile();
  const analysis = analysisFile || (sync ? findMatchingAnalysisFile(sync) : null) || findMostRecentAnalysisFile();

  if (!sync) {
    throw new Error('No sync file found');
  }
  if (!analysis) {
    throw new Error('No analysis file found');
  }

  return validatePaperTitles(sync, analysis, false);
}

/**
 * Refined analysis result after removing hallucinated papers.
 */
export interface RefinedResult {
  originalCount: number;
  refinedCount: number;
  removedCount: number;
  refinedAnalysisFile: string;
  refinedReportFile: string;
  removedPapers: Paper[];
}

/**
 * Generate a markdown report for refined papers (copy-friendly format).
 */
function generateRefinedReport(papers: Paper[]): string {
  let mdContent = "# Refined Daily Paper Report\n\n";
  mdContent += `Generated: ${new Date().toLocaleString()}\n`;
  mdContent += `Total Papers: ${papers.length} (after validation)\n\n`;
  mdContent += "---\n\n";

  for (const [i, p] of papers.entries()) {
    // Simple format for easy copying
    mdContent += `${i + 1}. ${p.title}\n`;
    mdContent += `   Authors: ${p.authors ? p.authors.join(', ') : 'Unknown'}\n`;
    mdContent += `   Source: ${p.source} | Score: ${p.relevanceScore}`;
    if (p.matchedKeywords && p.matchedKeywords.length > 0) {
      mdContent += ` | Keywords: ${p.matchedKeywords.join(', ')}`;
    }
    mdContent += `\n\n`;
  }

  return mdContent;
}

/**
 * Load keywords from keywords.json
 */
function loadKeywords(): string[] {
  try {
    if (fs.existsSync(KEYWORDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf-8'));
      return data.keywords || [];
    }
  } catch (e) {
    console.warn('Failed to load keywords.json, using default keywords');
  }
  return ['research', 'study', 'analysis'];
}

/**
 * Extract top keywords from papers based on frequency
 */
function extractTopKeywords(papers: Paper[], limit: number = 10): string[] {
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
  return Array.from(keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(e => e[0]);
}

/**
 * Refine analysis by removing hallucinated papers and generate refined files.
 * Generates a literature review using Gemini AI.
 *
 * @param report - Validation report from validateExtraction
 * @param outputDir - Optional custom output directory (defaults to synced_emails for analysis, reports for markdown)
 * @returns RefinedResult with file paths and statistics
 */
export async function refineAndSave(
  report: ValidationReport,
  outputDir?: string
): Promise<RefinedResult> {
  const syncedEmailsDir = outputDir || SYNCED_EMAILS_DIR;

  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  // Filter to keep only validated papers and sort by relevance score
  const validatedResults = report.results.filter(r => r.found);
  const removedResults = report.results.filter(r => !r.found);
  const validatedPapers = validatedResults
    .map(r => r.paper)
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  const removedPapers = removedResults.map(r => r.paper);

  // Load keywords and extract top keywords from papers
  const configKeywords = loadKeywords();
  const topKeywords = extractTopKeywords(validatedPapers, 10);
  const reviewKeywords = topKeywords.length > 0 ? topKeywords : configKeywords.slice(0, 5);

  console.log(`\n📝 Top keywords: ${reviewKeywords.join(', ')}`);

  // Generate literature review using Gemini
  let generatedReview = '';
  const reviewPaperLimit = 50; // Limit papers for review generation
  const reviewPapers = validatedPapers.slice(0, reviewPaperLimit);

  console.log(`📚 Generating literature review with ${reviewPapers.length} papers...`);

  try {
    let review = await generateLiteratureReviewLightweight(reviewPapers, reviewKeywords);

    // Append reference list
    let references = "\n\n---\n\n## References / 参考文献\n\n";
    for (const [i, p] of reviewPapers.entries()) {
      const authorStr = p.authors ? p.authors.join(", ") : "Unknown";
      references += `[${i + 1}] ${authorStr}. "${p.title}". ${p.source || 'Unknown Source'}${p.date ? `, ${p.date}` : ''}.\n\n`;
    }
    review += references;
    generatedReview = review;
    console.log(`✅ Literature review generated successfully`);
  } catch (e) {
    console.error(`❌ Failed to generate literature review:`, e);
    generatedReview = `# Literature Review\n\nFailed to generate review. Error: ${e}\n\n## Paper List\n\n${generateRefinedReport(validatedPapers)}`;
  }

  // Build categorized papers by keyword
  const categorizedPapers: { keyword: string; paperIds: string[] }[] = [];
  const keywordMap = new Map<string, string[]>();
  for (const p of validatedPapers) {
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

  // Generate filenames with timestamp (use standard naming for web app compatibility)
  const timestamp = Date.now();
  const refinedAnalysisFilename = `analysis-${timestamp}.json`;
  const refinedReviewFilename = `daily_review_refined_${timestamp}.md`;
  const refinedPapersFilename = `daily_papers_refined_${timestamp}.md`;

  // Create refined analysis with full summary structure (like scheduler output)
  const refinedAnalysis = {
    papers: validatedPapers,
    summary: {
      overview: `Refined analysis: ${validatedPapers.length} validated papers (removed ${removedPapers.length} unvalidated). Generated on ${new Date().toLocaleDateString()}. Top keywords: ${reviewKeywords.slice(0, 5).join(', ')}.`,
      keyTrends: reviewKeywords.slice(0, 5).map(kw => `Research on ${kw}`),
      topRecommendations: validatedPapers.slice(0, 5).map(p => p.title),
      categorizedPapers: categorizedPapers,
      academicReport: generatedReview
    },
    validation: {
      originalCount: report.totalPapers,
      refinedCount: validatedPapers.length,
      removedCount: removedPapers.length,
      validationRate: report.validationRate,
      removedPapers: removedPapers.map(p => ({
        title: p.title,
        authors: p.authors,
        source: p.source
      }))
    }
  };

  // Save refined analysis
  const refinedAnalysisPath = path.join(syncedEmailsDir, refinedAnalysisFilename);
  fs.writeFileSync(refinedAnalysisPath, JSON.stringify(refinedAnalysis, null, 2));

  // Save literature review
  const refinedReviewPath = path.join(REPORTS_DIR, refinedReviewFilename);
  fs.writeFileSync(refinedReviewPath, generatedReview);

  // Save paper list (simple format for quick reference)
  const paperListReport = generateRefinedReport(validatedPapers);
  const refinedPapersPath = path.join(REPORTS_DIR, refinedPapersFilename);
  fs.writeFileSync(refinedPapersPath, paperListReport);

  console.log(`\n✨ REFINED OUTPUT:`);
  console.log(`   Analysis:    ${refinedAnalysisFilename}`);
  console.log(`   Review:      ${refinedReviewFilename}`);
  console.log(`   Paper List:  ${refinedPapersFilename}`);
  console.log(`   Papers:      ${validatedPapers.length} kept, ${removedPapers.length} removed`);

  return {
    originalCount: report.totalPapers,
    refinedCount: validatedPapers.length,
    removedCount: removedPapers.length,
    refinedAnalysisFile: refinedAnalysisPath,
    refinedReportFile: refinedReviewPath,
    removedPapers
  };
}

/**
 * Validate and refine in one step - convenience function for scheduler.
 * Returns both validation report and refined result.
 */
export async function validateAndRefine(
  syncFile?: string,
  analysisFile?: string
): Promise<{ validation: ValidationReport; refined: RefinedResult }> {
  const validation = await validateExtraction(syncFile, analysisFile);
  const refined = await refineAndSave(validation);
  return { validation, refined };
}

/**
 * Main CLI entry point.
 */
async function main() {
  const args = process.argv.slice(2);

  let syncFile: string | null = null;
  let analysisFile: string | null = null;
  let verbose = false;
  let refine = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sync' && args[i + 1]) {
      syncFile = args[++i];
      if (!path.isAbsolute(syncFile)) {
        syncFile = path.join(SYNCED_EMAILS_DIR, syncFile);
      }
    } else if (args[i] === '--analysis' && args[i + 1]) {
      analysisFile = args[++i];
      if (!path.isAbsolute(analysisFile)) {
        analysisFile = path.join(SYNCED_EMAILS_DIR, analysisFile);
      }
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--refine' || args[i] === '-r') {
      refine = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Paper Title Validation Script

Validates that extracted paper titles exist in the original synced emails.
Helps detect potential AI hallucinations.

Usage:
  npx tsx scripts/validatePaperTitles.ts [options]

Options:
  --sync <file>      Specify sync file (default: most recent)
  --analysis <file>  Specify analysis file (default: matching or most recent)
  --verbose, -v      Show all validation results, not just failures
  --refine, -r       Generate refined analysis and report files (remove hallucinations)
  --help, -h         Show this help message

Examples:
  npx tsx scripts/validatePaperTitles.ts
  npx tsx scripts/validatePaperTitles.ts --refine
  npx tsx scripts/validatePaperTitles.ts --sync sync-1768404401227.json --refine
  npx tsx scripts/validatePaperTitles.ts --verbose
      `);
      process.exit(0);
    }
  }

  // Find files if not specified
  if (!syncFile) {
    syncFile = findMostRecentSyncFile();
    if (!syncFile) {
      console.error('❌ No sync files found in synced_emails directory');
      process.exit(1);
    }
  }

  if (!analysisFile) {
    // Try to find matching analysis file first
    analysisFile = findMatchingAnalysisFile(syncFile);
    if (!analysisFile) {
      analysisFile = findMostRecentAnalysisFile();
    }
    if (!analysisFile) {
      console.error('❌ No analysis files found in synced_emails directory');
      process.exit(1);
    }
  }

  // Validate files exist
  if (!fs.existsSync(syncFile)) {
    console.error(`❌ Sync file not found: ${syncFile}`);
    process.exit(1);
  }
  if (!fs.existsSync(analysisFile)) {
    console.error(`❌ Analysis file not found: ${analysisFile}`);
    process.exit(1);
  }

  console.log('🔬 Paper Title Validation');
  console.log('='.repeat(60));

  const report = validatePaperTitles(syncFile, analysisFile, verbose);
  printReport(report);

  // If refine flag is set and there are hallucinations, generate refined files
  if (refine) {
    if (report.notFound > 0) {
      console.log('\n🔧 Generating refined files (removing hallucinations)...');
      const result = await refineAndSave(report);
      console.log(`\n📁 Refined files created:`);
      console.log(`   synced_emails/${path.basename(result.refinedAnalysisFile)}`);
      console.log(`   reports/${path.basename(result.refinedReportFile)}`);
    } else {
      console.log('\n✅ No hallucinations detected, no refinement needed.');
    }
  }

  // Exit with error code if validation rate is too low
  if (report.validationRate < 70) {
    process.exit(1);
  }
}

// Run if called directly (not when imported as a module)
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
