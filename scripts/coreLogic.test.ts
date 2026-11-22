import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeDateString, normalizeTitleForDedup } from '../services/vectorService.ts';
import { getSourceMultiplier, calculateKeywordBonus, deduplicatePapers } from '../services/geminiService.ts';
import { buildGmailAlertQuery, ACADEMIC_ALERT_SENDERS } from '../services/emailSources.ts';
import { extractArticlesFromEmail } from '../services/emailArticleExtractor.ts';
import { resolveSafeFilePath, escapeHtml } from '../utils/security.ts';
import type { Paper } from '../types.ts';

test('normalizeDateString handles ISO, human-readable, year-only, and invalid values', () => {
  assert.equal(normalizeDateString('2026-07-03', '2026-11-22T00:00:00Z'), '2026-07-03');
  assert.equal(normalizeDateString('2025', '2026-11-22T00:00:00Z'), '2025-01-01');
  assert.equal(normalizeDateString('December 2025', '2026-11-22T00:00:00Z'), '2025-12-01');
  assert.equal(normalizeDateString('13 January 2026', '2026-11-22T00:00:00Z'), '2026-01-13');
  assert.equal(normalizeDateString('not specified', '2026-11-22T00:00:00Z'), '2026-11-22');
  assert.equal(normalizeDateString(undefined, '2026-11-22T00:00:00Z'), '2026-11-22');
});

test('normalizeTitleForDedup normalizes case, punctuation, and whitespace', () => {
  assert.equal(
    normalizeTitleForDedup('  Single-Cell Proteomics: Aortic Organoids!  '),
    normalizeTitleForDedup('singlecell proteomics aortic organoids')
  );
});

test('getSourceMultiplier distinguishes flagship, subsidiary, preprint, and low-tier journals', () => {
  assert.equal(getSourceMultiplier('Nature'), 1.5);
  assert.equal(getSourceMultiplier('Nature Medicine'), 1.3);
  assert.equal(getSourceMultiplier('Cell Reports Methods'), 1.2);
  assert.equal(getSourceMultiplier('European Heart Journal'), 1.3);
  assert.equal(getSourceMultiplier('Blood'), 1.3);
  assert.equal(getSourceMultiplier('bioRxiv'), 0.6);
  assert.equal(getSourceMultiplier('Frontiers in Cardiovascular Medicine'), 0.5);
  assert.equal(getSourceMultiplier('Random Unknown Blog'), 0.2);
});

test('calculateKeywordBonus awards bonuses and applies penalty keywords accurately', () => {
  const positive = calculateKeywordBonus(
    'Single-cell proteomics of aortic organoids',
    'We study Marfan Syndrome in human vascular tissue.',
    ['single-cell proteomics', 'organoid', 'Marfan Syndrome'],
    ['cancer', 'tumor']
  );
  assert.ok(positive.bonus >= 50, `Expected bonus >= 50, got ${positive.bonus}`);
  assert.deepEqual(positive.matchedPenalties, []);
  assert.ok(positive.matchedKeywords.includes('Marfan Syndrome'));

  const penalized = calculateKeywordBonus(
    'Tumor microenvironment in lung cancer',
    'Cancer metastasis study',
    ['organoid'],
    ['cancer', 'tumor']
  );
  assert.ok(penalized.bonus <= -50, `Expected strong negative bonus, got ${penalized.bonus}`);
  assert.ok(penalized.matchedPenalties.includes('cancer'));
  assert.ok(penalized.matchedPenalties.includes('tumor'));
});

test('deduplicatePapers keeps highest-scoring paper per normalized title', () => {
  const base: Omit<Paper, 'id' | 'relevanceScore' | 'source'> = {
    title: 'Single-cell transcriptomics of human aorta',
    authors: ['Alice Smith'],
    snippet: 'Detailed vascular atlas.',
    link: 'https://doi.org/10.1000/test',
    date: '2026-11-20',
    matchedKeywords: ['aorta'],
  };
  const deduped = deduplicatePapers([
    { ...base, id: '1', source: 'Google Scholar', relevanceScore: 45 },
    { ...base, id: '2', title: 'Single-cell transcriptomics of human aorta!', source: 'Nature', relevanceScore: 92 },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, '2');
  assert.equal(deduped[0].relevanceScore, 92);
});

test('buildGmailAlertQuery includes all canonical academic senders including EHJ and Blood', () => {
  const query = buildGmailAlertQuery(1700000000);
  for (const sender of ACADEMIC_ALERT_SENDERS) {
    assert.ok(query.includes(`from:${sender}`), `Query should include ${sender}`);
  }
  assert.ok(query.includes('from:etoc@oup.com'));
  assert.ok(query.includes('from:blood@hematology.org'));
  assert.ok(query.endsWith('after:1700000000'));
});

test('extractArticlesFromEmail parses Google Scholar alert HTML cleanly', () => {
  const html = `
    <html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/1">Single-<b>cell</b> proteomics reveals aortic remodeling</a></h3>
      <div style="color:#006621">A Smith, B Chen - Nature Medicine, 2026</div>
      <div class="gse_alrt_sni">We profile vascular smooth muscle cells in Marfan Syndrome.</div>
    </body></html>
  `;
  const articles = extractArticlesFromEmail(html, 'scholaralerts-noreply@google.com', 'Google Scholar Alert');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'Single-cell proteomics reveals aortic remodeling');
  assert.equal(articles[0].journal, 'Nature Medicine');
  assert.equal(articles[0].authors, 'A Smith, B Chen');
});

test('resolveSafeFilePath blocks path traversal and escapeHtml prevents XSS', () => {
  const baseDir = '/tmp/scholarpulse-safe-base';
  assert.equal(
    resolveSafeFilePath(baseDir, 'daily_review_2026-11-22.md'),
    path.resolve(baseDir, 'daily_review_2026-11-22.md')
  );
  assert.equal(resolveSafeFilePath(baseDir, '../.env.local'), null);
  assert.equal(resolveSafeFilePath(baseDir, 'sub/file.json'), null);
  assert.equal(resolveSafeFilePath(baseDir, '..\\secret.txt'), null);
  assert.equal(resolveSafeFilePath(baseDir, 'bad\0name.json'), null);
  assert.equal(resolveSafeFilePath(baseDir, ''), null);

  assert.equal(
    escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  );
});
