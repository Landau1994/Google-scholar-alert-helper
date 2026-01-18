#!/usr/bin/env npx tsx
/**
 * Test script to check why a specific paper is not being extracted
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load test.json
const testData = JSON.parse(readFileSync(join(__dirname, 'test.json'), 'utf-8'));

// Find AHA Journals emails
const ahaEmails = testData.filter((email: any) =>
  (email.from || '').toLowerCase().includes('ahajournals') ||
  (email.from || '').toLowerCase().includes('heart.org')
);

console.log(`Found ${ahaEmails.length} AHA Journals emails\n`);

// Target paper title
const targetPaper = "1-Phosphatidylinositol 3-Phosphate 5-Kinase Inhibition by Apilimod";

for (const email of ahaEmails) {
  console.log(`\n=== Email ID: ${email.id} ===`);
  console.log(`Subject: ${email.subject}`);
  console.log(`From: ${email.from}`);

  const body = email.body || '';

  // Test the AHA pattern from scheduler.ts (FIXED version)
  const ahaPattern = /<a[^>]*style="[^"]*font-size:18px;font-weight:bold[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  const paperTitles: { title: string; index: number }[] = [];

  while ((match = ahaPattern.exec(body)) !== null) {
    const title = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title.length > 20) {
      paperTitles.push({ title, index: match.index });
    }
  }

  console.log(`Pattern matched ${paperTitles.length} papers:`);
  for (const p of paperTitles) {
    const isTarget = p.title.includes('Apilimod') || p.title.includes('1-Phosphatidylinositol');
    console.log(`  ${isTarget ? '✅' : '-'} ${p.title.substring(0, 80)}...`);
  }

  // Check for target paper specifically
  if (body.includes('Apilimod')) {
    const foundTarget = paperTitles.some(p =>
      p.title.includes('Apilimod') || p.title.includes('1-Phosphatidylinositol')
    );
    console.log(foundTarget ? `\n✅ Target paper "Apilimod" was extracted!` : `\n❌ Target paper "Apilimod" NOT found!`);
  }
}
