/**
 * Test the hybrid ArticleExtractor + processScholarEmails approach
 */
import fs from 'fs';
import { extractArticlesFromEmail } from '../services/emailArticleExtractor.js';

// Load test emails
const data = JSON.parse(fs.readFileSync('./debug/test.json', 'utf-8'));

console.log('='.repeat(80));
console.log('TESTING HYBRID APPROACH: ArticleExtractor in processScholarEmails()');
console.log('='.repeat(80));

// Simulate what processScholarEmails now does
let totalArticles = 0;
let totalRawSize = 0;
let totalStructuredSize = 0;

for (let i = 0; i < data.length; i++) {
  const email = data[i];
  const fromLine = email.from || '';
  const subjectLine = email.subject || '';
  const emailBody = email.body || '';

  const rawSize = emailBody.length;
  totalRawSize += rawSize;

  // Extract articles using cheerio
  const articles = extractArticlesFromEmail(emailBody, fromLine, subjectLine);
  totalArticles += articles.length;

  // Build structured content (same as processScholarEmails now does)
  const structuredContent = articles.map((article, idx) => {
    let articleBlock = `--- ARTICLE ${idx + 1} ---\n`;
    articleBlock += `TITLE: ${article.title}\n`;
    articleBlock += `SOURCE: ${article.journal}\n`;
    if (article.authors) articleBlock += `AUTHORS: ${article.authors}\n`;
    if (article.abstract) articleBlock += `ABSTRACT: ${article.abstract}\n`;
    if (article.doi) articleBlock += `DOI: ${article.doi}\n`;
    return articleBlock;
  }).join('\n\n');

  totalStructuredSize += structuredContent.length;

  console.log(`\n📧 EMAIL ${i + 1}/${data.length}`);
  console.log(`   From: ${fromLine.substring(0, 50)}`);
  console.log(`   Articles: ${articles.length}`);
  console.log(`   Raw size: ${(rawSize / 1024).toFixed(1)} KB`);
  console.log(`   Structured size: ${(structuredContent.length / 1024).toFixed(1)} KB`);
  console.log(`   Reduction: ${((1 - structuredContent.length / rawSize) * 100).toFixed(0)}%`);

  // Show first 2 article titles
  if (articles.length > 0) {
    console.log(`   Sample titles:`);
    for (let j = 0; j < Math.min(2, articles.length); j++) {
      console.log(`     - ${articles[j].title.substring(0, 70)}...`);
    }
  }
}

console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Total emails: ${data.length}`);
console.log(`Total articles extracted: ${totalArticles}`);
console.log(`Total raw size: ${(totalRawSize / 1024).toFixed(1)} KB`);
console.log(`Total structured size: ${(totalStructuredSize / 1024).toFixed(1)} KB`);
console.log(`Overall reduction: ${((1 - totalStructuredSize / totalRawSize) * 100).toFixed(0)}%`);
console.log(`Estimated tokens saved: ~${Math.round((totalRawSize - totalStructuredSize) / 4)}`);
console.log('='.repeat(80));
