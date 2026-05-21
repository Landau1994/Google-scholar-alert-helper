
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as lancedb from "@lancedb/lancedb";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.ts";
import type { Paper } from "../types.ts";

// Initialize Gemini API for Embeddings
const getApiKey = () => {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_GEMINI_API_KEY) {
    return process.env.VITE_GEMINI_API_KEY;
  }
  return '';
};

const apiKey = getApiKey();
const genAI = new GoogleGenerativeAI(apiKey);

// Using the latest embedding model
const EMBEDDING_MODEL = "gemini-embedding-2"; // Fallback to 004 if 2 is too new for SDK
const VECTOR_DB_PATH = path.resolve(process.cwd(), "data/vector_db");

/**
 * Execute an action with retry logic
 */
const executeWithRetry = async <T>(
  action: () => Promise<T>,
  taskName: string,
  maxRetries: number = 3
): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await action();
    } catch (error: any) {
      lastError = error;
      const errorMsg = error?.message || error?.toString() || "";
      const isRateLimit = errorMsg.includes("429") || errorMsg.toLowerCase().includes("rate limit") || errorMsg.toLowerCase().includes("quota");
      
      if (attempt < maxRetries) {
        const waitTime = isRateLimit ? Math.min(1000 * Math.pow(2, attempt + 1), 30000) : 2000 * attempt;
        logger.warn(`${taskName} failed (attempt ${attempt}/${maxRetries}): ${errorMsg}. Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError;
};

/**
 * Generate embeddings for a given text using Gemini
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  return await executeWithRetry(async () => {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }, "Generate embedding");
};

/**
 * Generate embeddings for a batch of texts
 */
export const generateBatchEmbeddings = async (texts: string[]): Promise<number[][]> => {
  try {
    return await executeWithRetry(async () => {
      const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
      const result = await model.batchEmbedContents({
        requests: texts.map(t => ({ content: { role: 'user', parts: [{ text: t }] } }))
      });
      return result.embeddings.map(e => e.values);
    }, "Generate batch embeddings");
  } catch (error) {
    logger.error(`Batch embedding failed after retries, falling back to sequential:`, error);
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await generateEmbedding(text));
    }
    return results;
  }
};

/**
 * Interface for the data stored in LanceDB
 */
export interface VectorPaper extends Paper {
  vector: number[];
  indexedAt: string;
}

/**
 * Initialize or connect to the LanceDB table
 */
const getTable = async () => {
  if (!fs.existsSync(path.dirname(VECTOR_DB_PATH))) {
    fs.mkdirSync(path.dirname(VECTOR_DB_PATH), { recursive: true });
  }
  
  const db = await lancedb.connect(VECTOR_DB_PATH);
  const tableNames = await db.tableNames();
  
  if (tableNames.includes("papers")) {
    return await db.openTable("papers");
  } else {
    // Create initial table with a dummy record to define schema
    // 768 is the dimension for gemini-embedding-2
    const dummyVector = new Array(3072).fill(0);
    return await db.createTable("papers", [{
      id: "schema-definition",
      title: "Schema Definition",
      authors: ["Author Name"],
      snippet: "Schema Snippet",
      link: "https://example.com",
      source: "Schema Source",
      date: "2026-01-01",
      relevanceScore: 0,
      matchedKeywords: ["keyword"],
      vector: dummyVector,
      indexedAt: new Date().toISOString()
    }]);
  }
};

export const indexPapers = async (papers: Paper[]) => {
  if (papers.length === 0) return;

  const table = await getTable();
  
  // Fetch existing titles to avoid duplicates
  const existingTitles = new Set<string>();
  try {
    // Only need titles for deduplication
    const existing = await table.query().select(["title"]).limit(10000).toArray();
    existing.forEach(p => existingTitles.add(p.title.toLowerCase().trim()));
  } catch (e) {
    logger.warn("Could not fetch existing titles, proceeding with potential duplicates.");
  }

  const papersToIndex = papers.filter(p => !existingTitles.has(p.title.toLowerCase().trim()));
  
  if (papersToIndex.length === 0) {
    logger.info("All papers already indexed.");
    return;
  }

  logger.info(`Indexing ${papersToIndex.length} new papers into vector database (skipped ${papers.length - papersToIndex.length} duplicates)...`);
  
  const vectorPapers: VectorPaper[] = [];

  // Process in small batches to avoid API limits
  const BATCH_SIZE = 20;
  for (let i = 0; i < papersToIndex.length; i += BATCH_SIZE) {
    const batch = papersToIndex.slice(i, i + BATCH_SIZE);
    const textsToEmbed = batch.map(p => `Title: ${p.title}\nSource: ${p.source}\nAbstract: ${p.snippet || ''}`);
    
    try {
      const embeddings = await generateBatchEmbeddings(textsToEmbed);
      
      batch.forEach((paper, idx) => {
        vectorPapers.push({
          ...paper,
          vector: embeddings[idx],
          indexedAt: new Date().toISOString()
        });
      });
      
      logger.info(`Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(papersToIndex.length / BATCH_SIZE)}`);
      
      // Add a small delay between batches to be nice to the API
      if (i + BATCH_SIZE < papersToIndex.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error(`Failed to process batch starting at index ${i}:`, error);
    }
  }

  if (vectorPapers.length > 0) {
    await table.add(vectorPapers as any);
    logger.success(`Successfully indexed ${vectorPapers.length} papers.`);
  }
};

/**
 * Semantic search for papers with optional filtering
 */
export const searchPapers = async (query: string | null | undefined, limit: number = 20, filter?: string) => {
  const table = await getTable();
  
  if (query && query.trim()) {
    const queryVector = await generateEmbedding(query);
    let search = table.vectorSearch(queryVector).limit(limit);
    
    if (filter) {
      search = search.where(filter);
    }
    
    const results = await search.toArray();
    return results.filter(r => r.id !== "schema-definition");
  } else {
    // If no semantic query, perform a scalar query and sort by newest first
    let search = table.query();
    if (filter) {
      search = search.where(filter);
    }
    
    let results = await search.toArray();
    results = results.filter(r => r.id !== "schema-definition");
    
    // Sort by date descending (newest first)
    results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    return results.slice(0, limit);
  }
};
