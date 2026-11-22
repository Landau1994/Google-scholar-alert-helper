import { GoogleGenAI } from "@google/genai";
import * as lancedb from "@lancedb/lancedb";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.ts";
import { GEMINI_EMBEDDING_MODEL, isModelUnavailableError } from "./geminiModels.ts";
import type { Paper } from "../types.ts";

const VECTOR_DB_PATH = path.resolve(process.cwd(), "data/vector_db");
export const EMBEDDING_META_PATH = path.resolve(process.cwd(), "data/embedding_meta.json");

export interface EmbeddingMetadata {
  model: string;
  dimensions: number;
  updatedAt: string;
}

export class EmbeddingModelMismatchError extends Error {
  readonly configuredModel: string;
  readonly indexedModel: string;
  readonly indexedDimensions: number;

  constructor(
    configuredModel: string,
    indexedModel: string,
    indexedDimensions: number
  ) {
    super(
      `Embedding model mismatch: configured "${configuredModel}", but LanceDB index was built with "${indexedModel}" (${indexedDimensions}-dim). Mixing different embedding spaces corrupts semantic search. Run "npm run reembed" to migrate the vector database safely.`
    );
    this.name = "EmbeddingModelMismatchError";
    this.configuredModel = configuredModel;
    this.indexedModel = indexedModel;
    this.indexedDimensions = indexedDimensions;
  }
}

export const readEmbeddingMetadata = (metaPath: string = EMBEDDING_META_PATH): EmbeddingMetadata | null => {
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    if (raw && typeof raw.model === "string" && typeof raw.dimensions === "number") {
      return raw as EmbeddingMetadata;
    }
  } catch (e) {
    logger.warn("Failed to read embedding_meta.json:", e);
  }
  return null;
};

export const writeEmbeddingMetadata = (
  meta: EmbeddingMetadata,
  metaPath: string = EMBEDDING_META_PATH
): void => {
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};

/**
 * Pure compatibility check (throws EmbeddingModelMismatchError when models differ).
 */
export const checkEmbeddingMetaCompatibility = (
  meta: EmbeddingMetadata | null,
  configuredModel: string = GEMINI_EMBEDDING_MODEL
): void => {
  if (!meta) return;
  if (meta.model !== configuredModel) {
    throw new EmbeddingModelMismatchError(configuredModel, meta.model, meta.dimensions);
  }
};

/**
 * Ensure the active embedding model matches the existing LanceDB vector space.
 * Bootstraps data/embedding_meta.json on first run for existing databases.
 */
export const assertEmbeddingModelCompatible = async (table?: any): Promise<EmbeddingMetadata | null> => {
  let meta = readEmbeddingMetadata();

  if (!meta && table) {
    try {
      const sample = await table.query().select(["vector"]).limit(1).toArray();
      const dim = sample[0]?.vector?.length;
      if (typeof dim === "number" && dim > 0) {
        meta = {
          model: GEMINI_EMBEDDING_MODEL,
          dimensions: dim,
          updatedAt: new Date().toISOString(),
        };
        writeEmbeddingMetadata(meta);
        logger.info(`Bootstrapped embedding metadata: model=${meta.model}, dimensions=${meta.dimensions}`);
      }
    } catch {
      // Ignore if table is empty or unreadable
    }
  }

  checkEmbeddingMetaCompatibility(meta, GEMINI_EMBEDDING_MODEL);
  return meta;
};

const PAPER_PUBLIC_COLUMNS = [
  "id",
  "title",
  "authors",
  "snippet",
  "link",
  "source",
  "date",
  "relevanceScore",
  "matchedKeywords",
  "indexedAt",
];

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey: string = "";

const getApiKey = (): string => {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_GEMINI_API_KEY) {
    return process.env.VITE_GEMINI_API_KEY;
  }
  return '';
};

const getGenAIClient = (): GoogleGenAI => {
  const apiKey = getApiKey();
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 120000,
      },
    });
  }
  return cachedClient;
};

/**
 * Normalize a paper title for consistent deduplication across sources.
 */
export const normalizeTitleForDedup = (title: string): string => {
  return (title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
};

/**
 * Convert a LanceDB row (which may contain Arrow Vectors) into a clean plain JS object without the vector column.
 */
const serializePaperRow = (row: any): Paper & { _distance?: number; indexedAt?: string } => {
  const result: Paper & { _distance?: number; indexedAt?: string } = {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    authors: Array.isArray(row.authors) ? row.authors : Array.from(row.authors || []),
    snippet: String(row.snippet ?? ''),
    link: String(row.link ?? ''),
    source: String(row.source ?? 'Unknown'),
    date: String(row.date ?? ''),
    relevanceScore: typeof row.relevanceScore === 'number' ? row.relevanceScore : 0,
    matchedKeywords: Array.isArray(row.matchedKeywords)
      ? row.matchedKeywords
      : Array.from(row.matchedKeywords || []),
    indexedAt: row.indexedAt ? String(row.indexedAt) : undefined,
  };

  if (typeof row._distance === 'number') {
    result._distance = row._distance;
  }
  return result;
};

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
      if (isModelUnavailableError(error)) {
        throw new Error(
          `Embedding model "${GEMINI_EMBEDDING_MODEL}" is unavailable or deprecated (${error?.message || error}). Run "npm run check:models" to inspect available embedding models, update VITE_GEMINI_EMBEDDING_MODEL, and run "npm run reembed".`
        );
      }
      const errorMsg = error?.message || error?.toString() || "";
      const isRateLimit =
        errorMsg.includes("429") ||
        errorMsg.toLowerCase().includes("rate limit") ||
        errorMsg.toLowerCase().includes("quota");

      if (attempt < maxRetries) {
        const waitTime = isRateLimit
          ? Math.min(1000 * Math.pow(2, attempt + 1), 30000)
          : 2000 * attempt;
        logger.warn(`${taskName} failed (attempt ${attempt}/${maxRetries}): ${errorMsg}. Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError;
};

/**
 * Generate embeddings for a given text using Gemini (@google/genai)
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  return await executeWithRetry(async () => {
    const ai = getGenAIClient();
    const result = await ai.models.embedContent({
      model: GEMINI_EMBEDDING_MODEL,
      contents: text,
    });
    const values = result.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      throw new Error("Empty embedding returned from Gemini API");
    }
    return values;
  }, "Generate embedding");
};

/**
 * Generate embeddings for a batch of texts
 */
export const generateBatchEmbeddings = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];

  try {
    return await executeWithRetry(async () => {
      const ai = getGenAIClient();
      const result = await ai.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: texts,
      });
      const embeddings = result.embeddings?.map(e => e.values || []);
      if (!embeddings || embeddings.length !== texts.length || embeddings.some(v => v.length === 0)) {
        throw new Error(`Unexpected batch embedding count: got ${embeddings?.length ?? 0}, expected ${texts.length}`);
      }
      return embeddings;
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
    // Create initial table with a dummy record to define schema (3072-dim for gemini-embedding-2)
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
  await assertEmbeddingModelCompatible(table);

  // Fetch ALL existing titles (no artificial limit) to prevent duplicate insertion as the archive grows
  const existingTitles = new Set<string>();
  try {
    const existing = await table.query().select(["title"]).toArray();
    existing.forEach(p => {
      const normalized = normalizeTitleForDedup(p.title);
      if (normalized) existingTitles.add(normalized);
    });
  } catch (e) {
    logger.warn("Could not fetch existing titles, proceeding with potential duplicates.");
  }

  // Deduplicate both against DB and within the incoming batch
  const papersToIndex: Paper[] = [];
  for (const p of papers) {
    const normalized = normalizeTitleForDedup(p.title);
    if (!normalized || existingTitles.has(normalized)) continue;
    existingTitles.add(normalized);
    papersToIndex.push(p);
  }

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
        const indexedAt = new Date().toISOString();
        vectorPapers.push({
          ...paper,
          date: normalizeDateString(paper.date, indexedAt),
          vector: embeddings[idx],
          indexedAt: indexedAt
        });
      });

      logger.info(`Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(papersToIndex.length / BATCH_SIZE)}`);

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
 * Semantic search for papers with optional filtering.
 * Excludes the 3072-dim `vector` column from returned rows to save memory and bandwidth.
 */
export const searchPapers = async (query: string | null | undefined, limit: number = 20, filter?: string) => {
  const table = await getTable();

  if (query && query.trim()) {
    await assertEmbeddingModelCompatible(table);
    const queryVector = await generateEmbedding(query);
    let search = table.vectorSearch(queryVector).select([...PAPER_PUBLIC_COLUMNS, "_distance"]).limit(limit);

    if (filter) {
      search = search.where(filter);
    }

    const results = await search.toArray();
    return results
      .filter(r => r.id !== "schema-definition")
      .map(serializePaperRow);
  } else {
    // Scalar query without semantic query: select only public columns (never load 3072-dim vectors)
    let search = table.query().select(PAPER_PUBLIC_COLUMNS);
    if (filter) {
      search = search.where(filter);
    }

    let results = await search.toArray();
    results = results.filter(r => r.id !== "schema-definition");

    // Sort by YYYY-MM-DD date descending (newest first)
    results.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    return results.slice(0, limit).map(serializePaperRow);
  }
};

/**
 * Normalizes a date string to YYYY-MM-DD.
 * If the date is invalid or missing, it falls back to the indexedAt date or today's date.
 */
export function normalizeDateString(dateStr: string | null | undefined, fallbackISO?: string): string {
  const fallback = (fallbackISO || new Date().toISOString()).split('T')[0];
  if (!dateStr || typeof dateStr !== 'string') {
    return fallback;
  }

  const trimmed = dateStr.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'not specified' || trimmed.toLowerCase() === 'undefined/null' || trimmed.toLowerCase() === 'null') {
    return fallback;
  }

  // If it's already in YYYY-MM-DD format, return it
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Pattern 1: Just a year (e.g., "2024", "2025")
  if (/^\d{4}$/.test(trimmed)) {
    return `${trimmed}-01-01`;
  }

  const monthMap: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12'
  };

  // Pattern 2: Month Year (e.g., "December 2025") — parsed directly to avoid local-timezone UTC shift
  const monthYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const prefix = monthYearMatch[1].toLowerCase().substring(0, 3);
    const yearStr = monthYearMatch[2];
    const monthNum = monthMap[prefix];
    if (monthNum) return `${yearStr}-${monthNum}-01`;
  }

  // Pattern 3: DD Month Year (e.g., "13 January 2026", "03 November 2025")
  const ddMonthYearMatch = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (ddMonthYearMatch) {
    const dayStr = ddMonthYearMatch[1].padStart(2, '0');
    const prefix = ddMonthYearMatch[2].toLowerCase().substring(0, 3);
    const yearStr = ddMonthYearMatch[3];
    const monthNum = monthMap[prefix];
    if (monthNum) return `${yearStr}-${monthNum}-${dayStr}`;
  }

  // Pattern 4: Month DD, Year (e.g., "January 13, 2026")
  const monthDdYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthDdYearMatch) {
    const prefix = monthDdYearMatch[1].toLowerCase().substring(0, 3);
    const dayStr = monthDdYearMatch[2].padStart(2, '0');
    const yearStr = monthDdYearMatch[3];
    const monthNum = monthMap[prefix];
    if (monthNum) return `${yearStr}-${monthNum}-${dayStr}`;
  }

  // Fallback: Attempt to parse ISO/RFC timestamps with JavaScript Date
  try {
    const parsedDate = new Date(trimmed);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.toISOString().split('T')[0];
    }
  } catch (e) {
    // Ignore invalid dates
  }

  return fallback;
}
