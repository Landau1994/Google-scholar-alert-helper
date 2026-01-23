/**
 * Debug Comparison Script
 *
 * Compares extracted article titles with what's actually in the email.
 * Helps identify title mismatches and potential AI hallucinations.
 *
 * Usage:
 *   npx tsx scripts/debugTitleComparison.ts --sync-file=<path> --analysis-file=<path>
 */

import fs from 'fs';
import path from 'path';

interface Paper {
  id: string;
  title: string;
  authors: string[];
  source: string;
  relevanceScore: number;
}

interface RawEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
}

// Normalize text for comparison
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract significant words
function extractKeywords(title: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
  return normalizeText(title)
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

// Parse args
const args = process.argv.slice(2);
const syncFileArg = args.find(a => a.startsWith('--sync-file='));
const analysisFileArg = args.find(a => a.startsWith('--analysis-file='));

if (!syncFileArg || !analysisFileArg) {
  console.error('Usage: npx tsx scripts/debugTitleComparison.ts --sync-file=<path> --analysis-file=<path>');
  process.exit(1);
}

const syncPath = path.resolve(process.cwd(), syncFileArg.split('=')[1]);
const analysisPath = path.resolve(process.cwd(), analysisFileArg.split('=')[1]);

console.log(`\n📧 Loading emails from: ${path.basename(syncPath)}`);
console.log(`📄 Loading analysis from: ${path.basename(analysisPath)}\n`);

// Load data
const emails: RawEmail[] = JSON.parse(fs.readFileSync(syncPath, 'utf-8'));
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
const papers: Paper[] = analysis.papers || [];

console.log(`Found ${emails.length} emails and ${papers.length} extracted papers\n`);

// Combine all email content
const allEmailContent = emails.map(e => normalizeText(e.body)).join(' ');

// Check each paper
let exactMatches = 0;
let partialMatches = 0;
let noMatches = 0;

console.log(`${'='.repeat(100)}`);
console.log(`TITLE COMPARISON`);
console.log(`${'='.repeat(100)}\n`);

for (let i = 0; i < papers.length; i++) {
  const paper = papers[i];
  const normalizedTitle = normalizeText(paper.title);

  console.log(`${i + 1}. ${paper.title}`);
  console.log(`   Source: ${paper.source} | Score: ${paper.relevanceScore}`);

  // Check exact match
  if (allEmailContent.includes(normalizedTitle)) {
    console.log(`   ✅ EXACT MATCH found in emails`);
    exactMatches++;
  } else {
    // Check partial match
    const keywords = extractKeywords(paper.title);
    const matchedKeywords = keywords.filter(kw => allEmailContent.includes(kw));
    const matchRatio = matchedKeywords.length / Math.max(keywords.length, 1);

    if (matchRatio >= 0.7) {
      console.log(`   ⚠️  PARTIAL MATCH (${matchRatio.toFixed(0)}%): ${matchedKeywords.slice(0, 5).join(', ')}`);
      partialMatches++;
    } else {
      console.log(`   ❌ NO MATCH - Keywords: ${keywords.slice(0, 5).join(', ')}`);
      console.log(`      Matched: ${matchedKeywords.slice(0, 5).join(', ')}`);

      // Try to find similar content
      const firstWord = keywords[0];
      if (firstWord && allEmailContent.includes(firstWord)) {
        const idx = allEmailContent.indexOf(firstWord);
        const context = allEmailContent.substring(Math.max(0, idx - 50), idx + 150);
        console.log(`      Context with "${firstWord}": ${context.substring(0, 100)}...`);
      }

      noMatches++;
    }
  }
  console.log();
}

// Summary
console.log(`${'='.repeat(100)}`);
console.log(`SUMMARY`);
console.log(`${'='.repeat(100)}`);
console.log(`Total papers: ${papers.length}`);
console.log(`✅ Exact matches: ${exactMatches} (${(exactMatches/papers.length*100).toFixed(1)}%)`);
console.log(`⚠️  Partial matches: ${partialMatches} (${(partialMatches/papers.length*100).toFixed(1)}%)`);
console.log(`❌ No matches (possible hallucinations): ${noMatches} (${(noMatches/papers.length*100).toFixed(1)}%)`);
console.log();

if (noMatches > 0) {
  console.log(`⚠️  Warning: ${noMatches} papers may be hallucinated or have incorrect titles`);
  console.log(`   Review the "NO MATCH" entries above for potential issues\n`);
}
