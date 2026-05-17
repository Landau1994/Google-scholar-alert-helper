
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
 * Generate embeddings for a given text using Gemini
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  try {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (error) {
    logger.error(`Error generating embedding with ${EMBEDDING_MODEL}:`, error);
    throw error;
  }
};

/**
 * Generate embeddings for a batch of texts
 */
export const generateBatchEmbeddings = async (texts: string[]): Promise<number[][]> => {
  try {
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.batchEmbedContents({
      requests: texts.map(t => ({ content: { role: 'user', parts: [{ text: t }] } }))
    });
    return result.embeddings.map(e => e.values);
  } catch (error) {
    logger.error(`Error generating batch embeddings:`, error);
    // Fallback to sequential if batch fails
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

/**
 * Index papers into the vector database
 */
export const indexPapers = async (papers: Paper[]) => {
  if (papers.length === 0) return;

  logger.info(`Indexing ${papers.length} papers into vector database...`);
  
  const table = await getTable();
  const vectorPapers: VectorPaper[] = [];

  // Process in small batches to avoid API limits
  const BATCH_SIZE = 20;
  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    const batch = papers.slice(i, i + BATCH_SIZE);
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
      
      logger.info(`Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(papers.length / BATCH_SIZE)}`);
    } catch (error) {
      logger.error(`Failed to process batch starting at index ${i}:`, error);
    }
  }

  if (vectorPapers.length > 0) {
    await table.add(vectorPapers);
    logger.success(`Successfully indexed ${vectorPapers.length} papers.`);
  }
};

/**
 * Semantic search for papers
 */
export const searchPapers = async (query: string, limit: number = 20) => {
  const table = await getTable();
  const queryVector = await generateEmbedding(query);
  
  const results = await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
    
  // Filter out the dummy schema record if it appears
  return results.filter(r => r.id !== "schema-definition");
};
