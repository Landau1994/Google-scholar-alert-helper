
import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.ts';
import { indexPapers } from '../services/vectorService.ts';
import type { Paper } from '../types.ts';

const SYNCED_EMAILS_DIR = path.resolve(process.cwd(), 'synced_emails');

async function migrate() {
  logger.info("Starting historical data migration to vector database...");

  if (!fs.existsSync(SYNCED_EMAILS_DIR)) {
    logger.error("synced_emails directory not found.");
    return;
  }

  const files = fs.readdirSync(SYNCED_EMAILS_DIR)
    .filter(f => f.startsWith('analysis-') && f.endsWith('.json'));

  logger.info(`Found ${files.length} analysis files to process.`);

  let totalPapers = 0;
  const allPapers: Paper[] = [];
  const seenTitles = new Set<string>();

  for (const file of files) {
    try {
      const filePath = path.join(SYNCED_EMAILS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      if (data.papers && Array.isArray(data.papers)) {
        for (const paper of data.papers) {
          // Basic deduplication during migration
          const normalizedTitle = paper.title.toLowerCase().trim();
          if (!seenTitles.has(normalizedTitle)) {
            allPapers.push(paper);
            seenTitles.add(normalizedTitle);
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to parse ${file}:`, error);
    }
  }

  logger.info(`Extracted ${allPapers.length} unique papers from historical files.`);

  // Index in batches
  const MIGRATION_BATCH_SIZE = 100;
  for (let i = 0; i < allPapers.length; i += MIGRATION_BATCH_SIZE) {
    const batch = allPapers.slice(i, i + MIGRATION_BATCH_SIZE);
    logger.info(`Indexing migration batch ${Math.floor(i / MIGRATION_BATCH_SIZE) + 1}/${Math.ceil(allPapers.length / MIGRATION_BATCH_SIZE)}...`);
    await indexPapers(batch);
  }

  logger.success("Historical data migration complete!");
}

migrate().catch(err => {
  logger.error("Migration failed:", err);
  process.exit(1);
});
