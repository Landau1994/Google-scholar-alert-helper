/**
 * Debug Extraction Script
 *
 * Inspects how articles are being extracted from emails without calling the AI.
 * Useful for debugging extraction logic and seeing what content is sent to the AI.
 *
 * Usage:
 *   npx tsx scripts/debugExtraction.ts --sync-file=./debug/test.json [--email=0] [--save-chunks]
 *
 * Options:
 *   --sync-file: Path to synced emails JSON file
 *   --email: Index of email to inspect (default: all)
 *   --save-chunks: Save extracted chunks to debug/ folder
 */

import fs from 'fs';
import path from 'path';
import { extractArticlesFromEmail } from '../services/emailArticleExtractor.js';

interface RawEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

// Parse command line arguments
const args = process.argv.slice(2);
const syncFileArg = args.find(a => a.startsWith('--sync-file='));
const emailIndexArg = args.find(a => a.startsWith('--email='));
const saveChunks = args.includes('--save-chunks');

if (!syncFileArg) {
  console.error('Usage: npx tsx scripts/debugExtraction.ts --sync-file=<path> [--email=<index>] [--save-chunks]');
  process.exit(1);
}

const syncFilePath = path.resolve(process.cwd(), syncFileArg.split('=')[1]);
const emailIndex = emailIndexArg ? parseInt(emailIndexArg.split('=')[1]) : null;

console.log(`\n📧 Loading emails from: ${path.basename(syncFilePath)}`);

// Load emails
const rawEmails: RawEmail[] = JSON.parse(fs.readFileSync(syncFilePath, 'utf-8'));
console.log(`   Found ${rawEmails.length} emails\n`);

// Filter to specific email if requested
const emailsToProcess = emailIndex !== null ? [rawEmails[emailIndex]] : rawEmails;

if (emailIndex !== null && !rawEmails[emailIndex]) {
  console.error(`❌ Email index ${emailIndex} not found (only ${rawEmails.length} emails available)`);
  process.exit(1);
}

// Process each email
for (let i = 0; i < emailsToProcess.length; i++) {
  const email = emailsToProcess[i];
  const actualIndex = emailIndex !== null ? emailIndex : i;

  console.log(`${'='.repeat(80)}`);
  console.log(`📨 EMAIL ${actualIndex + 1}/${rawEmails.length}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`From:    ${email.from}`);
  console.log(`Subject: ${email.subject}`);
  console.log(`Date:    ${email.date}`);
  console.log(`Size:    ${(email.body.length / 1024).toFixed(1)} KB`);
  console.log();

  // Extract articles
  console.log(`🔍 Extracting articles...`);
  const startTime = Date.now();

  try {
    const articles = extractArticlesFromEmail(email.body, email.from, email.subject);
    const elapsed = Date.now() - startTime;

    console.log(`✅ Extracted ${articles.length} articles in ${elapsed}ms\n`);

    // Display article summaries
    for (let j = 0; j < articles.length; j++) {
      const article = articles[j];
      console.log(`   ${j + 1}. ${article.title.substring(0, 80)}${article.title.length > 80 ? '...' : ''}`);
      console.log(`      Journal: ${article.journal}`);
      console.log(`      Size: ${article.estimatedTokens} tokens (${article.htmlContent.length} chars)`);
      if (article.authors) {
        console.log(`      Authors: ${article.authors.substring(0, 60)}...`);
      }
      if (article.abstract) {
        console.log(`      Abstract: ${article.abstract.substring(0, 100)}...`);
      }
      if (article.doi) {
        console.log(`      DOI: ${article.doi}`);
      }
      console.log();
    }

    // Save chunks if requested
    if (saveChunks && articles.length > 0) {
      const debugDir = path.resolve(process.cwd(), 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const timestamp = Date.now();
      const safeFrom = email.from.replace(/[<>@\s]/g, '_').substring(0, 30);
      const filename = `extracted_${safeFrom}_${timestamp}.json`;
      const filepath = path.join(debugDir, filename);

      const debugData = {
        email: {
          from: email.from,
          subject: email.subject,
          date: email.date,
          bodyLength: email.body.length
        },
        articles: articles.map(a => ({
          title: a.title,
          journal: a.journal,
          authors: a.authors,
          abstract: a.abstract,
          doi: a.doi,
          estimatedTokens: a.estimatedTokens,
          htmlContentLength: a.htmlContent.length,
          htmlContent: a.htmlContent.substring(0, 2000) // Save first 2000 chars
        })),
        extractedAt: new Date().toISOString()
      };

      fs.writeFileSync(filepath, JSON.stringify(debugData, null, 2));
      console.log(`💾 Saved extraction details to: ${filename}\n`);
    }

    // Show sample content that would be sent to AI
    if (articles.length > 0) {
      console.log(`📝 Sample content for first article (sent to AI):`);
      console.log(`${'─'.repeat(80)}`);
      const sample = articles[0].htmlContent.substring(0, 500);
      // Remove HTML tags for readability
      const plainText = sample.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(plainText.substring(0, 400) + '...');
      console.log(`${'─'.repeat(80)}\n`);
    }

  } catch (error: any) {
    console.error(`❌ Extraction failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

// Summary
console.log(`\n${'='.repeat(80)}`);
console.log(`📊 SUMMARY`);
console.log(`${'='.repeat(80)}`);
console.log(`Total emails processed: ${emailsToProcess.length}`);
console.log(`\n✨ Extraction complete!`);
console.log(`\nTip: Use --save-chunks to save extraction details for inspection`);
console.log(`Tip: Use --email=0 to inspect only the first email\n`);
