
import { GoogleGenAI, Type } from "@google/genai";
import type { Paper, DigestSummary } from "../types.ts";
import { logger } from "../utils/logger.ts";

// Note: Proxy is configured in scripts/loadEnv.ts which replaces globalThis.fetch
// The Google SDK should use the global fetch which is already proxy-aware
const proxyUrl = typeof process !== 'undefined' && process.env
  ? (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
  : undefined;

if (proxyUrl && typeof window === 'undefined') {
  console.log(`[GeminiService] Using proxy from loadEnv: ${proxyUrl}`);
}

// Initialize the Gemini API client using the API key from environment variables exclusively
// Vite exposes env variables via import.meta.env
const getApiKey = () => {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_GEMINI_API_KEY) {
    return process.env.VITE_GEMINI_API_KEY;
  }
  // @ts-ignore
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) {
    // @ts-ignore
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  return '';
};

const apiKey = getApiKey();
if (!apiKey) {
  console.error("Missing VITE_GEMINI_API_KEY in environment variables");
}

// Use globalThis.fetch which is replaced with proxy-aware fetch by loadEnv.ts in Node.js
const ai = new GoogleGenAI({
  apiKey: apiKey || '',
  httpOptions: {
    timeout: 120000, // 2 minutes timeout for API calls
    fetch: globalThis.fetch // Explicitly use global fetch (proxy-aware in Node.js)
  }
});

/**
 * Map sender email addresses to human-readable source names
 */
const SOURCE_MAP: Record<string, string> = {
  'scholaralerts-noreply@google.com': 'Google Scholar',
  'openRxiv-mailer@alerts.highwire.org': 'bioRxiv/medRxiv',
  'cellpress@notification.elsevier.com': 'Cell Press',
  'ealert@nature.com': 'Nature',
  'alerts@nature.com': 'Nature',
  'ahajournals@ealerts.heart.org': 'AHA Journals',
};

/**
 * Source-based weight multipliers for relevance scores.
 * Higher multipliers for peer-reviewed prestigious journals,
 * lower multipliers for preprints and general search results.
 */
const SOURCE_WEIGHT_MULTIPLIERS: Record<string, number> = {
  'Nature': 1.3,           // Prestigious peer-reviewed
  'Cell Press': 1.3,       // Prestigious peer-reviewed
  'AHA Journals': 1.2,     // Peer-reviewed specialty
  'Elsevier': 1.1,         // Peer-reviewed publisher
  'Springer': 1.1,         // Peer-reviewed publisher
  'bioRxiv/medRxiv': 0.7,  // Preprints (not peer-reviewed)
  'Google Scholar': 0.8,   // Mixed quality, general search
  'Unknown Source': 0.9,   // Default for unknown sources
};

/**
 * Apply source-based weight to a paper's relevance score.
 * Adjusts the raw AI score based on source credibility.
 */
const applySourceWeight = (paper: Paper): Paper => {
  const source = paper.source || 'Unknown Source';
  const multiplier = SOURCE_WEIGHT_MULTIPLIERS[source] || 1.0;
  const adjustedScore = Math.min(100, Math.round(paper.relevanceScore * multiplier));

  return {
    ...paper,
    relevanceScore: adjustedScore
  };
};

/**
 * Apply source weights to all papers in array
 */
const applySourceWeights = (papers: Paper[]): Paper[] => {
  return papers.map(applySourceWeight);
};

/**
 * Detect source from sender email address
 */
const detectSource = (fromAddress: string): string => {
  const lowerFrom = fromAddress.toLowerCase();
  for (const [email, source] of Object.entries(SOURCE_MAP)) {
    if (lowerFrom.includes(email.toLowerCase())) {
      return source;
    }
  }
  // Try to extract domain-based source
  const domainMatch = lowerFrom.match(/@([^>]+)/);
  if (domainMatch) {
    const domain = domainMatch[1];
    if (domain.includes('nature')) return 'Nature';
    if (domain.includes('elsevier')) return 'Elsevier';
    if (domain.includes('springer')) return 'Springer';
    if (domain.includes('highwire') || domain.includes('biorxiv') || domain.includes('medrxiv')) return 'bioRxiv/medRxiv';
    if (domain.includes('google')) return 'Google Scholar';
  }
  return 'Unknown Source';
};

/**
 * Normalize a paper title for deduplication.
 * Removes special characters, extra spaces, and converts to lowercase.
 */
const normalizeTitle = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ')    // Normalize whitespace
    .trim();
};

/**
 * Deduplicate papers by title (case-insensitive, normalized).
 * When duplicates are found, keeps the one with the higher relevance score.
 */
export const deduplicatePapers = (papers: Paper[]): Paper[] => {
  const paperMap = new Map<string, Paper>();

  for (const paper of papers) {
    const normalizedTitle = normalizeTitle(paper.title);

    // Skip if title is too short (likely invalid)
    if (normalizedTitle.length < 10) continue;

    const existing = paperMap.get(normalizedTitle);
    if (!existing || paper.relevanceScore > existing.relevanceScore) {
      // Keep the paper with higher score, or add if new
      paperMap.set(normalizedTitle, paper);
    }
  }

  return Array.from(paperMap.values());
};

/**
 * Pre-process email content to remove URLs, EXCEPT for sources without abstracts.
 * For bioRxiv/medRxiv, AHA Journals, Cell Press - URLs are the only paper identifiers,
 * so we must preserve them to avoid AI hallucination.
 * Returns the processed content and an empty linkMap (kept for API compatibility).
 */
const preprocessLinks = (content: string): { processedContent: string; linkMap: Map<string, string> } => {
  const linkMap = new Map<string, string>();
  let removedCount = 0;
  let preservedCount = 0;

  // Split content by email delimiter to process each email separately
  const emailDelimiter = /--- EMAIL ID: [^\n]+ ---/g;
  const emailParts = content.split(emailDelimiter);
  const emailHeaders = content.match(emailDelimiter) || [];

  // Match URLs - handles most common URL patterns including tracking links
  const urlRegex = /https?:\/\/[^\s<>"'\])\n]+/gi;

  let processedContent = '';

  for (let i = 0; i < emailParts.length; i++) {
    const part = emailParts[i];
    const header = i > 0 ? emailHeaders[i - 1] : '';

    // Check if this email is from a source without abstracts (marked during simplification)
    const isNoAbstractSource = part.includes('[SOURCE_NO_ABSTRACT:');

    if (isNoAbstractSource) {
      // Preserve URLs for sources without abstracts - they're the only paper identifiers
      const urlMatches = part.match(urlRegex);
      if (urlMatches) preservedCount += urlMatches.length;
      processedContent += header + part;
    } else {
      // Remove URLs from other sources to save tokens
      const processed = part.replace(urlRegex, () => {
        removedCount++;
        return '';
      });
      processedContent += header + processed;
    }
  }

  logger.info(`URLs: removed ${removedCount}, preserved ${preservedCount} (from no-abstract sources)`);

  return { processedContent, linkMap };
};

/**
 * Sources that typically don't include abstracts in their alert emails.
 * For these sources, we don't try to extract snippets and can simplify the content.
 */
const SOURCES_WITHOUT_ABSTRACTS: Record<string, string[]> = {
  'bioRxiv/medRxiv': ['biorxiv', 'medrxiv', 'highwire', 'openrxiv'],
  'AHA Journals': ['ahajournals', 'heart.org'],
  'Cell Press': ['cellpress', 'cell.com'],
};

/**
 * Check if email content is from a source that doesn't provide abstracts
 */
const getSourceWithoutAbstract = (content: string): string | null => {
  const lowerContent = content.toLowerCase();
  for (const [sourceName, patterns] of Object.entries(SOURCES_WITHOUT_ABSTRACTS)) {
    if (patterns.some(pattern => lowerContent.includes(pattern))) {
      return sourceName;
    }
  }
  return null;
};

/**
 * Pre-process emails from sources without abstracts.
 * Strips unnecessary HTML/content to save tokens while preserving paper info.
 * 
 * For Cell Press, bioRxiv/medRxiv, AHA Journals:
 * - Keep: title, authors, links
 * - Remove: HTML boilerplate, styling, images, tracking pixels
 */
const simplifyNoAbstractEmail = (emailContent: string, source: string): string => {
  // Remove HTML comments
  let simplified = emailContent.replace(/<!--[\s\S]*?-->/g, '');
  
  // Remove style blocks
  simplified = simplified.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // Remove script blocks
  simplified = simplified.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  
  // Remove image tags (tracking pixels, logos, etc.)
  simplified = simplified.replace(/<img[^>]*>/gi, '');
  
  // Remove empty table cells and formatting tables
  simplified = simplified.replace(/<td[^>]*>\s*<\/td>/gi, '');
  simplified = simplified.replace(/<tr[^>]*>\s*<\/tr>/gi, '');
  
  // Remove excessive whitespace
  simplified = simplified.replace(/\s{3,}/g, ' ');
  simplified = simplified.replace(/(\r?\n){3,}/g, '\n\n');
  
  // Add marker for AI to know this source has no abstract
  simplified = `[SOURCE_NO_ABSTRACT: ${source}]\n${simplified}`;
  
  return simplified;
};

/**
 * Extract text content from HTML, handling <br> tags and nested elements.
 * Converts <br> to spaces and strips all HTML tags.
 */
const extractTextFromHtml = (html: string): string => {
  return html
    .replace(/<br\s*\/?>/gi, ' ')     // Convert <br> to space
    .replace(/<[^>]+>/g, '')          // Remove all HTML tags
    .replace(/&nbsp;/gi, ' ')         // Convert &nbsp; to space
    .replace(/&amp;/gi, '&')          // Decode &amp;
    .replace(/&lt;/gi, '<')           // Decode &lt;
    .replace(/&gt;/gi, '>')           // Decode &gt;
    .replace(/&#\d+;/g, '')           // Remove numeric HTML entities
    .replace(/\s+/g, ' ')             // Normalize whitespace
    .trim();
};

/**
 * Pre-process email content to extract and replace long text snippets with short placeholders.
 * Supports both HTML emails (Google Scholar, Nature, Springer) and plain text emails.
 * 
 * Key improvements:
 * 1. Properly handles Google Scholar's gse_alrt_sni div with <br> tags
 * 2. Skips sources that don't provide abstracts (bioRxiv/medRxiv, AHA Journals)
 * 3. Extracts complete snippets by merging content split across <br> tags
 * 
 * Returns the processed content and a map to restore original snippets.
 */
const preprocessSnippets = (content: string): { processedContent: string; snippetMap: Map<string, string> } => {
  const snippetMap = new Map<string, string>();
  
  interface TextBlock {
    fullMatch: string;
    text: string;
    start: number;
    end: number;
    type: 'html-container' | 'html-simple' | 'plain';
  }
  const blocks: TextBlock[] = [];
  
  // Strategy 1: Google Scholar HTML - extract from gse_alrt_sni divs
  // These divs contain the snippet text, often split by <br> tags
  // Pattern: <div class="gse_alrt_sni"...>content with <br> tags</div>
  const scholarDivRegex = /<div[^>]*class="gse_alrt_sni"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = scholarDivRegex.exec(content)) !== null) {
    const innerHtml = match[1];
    const extractedText = extractTextFromHtml(innerHtml);
    
    if (extractedText.length >= 50 && isValidSnippetText(extractedText)) {
      blocks.push({
        fullMatch: match[0],
        text: extractedText,
        start: match.index,
        end: match.index + match[0].length,
        type: 'html-container'
      });
      // logger.info(`Found Google Scholar div snippet: "${extractedText.substring(0, 60)}..."`);
    }
  }
  
  // Strategy 2: Generic HTML format - text between tags like >text<
  // For emails from Nature, Springer, etc. that have simpler structures
  // Only apply if not already captured by Strategy 1
  const htmlRegex = />([^<]{80,800})</g;
  while ((match = htmlRegex.exec(content)) !== null) {
    const trimmedText = match[1].trim();
    
    // Skip if overlaps with existing blocks
    const overlapsWithExisting = blocks.some(b => 
      (match!.index >= b.start && match!.index < b.end) ||
      (b.start >= match!.index && b.start < match!.index + match![0].length)
    );
    
    if (!overlapsWithExisting && isValidSnippetText(trimmedText)) {
      blocks.push({
        fullMatch: match[0],
        text: trimmedText,
        start: match.index,
        end: match.index + match[0].length,
        type: 'html-simple'
      });
    }
  }
  
  // Strategy 3: Plain text format (for plain text emails)
  // Google Scholar plain text format:
  // Title Line
  // Authors - Journal/Source, Year
  // Snippet text that may span multiple lines
  // ending with … or period.
  //
  // Example:
  // M Mostina, J Sun, SL Sim, IA Ahmed… - Advanced Healthcare …, 2025
  // This cover illustrates the development of vascularized skin organoids by combining
  // human induced pluripotent stem cell-derived vascular organoids with skin organoids.
  // These organoids demonstrate complex vascular networks, immune cells integration …
  
  // Step 1: Find all author lines (contain " - " and end with ", Year")
  // More flexible pattern that handles ellipsis and various author formats
  const authorLineRegex = /^(.+) - (.+), (19|20)\d{2}$/gm;
  const authorLineMatches: { index: number; endIndex: number }[] = [];
  
  while ((match = authorLineRegex.exec(content)) !== null) {
    authorLineMatches.push({
      index: match.index,
      endIndex: match.index + match[0].length
    });
  }
  
  // Step 2: For each author line, extract the snippet that follows
  for (let i = 0; i < authorLineMatches.length; i++) {
    const authorLine = authorLineMatches[i];
    const snippetStart = authorLine.endIndex + 1; // Skip the newline after author line
    
    // Find where the snippet ends:
    // - At the next author line
    // - At a blank line
    // - At the end of content
    let snippetEnd = content.length;
    
    // Check for next author line
    if (i + 1 < authorLineMatches.length) {
      // Look back from next author line to find the title (previous non-empty line)
      const nextAuthorStart = authorLineMatches[i + 1].index;
      // Find the start of the title line (look for previous newline + newline pattern or start)
      let titleStart = nextAuthorStart;
      for (let j = nextAuthorStart - 1; j >= snippetStart; j--) {
        if (content[j] === '\n') {
          // Check if previous char is also newline (blank line) or this is title start
          if (j > 0 && content[j - 1] === '\n') {
            snippetEnd = j - 1;
            break;
          }
          titleStart = j + 1;
        }
      }
      // If no blank line found, the snippet ends at the title start
      if (snippetEnd === content.length) {
        snippetEnd = titleStart - 1;
      }
    }
    
    // Extract and clean snippet
    let rawSnippet = content.substring(snippetStart, snippetEnd).trim();
    
    // Remove any trailing title-like text (capitalize words that don't look like snippet)
    // Snippets typically end with … or . 
    const lines = rawSnippet.split('\n');
    const snippetLines: string[] = [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      // Check if this line looks like a paper title (starts next paper entry)
      // Titles are usually shorter and don't end with … or contain typical snippet patterns
      const looksLikeTitle = 
        trimmedLine.length < 50 && 
        !trimmedLine.endsWith('…') && 
        !trimmedLine.endsWith('.') &&
        !trimmedLine.includes(', ') &&
        /^[A-Z]/.test(trimmedLine);
      
      if (looksLikeTitle && snippetLines.length > 0) {
        // This might be the next paper's title, stop here
        break;
      }
      
      snippetLines.push(trimmedLine);
      
      // If line ends with ellipsis or period, this is likely the end of snippet
      if (trimmedLine.endsWith('…') || trimmedLine.endsWith('...')) {
        break;
      }
    }
    
    const snippetText = snippetLines.join(' ').trim();
    
    // Skip if already captured or too short
    const overlapsWithExisting = blocks.some(b => 
      (snippetStart >= b.start && snippetStart < b.end) ||
      (b.start >= snippetStart && b.start < snippetStart + snippetText.length)
    );
    
    if (!overlapsWithExisting && snippetText.length >= 50 && isValidSnippetText(snippetText)) {
      blocks.push({
        fullMatch: rawSnippet,
        text: snippetText,
        start: snippetStart,
        end: snippetStart + rawSnippet.length,
        type: 'plain'
      });
      // logger.info(`Found plain text snippet: "${snippetText.substring(0, 60)}..."`);
    }
  }
  
  // Sort blocks by position
  blocks.sort((a, b) => a.start - b.start);
  
  // Filter to keep only valid snippets
  const validSnippets: TextBlock[] = [];
  
  for (const block of blocks) {
    if (block.type === 'html-container') {
      // Google Scholar div snippets - always valid if they passed initial checks
      validSnippets.push(block);
    } else if (block.type === 'html-simple') {
      // Simple HTML snippets - need additional validation
      const hasSnippetFeatures = 
        block.text.length >= 100 ||
        block.text.includes('.') || 
        block.text.includes('。') ||
        block.text.includes('…') ||
        (block.text.match(/,/g) || []).length >= 3;
      
      if (hasSnippetFeatures) {
        validSnippets.push(block);
      }
    } else {
      // Plain text blocks - already validated
      validSnippets.push(block);
    }
  }
  
  // Replace snippets with placeholders (process in reverse order to maintain positions)
  let processedContent = content;
  
  // Sort by position descending for safe replacement
  validSnippets.sort((a, b) => b.start - a.start);
  
  for (let i = 0; i < validSnippets.length; i++) {
    const block = validSnippets[i];
    const placeholderIndex = validSnippets.length - 1 - i;
    const placeholder = `[S${placeholderIndex}]`;
    snippetMap.set(placeholder, block.text);
    
    const before = processedContent.substring(0, block.start);
    const after = processedContent.substring(block.end);
    
    if (block.type === 'html-container') {
      // For div containers, replace the entire div with a simple placeholder div
      processedContent = before + `<div class="gse_alrt_sni">${placeholder}</div>` + after;
    } else if (block.type === 'html-simple') {
      processedContent = before + `>${placeholder}<` + after;
    } else {
      processedContent = before + placeholder + after;
    }
  }
  
  logger.info(`Preprocessed ${validSnippets.length} snippets, saved approximately ${
    Array.from(snippetMap.values()).reduce((sum, s) => sum + s.length, 0) - validSnippets.length * 5
  } characters`);
  
  return { processedContent, snippetMap };
};

/** Helper: Check if text looks like a valid snippet (has sentence structure) */
const isValidSnippetText = (text: string): boolean => {
  return text.length >= 60 &&
    !text.startsWith('[L') &&
    !text.startsWith('[S') &&
    !text.startsWith('http') &&
    !text.match(/^[\s\n\r\t]+$/) &&
    // Must have sentence-like content (period, ellipsis, or Chinese period)
    (text.includes('.') || text.includes('。') || 
     text.includes('…') || text.includes('...'));
};

/**
 * Restore original URLs and snippets from placeholders in the paper results
 */
const restoreData = (
  papers: Paper[],
  linkMap: Map<string, string>,
  snippetMap: Map<string, string>
): Paper[] => {
  logger.info(`Restoring data for ${papers.length} papers. SnippetMap size: ${snippetMap.size}`);

  return papers.map((paper, idx) => {
    // Restore snippet from placeholder
    const originalSnippet = snippetMap.get(paper.snippet);

    // Clean up: if snippet is still a placeholder that wasn't found, use empty string
    let finalSnippet = originalSnippet || paper.snippet;
    if (finalSnippet && finalSnippet.match(/^\[S\d+\]$/)) {
      finalSnippet = ""; // Clear unresolved snippet placeholders
    }

    return {
      ...paper,
      link: "", // Link is no longer extracted by AI, set to empty
      snippet: finalSnippet
    };
  });
};

/**
 * Clean any remaining placeholders from paper data (safety net for display/reports)
 */
const cleanPlaceholders = (papers: Paper[]): Paper[] => {
  return papers.map(paper => ({
    ...paper,
    link: "", // Links are not extracted
    snippet: paper.snippet?.match(/^\[S\d+\]$/) ? "" : paper.snippet
  }));
};

/**
 * Estimate token count for a string (rough approximation: ~4 chars per token for English)
 */
const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/**
 * Maximum input tokens for Gemini models (conservative limits to leave room for response)
 * gemini-3-pro-preview and gemini-3-flash-preview: ~1M tokens, but we use 800k to be safe
 */
const MAX_INPUT_TOKENS = 800000;

/**
 * Split large content into processable chunks
 * Each chunk should be small enough to fit within token limits
 */
const splitIntoChunks = (rawEmails: string, maxTokensPerChunk: number = 200000): string[] => {
  const emailDelimiter = /--- EMAIL ID: [^\n]+ ---/g;
  const emailParts = rawEmails.split(emailDelimiter);
  const emailHeaders = rawEmails.match(emailDelimiter) || [];

  const chunks: string[] = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (let i = 0; i < emailParts.length; i++) {
    const part = emailParts[i];
    const header = i > 0 ? emailHeaders[i - 1] : '';
    const emailContent = header + part;
    const emailTokens = estimateTokens(emailContent);

    // If adding this email would exceed the limit, start a new chunk
    if (currentTokens + emailTokens > maxTokensPerChunk && currentChunk.trim()) {
      chunks.push(currentChunk);
      currentChunk = '';
      currentTokens = 0;
    }

    currentChunk += emailContent;
    currentTokens += emailTokens;
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
};

/**
 * Delay helper for retry logic
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parse error message from Gemini API error
 */
const parseGeminiError = (error: any): { type: 'rate_limit' | 'token_limit' | 'auth' | 'network' | 'unknown', message: string } => {
  const errorStr = error?.message || error?.toString() || '';
  const statusCode = error?.status || error?.statusCode;

  // Check for rate limit errors
  if (statusCode === 429 || errorStr.includes('429') || errorStr.toLowerCase().includes('rate limit') || errorStr.toLowerCase().includes('quota')) {
    return { type: 'rate_limit', message: 'API rate limit exceeded. Please wait a moment and try again.' };
  }

  // Check for token/context limit errors
  if (errorStr.toLowerCase().includes('token') || errorStr.toLowerCase().includes('context length') ||
      errorStr.toLowerCase().includes('too long') || errorStr.toLowerCase().includes('exceeds')) {
    return { type: 'token_limit', message: 'Content too large for AI processing. Will attempt to process in smaller batches.' };
  }

  // Check for authentication errors
  if (statusCode === 401 || statusCode === 403 || errorStr.toLowerCase().includes('api key') ||
      errorStr.toLowerCase().includes('unauthorized') || errorStr.toLowerCase().includes('forbidden')) {
    return { type: 'auth', message: 'Invalid or missing API key. Please check your VITE_GEMINI_API_KEY in .env.local' };
  }

  // Check for network errors
  if (errorStr.toLowerCase().includes('timeout') || errorStr.toLowerCase().includes('deadline exceeded')) {
    return { type: 'network', message: 'AI request timed out. The content might be too large or the server is busy.' };
  }

  // Check for AbortError
  if (errorStr.toLowerCase().includes('abort')) {
    return { type: 'network', message: 'Request was aborted. This may be due to network issues or timeout. Will retry...' };
  }

  if (errorStr.toLowerCase().includes('network') || errorStr.toLowerCase().includes('fetch') ||
      errorStr.toLowerCase().includes('connection')) {
    return { type: 'network', message: 'Network error. Please check your internet connection and try again.' };
  }

  return { type: 'unknown', message: `AI processing failed: ${errorStr.substring(0, 200)}` };
};

/**
 * Execute a Gemini API call with retry logic
 */
const executeWithRetry = async <T>(
  action: () => Promise<T>,
  modelName: string,
  maxRetries: number = 3
): Promise<T> => {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Attempt ${attempt}/${maxRetries} with model: ${modelName}`);
      return await action();
    } catch (error: any) {
      lastError = error;
      // Log raw error for debugging
      if (attempt === 1) {
        logger.error(`Raw error (${modelName}): ${error?.message || error?.toString()}`);
      }
      const parsed = parseGeminiError(error);
      logger.warn(`Attempt ${attempt} failed: ${parsed.message}`);

      // Don't retry auth errors - they won't fix themselves
      if (parsed.type === 'auth') {
        throw new Error(parsed.message);
      }

      // For rate limits, wait longer before retry
      if (parsed.type === 'rate_limit' && attempt < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 30000); // Exponential backoff, max 30s
        logger.warn(`Rate limited. Waiting ${waitTime}ms before retry...`);
        await delay(waitTime);
        continue;
      }

      // For other errors, brief delay before retry
      if (attempt < maxRetries) {
        await delay(1000 * attempt);
      }
    }
  }

  throw lastError;
};

export const processScholarEmails = async (
  rawEmails: string,
  keywords: string[],
  maxPapers: number = 200
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  // Step 0: Pre-process emails from sources without abstracts to save tokens
  // Split by email delimiter, process each, then rejoin
  const emailDelimiter = /--- EMAIL ID: [^\n]+ ---/g;
  const emailParts = rawEmails.split(emailDelimiter);
  const emailHeaders = rawEmails.match(emailDelimiter) || [];
  
  let processedEmails = '';
  let simplifiedCount = 0;
  
  for (let i = 0; i < emailParts.length; i++) {
    const part = emailParts[i];
    const header = i > 0 ? emailHeaders[i - 1] : '';
    
    // Check if this email is from a source without abstracts
    const noAbstractSource = getSourceWithoutAbstract(part);
    
    if (noAbstractSource && part.trim()) {
      // Simplify this email to save tokens
      const simplified = simplifyNoAbstractEmail(part, noAbstractSource);
      processedEmails += header + '\n' + simplified;
      simplifiedCount++;
    } else {
      processedEmails += header + part;
    }
  }
  
  if (simplifiedCount > 0) {
    logger.info(`Simplified ${simplifiedCount} emails from sources without abstracts`);
  }
  
  // Step 1: Pre-process URLs → [L0], [L1], ...
  const { processedContent: contentWithLinkPlaceholders, linkMap } = preprocessLinks(processedEmails);
  
  // Step 2: Pre-process snippets → [S0], [S1], ...
  const { processedContent: finalContent, snippetMap } = preprocessSnippets(contentWithLinkPlaceholders);
  
  const prompt = `
    Analyze the following raw content from academic alert emails (e.g., Google Scholar, openRxiv, Nature Alerts). 
    
    **IMPORTANT TOKEN-SAVING PLACEHOLDERS:**
    - Text snippets/descriptions have been replaced with placeholders like [S0], [S1], etc.
    
    **SOURCE DETECTION - Use the "From:" field to determine source:**
    - scholaralerts-noreply@google.com → "Google Scholar"
    - openRxiv-mailer@alerts.highwire.org → "bioRxiv/medRxiv"
    - cellpress@notification.elsevier.com → "Cell Press"
    - ealert@nature.com or alerts@nature.com → "Nature"
    - ahajournals@ealerts.heart.org → "AHA Journals"
    - For unknown senders, use the domain name as source
    
    **SOURCES WITHOUT ABSTRACTS:**
    - bioRxiv/medRxiv, AHA Journals, and Cell Press emails typically do NOT contain abstracts/snippets.
    - Emails marked with [SOURCE_NO_ABSTRACT: xxx] have been pre-identified as no-abstract sources.
    - For papers from these sources, use an **empty string ""** for the snippet field.
    - Do NOT try to generate or invent snippets for these sources.
    
    1. **Extract ALL academic papers mentioned.** 
       - For standard alerts, extract the recommended papers.
       - **CRITICAL:** For 'New citation' or 'Citations to my articles' emails, extract the **citing** papers listed in the email body (do NOT extract the user's paper that was cited).
       - **TARGET:** Aim to extract and analyze **at least 50 papers** if they exist in the provided content. Do NOT provide a short list if more papers are available.
       - **EXTRACT EVERY SINGLE PAPER** found in the content, up to a maximum of ${maxPapers} papers. Do NOT arbitrarily limit the output.
       - **IMPORTANT:** Even if a paper seems irrelevant to the keywords, **EXTRACT IT ANYWAY**. We will filter or score it later. Do not self-censor.
    2. For each paper, identify: title, authors, snippet/description, and **source**.
       - **SNIPPET**: Use the snippet placeholder (e.g., [S0], [S1]) that appears near the paper as its description.
         * Return just the placeholder (e.g., "[S5]") as the snippet value.
         * If NO snippet placeholder is present near a paper, return an **empty string ""**.
         * **Do NOT generate or invent snippets** - only use placeholders that exist in the content.
         * For bioRxiv/medRxiv, AHA Journals, and Cell Press sources, snippets are unavailable - always use "".
       - **AUTHORS**: Extract at most **3 authors**. If there are more, use the first 3. Do NOT include "et al." in the array.
       - **SOURCE**: Look at the "From:" line in the email section where this paper appears. Map the sender to the source name using the rules above.
    3. **Score** these papers based on their relevance to these keywords: ${keywords.join(", ")}.
       - Assign a 'relevanceScore' from 0 to 100.
       - **IMPORTANT:** Do NOT filter out or omit papers that do not match the keywords. Include them with a lower score (e.g., 0-10) if they are unrelated.
    4. SORT the papers by their relevance score in descending order (highest score first).
    5. Generate a cohesive summary of the research trends found in these emails.
    6. **Generate a detailed, academic-style review report** ('academicReport').
       - Structure it like a mini-review paper.
       - **Categorize by Keywords**: Create sections for each relevant keyword found.
       - **Synthesis**: Within each section, synthesize the findings from the papers, discussing how they relate to each other.
       - **Citations**: Use inline citations for every claim (e.g., "Smith et al. (2024) proposed...").
       - **Conclusion**: Briefly summarize the overall direction of the field.
       - Do NOT include a "References" list at the end (this will be appended programmatically).

    Content:
    ${finalContent}
  `;

  const generate = async (modelName: string) => {
    logger.info(`Attempting to generate content with model: ${modelName}`);
    return await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            papers: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "A unique identifier for the paper" },
                  title: { type: Type.STRING },
                  authors: { type: Type.ARRAY, items: { type: Type.STRING }, description: "First 3 authors only" },
                  snippet: { type: Type.STRING, description: "Snippet placeholder like [S0] or empty string if not present" },
                  source: { type: Type.STRING, description: "The origin of the alert, e.g., 'Google Scholar Alert'" },
                  date: { type: Type.STRING },
                  relevanceScore: { type: Type.NUMBER, description: "Relevance percentage from 0 to 100" },
                  matchedKeywords: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["id", "title", "authors", "snippet", "source", "date", "relevanceScore", "matchedKeywords"],
                propertyOrdering: ["id", "title", "authors", "snippet", "source", "date", "relevanceScore", "matchedKeywords"]
              }
            },
            summary: {
              type: Type.OBJECT,
              properties: {
                overview: { type: Type.STRING },
                academicReport: { type: Type.STRING, description: "A detailed, academic-style review in Markdown format." },
                keyTrends: { type: Type.ARRAY, items: { type: Type.STRING } },
                topRecommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
                categorizedPapers: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      keyword: { type: Type.STRING },
                      paperIds: { type: Type.ARRAY, items: { type: Type.STRING } }
                    }
                  }
                }
              },
              required: ["overview", "academicReport", "keyTrends", "topRecommendations", "categorizedPapers"],
              propertyOrdering: ["overview", "academicReport", "keyTrends", "topRecommendations", "categorizedPapers"]
            }
          },
          required: ["papers", "summary"]
        }
      }
    });
  };

  // Check if content is too large and needs chunking
  const estimatedTokens = estimateTokens(finalContent);
  logger.info(`Estimated tokens for content: ${estimatedTokens}`);

  if (estimatedTokens > MAX_INPUT_TOKENS) {
    logger.warn(`Content exceeds token limit (${estimatedTokens} > ${MAX_INPUT_TOKENS}), processing in chunks...`);
    return processInChunks(rawEmails, keywords, maxPapers, linkMap, snippetMap);
  }

  // Helper function with retry logic
  const generateWithRetry = async (modelName: string, maxRetries: number = 3): Promise<any> => {
    return await executeWithRetry(async () => {
      const response = await generate(modelName);
      const jsonStr = response.text;
      if (!jsonStr) throw new Error("Empty response from API");
      return JSON.parse(jsonStr.trim());
    }, modelName, maxRetries);
  };

  try {
    // Try primary model first with retry
    try {
      const result = await generateWithRetry('gemini-3-flash-preview');
      result.papers = restoreData(result.papers, linkMap, snippetMap);
      result.papers = applySourceWeights(result.papers);
      logger.success(`Successfully extracted ${result.papers.length} papers (with source weights applied)`);
      return result;
    } catch (primaryError: any) {
      const parsed = parseGeminiError(primaryError);

      // If auth error, don't bother with fallback
      if (parsed.type === 'auth') {
        throw new Error(parsed.message);
      }

      // If token limit error, try chunking
      if (parsed.type === 'token_limit') {
        logger.warn('Token limit hit, switching to chunked processing...');
        return processInChunks(rawEmails, keywords, maxPapers, linkMap, snippetMap);
      }

      logger.warn(`Primary model failed, attempting fallback... ${parsed.message}`);

      // Fallback to pro model with retry
      try {
        const result = await generateWithRetry('gemini-3-pro-preview');
        result.papers = restoreData(result.papers, linkMap, snippetMap);
        result.papers = applySourceWeights(result.papers);
        logger.success(`Successfully extracted ${result.papers.length} papers (fallback, with source weights applied)`);
        return result;
      } catch (fallbackError: any) {
        const fallbackParsed = parseGeminiError(fallbackError);

        // If fallback also hits token limit, try chunking
        if (fallbackParsed.type === 'token_limit') {
          logger.warn('Fallback also hit token limit, switching to chunked processing...');
          return processInChunks(rawEmails, keywords, maxPapers, linkMap, snippetMap);
        }

        throw new Error(fallbackParsed.message);
      }
    }
  } catch (error: any) {
    logger.error("Failed to process with Gemini:", error);
    // Re-throw with the parsed message if it's already a user-friendly error
    if (error.message && !error.message.includes('undefined')) {
      throw error;
    }
    throw new Error("Failed to process emails. Please check your API key and try again with fewer emails.");
  }
};

/**
 * Process large email sets in chunks and merge results
 */
const processInChunks = async (
  rawEmails: string,
  keywords: string[],
  maxPapers: number,
  globalLinkMap: Map<string, string>,
  globalSnippetMap: Map<string, string>
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  const chunks = splitIntoChunks(rawEmails);
  logger.info(`Split content into ${chunks.length} chunks for processing`);

  const allPapers: Paper[] = [];
  const allKeyTrends: string[] = [];
  const allRecommendations: string[] = [];
  let combinedOverview = '';

  // Concurrency limit to avoid hitting rate limits instantly
  const CONCURRENCY_LIMIT = 5;
  
  // Helper to process a single chunk
  const processChunk = async (chunk: string, index: number) => {
    logger.info(`Processing chunk ${index + 1}/${chunks.length}...`);
    try {
      // Calculate proportional max papers for this chunk to ensure distribution
      // (Simple division, but could be weighted by chunk size in future)
      const chunkMaxPapers = Math.ceil(maxPapers / chunks.length);
      
      const result = await processScholarEmails(chunk, keywords, chunkMaxPapers);
      return result;
    } catch (chunkError: any) {
      logger.error(`Failed to process chunk ${index + 1}:`, chunkError);
      return null;
    }
  };

  // Process chunks with concurrency limit
  const results: ({ papers: Paper[], summary: DigestSummary } | null)[] = [];
  
  for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
    const batch = chunks.slice(i, i + CONCURRENCY_LIMIT);
    logger.info(`Starting batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1} (${batch.length} chunks)`);
    
    const batchPromises = batch.map((chunk, batchIdx) => processChunk(chunk, i + batchIdx));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Longer delay between batches to prevent rate limiting and reduce AbortError
    if (i + CONCURRENCY_LIMIT < chunks.length) {
      logger.info(`Completed batch. Waiting before next batch...`);
      await delay(3000); // Increased from 1000ms to 3000ms
    }
  }

  // Aggregate results
  for (const result of results) {
    if (result) {
      allPapers.push(...result.papers);
      if (result.summary) {
        allKeyTrends.push(...(result.summary.keyTrends || []));
        allRecommendations.push(...(result.summary.topRecommendations || []));
        combinedOverview += result.summary.overview + '\n\n';
      }
    }
  }

  if (allPapers.length === 0) {
    throw new Error("Failed to extract any papers from the emails. Please try with fewer emails or check your content.");
  }

  // Deduplicate papers using enhanced normalization
  const uniquePapers = deduplicatePapers(allPapers);

  // Sort by relevance (source weights already applied per-chunk) and limit
  const sortedPapers = uniquePapers
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxPapers);

  // Deduplicate trends and recommendations
  const uniqueTrends = [...new Set(allKeyTrends)].slice(0, 10);
  const uniqueRecommendations = [...new Set(allRecommendations)].slice(0, 10);

  const mergedSummary: DigestSummary = {
    overview: combinedOverview.trim() || `Analyzed ${sortedPapers.length} papers across ${chunks.length} batches.`,
    academicReport: '',
    keyTrends: uniqueTrends,
    topRecommendations: uniqueRecommendations,
    categorizedPapers: []
  };

  logger.success(`Chunked processing complete: ${sortedPapers.length} unique papers (source weights applied)`);
  return { papers: sortedPapers, summary: mergedSummary };
}

/**
 * Lightweight version of processScholarEmails for Node.js/scheduler use.
 * Uses a simpler schema that works better with proxy connections.
 * Processes content in smaller chunks to avoid timeout issues.
 */
export const processScholarEmailsLightweight = async (
  rawEmails: string,
  keywords: string[],
  maxPapers: number = 200
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  logger.info('[Lightweight] Starting lightweight email processing...');

  // Pre-process emails from sources without abstracts
  const emailDelimiter = /--- EMAIL ID: [^\n]+ ---/g;
  const emailParts = rawEmails.split(emailDelimiter);
  const emailHeaders = rawEmails.match(emailDelimiter) || [];

  let processedEmails = '';

  for (let i = 0; i < emailParts.length; i++) {
    const part = emailParts[i];
    const header = i > 0 ? emailHeaders[i - 1] : '';
    const noAbstractSource = getSourceWithoutAbstract(part);

    if (noAbstractSource && part.trim()) {
      processedEmails += header + '\n' + simplifyNoAbstractEmail(part, noAbstractSource);
    } else {
      processedEmails += header + part;
    }
  }

  // Remove URLs to reduce content size
  const { processedContent: finalContent } = preprocessLinks(processedEmails);

  // Split content into smaller chunks (max 3000 chars each for reliability)
  const MAX_CHUNK_SIZE = 3000;
  const contentChunks: string[] = [];

  // For bioRxiv emails, split by paper entries (look for "doi:" patterns)
  // Otherwise split by email boundaries or by size
  const doiPattern = /(?=doi:10\.\d+)/gi;
  const paperEntries = finalContent.split(doiPattern);

  let currentChunk = '';
  for (const entry of paperEntries) {
    if (currentChunk.length + entry.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
      contentChunks.push(currentChunk.trim());
      currentChunk = entry;
    } else {
      currentChunk += entry;
    }
  }
  if (currentChunk.trim()) {
    contentChunks.push(currentChunk.trim());
  }

  // If no chunks were created (no doi patterns), split by size
  if (contentChunks.length === 0 || (contentChunks.length === 1 && contentChunks[0].length > MAX_CHUNK_SIZE)) {
    contentChunks.length = 0;
    for (let i = 0; i < finalContent.length; i += MAX_CHUNK_SIZE) {
      contentChunks.push(finalContent.substring(i, i + MAX_CHUNK_SIZE));
    }
  }

  logger.info(`[Lightweight] Split into ${contentChunks.length} chunks`);

  // Simple schema that works reliably with proxy
  const simpleSchema = {
    type: Type.OBJECT,
    properties: {
      papers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            authors: { type: Type.STRING, description: "Comma-separated author names" },
            relevanceScore: { type: Type.NUMBER }
          }
        }
      }
    }
  };

  const allPapers: Paper[] = [];

  for (let i = 0; i < contentChunks.length; i++) {
    const chunk = contentChunks[i];
    logger.info(`[Lightweight] Processing chunk ${i + 1}/${contentChunks.length}...`);

    const prompt = `Extract academic papers from this content. Score relevance (0-100) to: ${keywords.join(', ')}.

${chunk}`;

    try {
      const response = await executeWithRetry(async () => {
        return await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: simpleSchema
          }
        });
      }, 'gemini-3-flash-preview', 3);

      const result = JSON.parse(response.text || '{"papers":[]}');

      if (result.papers && Array.isArray(result.papers)) {
        // Convert simple format to full Paper format
        for (const p of result.papers) {
          if (p.title && p.title.length > 10) {
            const paper: Paper = {
              id: `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              title: p.title,
              authors: p.authors ? p.authors.split(',').map((a: string) => a.trim()).slice(0, 3) : [],
              snippet: '',
              source: 'bioRxiv/medRxiv', // Default, will be adjusted by source weight
              date: new Date().toISOString().split('T')[0],
              relevanceScore: Math.round(p.relevanceScore || 0),
              matchedKeywords: keywords.filter(k =>
                p.title.toLowerCase().includes(k.toLowerCase())
              )
            };
            allPapers.push(paper);
          }
        }
        logger.info(`[Lightweight] Chunk ${i + 1}: extracted ${result.papers.length} papers`);
      }
    } catch (chunkError: any) {
      logger.error(`[Lightweight] Chunk ${i + 1} failed:`, chunkError.message);
      // Continue with next chunk
    }

    // Delay between chunks to avoid rate limiting
    if (i < contentChunks.length - 1) {
      await delay(2000);
    }
  }

  // Deduplicate and apply source weights
  const dedupedPapers = deduplicatePapers(allPapers);
  const weightedPapers = applySourceWeights(dedupedPapers);

  // Sort by relevance and limit
  const sortedPapers = weightedPapers
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxPapers);

  logger.success(`[Lightweight] Complete: ${sortedPapers.length} unique papers`);

  return {
    papers: sortedPapers,
    summary: {
      overview: `Extracted ${sortedPapers.length} papers using lightweight processing.`,
      academicReport: '',
      keyTrends: [],
      topRecommendations: [],
      categorizedPapers: []
    }
  };
};

export const generateLiteratureReview = async (
  papers: Paper[],
  keywords: string[]
): Promise<string> => {
  // Clean any remaining placeholders as a safety net
  const cleanedPapers = cleanPlaceholders(papers);
  
  // Always use segmented approach (Plan & Parallel) for now to test robustness
  if (cleanedPapers.length <= 0) {
    return generateLiteratureReviewSingleShot(cleanedPapers, keywords);
  } else {
    // For larger sets, use the segmented approach to avoid token limits and ensure detail
    return generateLiteratureReviewSegmented(cleanedPapers, keywords);
  }
};

const generateLiteratureReviewSingleShot = async (
  papers: Paper[],
  keywords: string[]
): Promise<string> => {
  const papersContext = papers.map((p, i) =>
    `[${i+1}] Title: ${p.title}\nAuthors: ${p.authors.join(", ")}\nSnippet: ${p.snippet}\nRelevance: ${p.relevanceScore}`
  ).join("\n\n");

  const prompt = `
    You are an expert academic researcher. Write a comprehensive, high-quality literature review based STRICTLY on the following ${papers.length} papers.

    Target Audience: Researchers in the field.
    Tone: Formal, analytical, and synthetic.
    Language: **Bilingual (English and Chinese)**. For every section, provide the English version first, followed immediately by the Chinese translation.

    Instructions:
    1. **Title**: Generate a relevant title for this review (English & Chinese).
    2. **Structure**:
       - **Introduction / 简介**: Briefly introduce the themes found in these papers.
       - **Thematic Sections / 主题板块**: Group the papers by scientific themes/topics (derived from the papers and these keywords: ${keywords.join(", ")}).
       - **Synthesis**: In each section, discuss the findings. usage inline citations like "Author et al. [ID]" or "Author et al. (Year)" to reference the papers provided.
       - **Future Directions/Conclusion / 总结与展望**: Summarize the state of the research.
    3. **Constraints**:
       - Do NOT output a "References" list at the end. (We will append the full details programmatically).
       - Use the provided IDs [1], [2], etc. or Author names for citations.
       - Focus on the most relevant papers (highest scores) but try to include others if they fit the narrative.
       - Ensure the Chinese translation is accurate, academic, and natural.

    Papers:
    ${papersContext}
  `;

  try {
    const response = await executeWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: prompt
      });
    }, 'gemini-3-pro-preview', 5); // Increased retries for long-running review generation
    return response.text || "Failed to generate report.";
  } catch (error) {
    logger.error("Failed to generate literature review (single-shot):", error);
    return "Error generating literature review. Please try again.";
  }
};

/**
 * Lightweight literature review generator optimized for proxy/Node.js environments
 * Uses single-shot approach (no parallel requests) for better proxy reliability
 */
export const generateLiteratureReviewLightweight = async (
  papers: Paper[],
  keywords: string[]
): Promise<string> => {
  logger.info(`[Lightweight] Generating review for ${papers.length} papers...`);

  // Truncate snippet to reduce token usage
  const papersContext = papers.map((p, i) =>
    `[${i+1}] ${p.title} | ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? ' et al.' : ''} | ${(p.snippet || '').substring(0, 150)}`
  ).join("\n");

  const prompt = `You are an academic researcher. Write a literature review based on these ${papers.length} papers.

Keywords: ${keywords.join(", ")}

Requirements:
- Bilingual: English first, then Chinese translation for each section
- Structure: Title, Introduction, 3-5 Thematic Sections, Conclusion
- Cite papers using [1], [2], etc.
- No References section needed

Papers:
${papersContext}

Write the review now:`;

  try {
    const response = await executeWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt
      });
    }, 'gemini-3-flash-preview', 5);

    logger.info(`[Lightweight] Review generated successfully`);
    return response.text || "Failed to generate report.";
  } catch (error) {
    logger.error("[Lightweight] Failed to generate literature review:", error);
    return "Error generating literature review. Please try again.";
  }
};

const generateLiteratureReviewSegmented = async (
  papers: Paper[],
  keywords: string[]
): Promise<string> => {
  logger.info(`Starting segmented review generation for ${papers.length} papers...`);

  // Helper to format papers for prompt
  const formatPapers = (list: Paper[], globalIndices: number[]) => list.map((p, i) => 
    `[${globalIndices[i]}] Title: ${p.title}\nAuthors: ${p.authors.join(", ")}\nSnippet: ${p.snippet}`
  ).join("\n\n");

  try {
    // --- Step 1: Outline & Grouping ---
    // We send just titles and snippets to get the structure.
    const outlineContext = papers.map((p, i) => `[${i+1}] ${p.title} (${(p.snippet || '').substring(0, 100)}...)`).join("\n");
    
    const outlinePrompt = `
      Analyze these ${papers.length} academic papers.
      Goal: Plan a comprehensive literature review structure.
      
      Keywords involved: ${keywords.join(", ")}

      Task:
      1. Create a bilingual Title for the review.
      2. Write a bilingual Introduction (English & Chinese).
      3. **Group the papers into 3-6 distinct scientific themes.** 
         - Assign papers to themes using their IDs [1], [2], etc.
         - Ensure MOST papers are included in a theme.
      4. Provide brief notes for the Conclusion.

      Output JSON format:
      {
        "title": "Title String",
        "introduction": "Intro Text...",
        "themes": [
          { "title": "Theme Title", "paperIds": [1, 5, 12...] }
        ],
        "conclusion_notes": "Notes..."
      }
    `;

    const outlineResponse = await executeWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3-flash-preview', // Use Flash for structure/routing (faster, larger context)
        contents: outlinePrompt,
        config: { responseMimeType: "application/json" }
      });
    }, 'gemini-3-flash-preview', 5); // Increased retries for reliability

    const outline = JSON.parse(outlineResponse.text || "{}");
    if (!outline.themes) throw new Error("Failed to generate outline themes.");

    let fullReport = `# ${outline.title}\n\n`;
    fullReport += `${outline.introduction}\n\n`;

    // --- Step 2: Generate Sections (Parallel Execution) ---
    logger.info(`Generating sections for ${outline.themes.length} themes in parallel...`);
    
    // Concurrency limiter function
    const generateSection = async (theme: any) => {
      const themeTitle = theme.title;
      const ids: number[] = theme.paperIds;
      
      // Filter papers that belong to this theme
      const relevantIndices: number[] = [];
      const themePapers = ids.map(id => {
        const index = id - 1;
        if (papers[index]) {
          relevantIndices.push(id);
          return papers[index];
        }
        return null;
      }).filter(p => p !== null) as Paper[];

      if (themePapers.length === 0) return { title: themeTitle, content: "" };

      const sectionContext = formatPapers(themePapers, relevantIndices);

      const sectionPrompt = `
        Write a detailed literature review section for the theme: **"${themeTitle}"**.
        
        Context: Part of a larger review on ${keywords.join(", ")}.
        
        Instructions:
        - Language: **Bilingual (English followed by Chinese)**.
        - Analyze the papers provided below.
        - Synthesize findings, compare results, and identify consensus or debate.
        - **Cite papers** using the provided IDs like [1], [15].
        - Do NOT include a separate "Introduction" or "Conclusion" for this section, just the body content.
        
        Papers for this section:
        ${sectionContext}
      `;

      try {
        const response = await executeWithRetry(async () => {
          return await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: sectionPrompt
          });
        }, 'gemini-3-pro-preview', 5); // Increased retries for section generation

        return { title: themeTitle, content: response.text };
      } catch (e) {
        logger.error(`Failed to generate section '${themeTitle}':`, e);
        return { title: themeTitle, content: `*(Failed to generate section for ${themeTitle})*` };
      }
    };

    // Run with concurrency limit
    const CONCURRENCY_LIMIT = 3;
    const themeResults = [];

    for (let i = 0; i < outline.themes.length; i += CONCURRENCY_LIMIT) {
      const batch = outline.themes.slice(i, i + CONCURRENCY_LIMIT);
      const batchPromises = batch.map((theme: any) => generateSection(theme));
      const batchResults = await Promise.all(batchPromises);
      themeResults.push(...batchResults);

      // Longer delay to prevent rate limiting and reduce AbortError
      if (i + CONCURRENCY_LIMIT < outline.themes.length) {
        logger.info(`Completed batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}. Waiting before next batch...`);
        await delay(3000); // Increased from 1000ms to 3000ms
      }
    }

    // Assemble full report
    for (const res of themeResults) {
      if (res.content) {
        fullReport += `## ${res.title}\n\n${res.content}\n\n`;
      }
    }

    // --- Step 3: Conclusion ---
    const conclusionPrompt = `
      Write a **Conclusion / 总结与展望** for this literature review.
      
      Based on:
      - Introduction: "${outline.introduction}"
      - Themes covered: ${outline.themes.map((t: any) => t.title).join(", ")}
      - Notes: "${outline.conclusion_notes}"

      Instructions:
      - Bilingual (English & Chinese).
      - Summarize the overall state of research.
      - Suggest future directions.
    `;

    const conclusionResponse = await executeWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: conclusionPrompt
      });
    }, 'gemini-3-pro-preview', 5); // Increased retries for conclusion generation

    fullReport += `${conclusionResponse.text}\n\n`;

    return fullReport;

  } catch (error) {
    logger.error("Segmented review generation failed:", error);
    return generateLiteratureReviewSingleShot(papers, keywords); // Fallback
  }
};
