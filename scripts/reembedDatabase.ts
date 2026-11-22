import './loadEnv.ts';
import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import { GEMINI_EMBEDDING_MODEL } from '../services/geminiModels.ts';
import {
  generateEmbedding,
  generateBatchEmbeddings,
  readEmbeddingMetadata,
  writeEmbeddingMetadata,
  normalizeDateString,
} from '../services/vectorService.ts';

const VECTOR_DB_PATH = path.resolve(process.cwd(), 'data/vector_db');
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!process.env.VITE_GEMINI_API_KEY) {
    console.error('❌ Missing VITE_GEMINI_API_KEY in .env.local or environment.');
    process.exit(1);
  }

  const currentMeta = readEmbeddingMetadata();
  console.log('🔄 ScholarPulse Vector Database Re-embedding Tool');
  console.log(`   Target embedding model: ${GEMINI_EMBEDDING_MODEL}`);
  if (currentMeta) {
    console.log(`   Existing index metadata: ${currentMeta.model} (${currentMeta.dimensions}-dim)`);
  }
  if (dryRun) {
    console.log('   Mode: DRY RUN (no database changes will be written)\n');
  } else {
    console.log('');
  }

  // Probe the target embedding model first to verify it works and capture its exact vector dimension
  console.log(`🧪 Probing "${GEMINI_EMBEDDING_MODEL}"...`);
  const probeVector = await generateEmbedding('ScholarPulse embedding dimension probe');
  const targetDimensions = probeVector.length;
  console.log(`✅ Probe succeeded! Output dimensions: ${targetDimensions}\n`);

  const db = await lancedb.connect(VECTOR_DB_PATH);
  const tableNames = await db.tableNames();
  if (!tableNames.includes('papers')) {
    console.log('ℹ️  Table "papers" does not exist yet. Writing embedding metadata only.');
    if (!dryRun) {
      writeEmbeddingMetadata({
        model: GEMINI_EMBEDDING_MODEL,
        dimensions: targetDimensions,
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  const table = await db.openTable('papers');
  // Load metadata columns only (skip old vectors to keep RAM low)
  const allRows = await table
    .query()
    .select([
      'id',
      'title',
      'authors',
      'snippet',
      'link',
      'source',
      'date',
      'relevanceScore',
      'matchedKeywords',
      'indexedAt',
    ])
    .toArray();

  const validPapers = allRows.filter(r => r.id !== 'schema-definition');
  console.log(`📚 Loaded ${validPapers.length} papers to re-embed.`);

  if (dryRun) {
    const estBatches = Math.ceil(validPapers.length / BATCH_SIZE);
    console.log(`📋 Dry run complete: would process ${estBatches} batches (${BATCH_SIZE}/batch) with ${GEMINI_EMBEDDING_MODEL} (${targetDimensions}-dim).`);
    return;
  }

  const reembeddedRecords: any[] = [
    {
      id: 'schema-definition',
      title: 'Schema Definition',
      authors: ['Author Name'],
      snippet: 'Schema Snippet',
      link: 'https://example.com',
      source: 'Schema Source',
      date: '2026-01-01',
      relevanceScore: 0,
      matchedKeywords: ['keyword'],
      vector: new Array(targetDimensions).fill(0),
      indexedAt: new Date().toISOString(),
    },
  ];

  const totalBatches = Math.ceil(validPapers.length / BATCH_SIZE);
  let failedCount = 0;

  for (let i = 0; i < validPapers.length; i += BATCH_SIZE) {
    const batch = validPapers.slice(i, i + BATCH_SIZE);
    const texts = batch.map(p => `Title: ${p.title}\nSource: ${p.source}\nAbstract: ${p.snippet || ''}`);

    try {
      const embeddings = await generateBatchEmbeddings(texts);
      batch.forEach((row, idx) => {
        const indexedAt = row.indexedAt || new Date().toISOString();
        reembeddedRecords.push({
          id: String(row.id),
          title: String(row.title),
          authors: Array.isArray(row.authors) ? row.authors : Array.from(row.authors || []),
          snippet: String(row.snippet || ''),
          link: String(row.link || ''),
          source: String(row.source || 'Unknown'),
          date: normalizeDateString(row.date, indexedAt),
          relevanceScore: typeof row.relevanceScore === 'number' ? row.relevanceScore : 0,
          matchedKeywords: Array.isArray(row.matchedKeywords)
            ? row.matchedKeywords
            : Array.from(row.matchedKeywords || []),
          vector: embeddings[idx],
          indexedAt,
        });
      });

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        console.log(`   Progress: ${batchNum}/${totalBatches} batches (${reembeddedRecords.length - 1}/${validPapers.length} papers)`);
      }

      if (i + BATCH_SIZE < validPapers.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    } catch (error) {
      failedCount += batch.length;
      console.error(`❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, error);
    }
  }

  if (failedCount > 0) {
    console.error(`\n❌ Aborting overwrite because ${failedCount} papers failed to re-embed. Existing database left untouched.`);
    process.exit(1);
  }

  console.log('\n💾 Writing rebuilt vector table to LanceDB...');
  const newTable = await db.createTable('papers', reembeddedRecords, { mode: 'overwrite' });
  await newTable.optimize({ cleanupOlderThan: new Date() });

  writeEmbeddingMetadata({
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: targetDimensions,
    updatedAt: new Date().toISOString(),
  });

  console.log(`🎉 Re-embedded ${validPapers.length} papers with "${GEMINI_EMBEDDING_MODEL}" (${targetDimensions}-dim) and updated data/embedding_meta.json!`);
}

main().catch((err) => {
  console.error('❌ Re-embed failed:', err?.message || err);
  process.exit(1);
});
