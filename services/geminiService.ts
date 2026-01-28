
import { GoogleGenAI, Type } from "@google/genai";
import type { Paper, DigestSummary } from "../types.ts";
import { logger } from "../utils/logger.ts";
import { extractArticlesFromEmail, type ExtractedArticle } from "./emailArticleExtractor.ts";

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
 *
 * Tier structure:
 * - 1.5x: Flagship journals (Nature, Cell, Science)
 * - 1.3x: Top-tier journals and Nature/Science subsidiary journals
 * - 1.2x: High-quality specialty journals, Cell Press subsidiary journals, AHA journals
 * - 1.1x: Major publishers
 * - 0.75x: Mega-journals
 * - 0.6x: Preprints
 * - 0.5x: Low-impact open access
 * - 0.2x: Unknown sources
 */
const SOURCE_WEIGHT_MULTIPLIERS: Record<string, number> = {
  // Flagship journals
  'Nature': 1.5,
  'Cell': 1.5,
  'Science': 1.5,

  // Top-tier journals
  'The Lancet': 1.3,
  'NEJM': 1.3,

  // Nature subsidiary journals
  'Nature Communications': 1.3,
  'Nature Medicine': 1.3,
  'Nature Genetics': 1.3,
  'Communications Biology': 1.0,

  // Advanced Science
  'Advanced Science': 1.0,

  // Cell Press flagship journals (sister journals to Cell)
  'Immunity': 1.3,
  'Neuron': 1.3,
  'Developmental Cell': 1.3,
  'Molecular Cell': 1.3,
  'Cancer Cell': 1.3,

  // Cell Press subsidiary journals
  'Cell Press': 1.2,
  'Cell Systems': 1.2,
  'Cell Reports': 1.2,
  'Cell Reports Methods': 1.2,
  'Cell Stem Cell': 1.2,
  'Cell Metabolism': 1.2,
  'Cell Genomics': 1.2,
  'Cell Chemical Biology': 1.2,
  'Cell Host & Microbe': 1.2,
  'Structure': 1.2,
  'iScience': 1.2,
  'STAR Protocols': 1.2,

  // High-quality specialty journals
  'PNAS': 1.2,
  'JAMA': 1.2,

  // AHA flagship journals (higher tier)
  'Circulation': 1.3,
  'Circulation Research': 1.3,

  // AHA subsidiary journals (lower tier)
  'Hypertension': 1.2,
  'Stroke': 1.2,
  'Arteriosclerosis, Thrombosis, and Vascular Biology': 1.2,
  'AHA Journals': 1.2,

  // Major publishers
  'Elsevier': 1.1,
  'Springer': 1.1,

  // Mega-journals
  'Scientific Reports': 0.75,

  // Preprints
  'bioRxiv': 0.6,
  'medRxiv': 0.6,
  'bioRxiv/medRxiv': 0.6,

  // Low-impact open access
  'Frontiers': 0.5,
  'MDPI': 0.5,
  'Hindawi': 0.45,
  'iCell': 0.4,

  // Mixed quality search
  'Google Scholar': 0.7,

  // Unknown
  'Unknown Source': 0.2,
};

/**
 * Get source weight multiplier with fuzzy matching.
 * Matches partial source names for flexibility.
 */
export const getSourceMultiplier = (source: string): number => {
  const lowerSource = source.toLowerCase();

  // Exact match first
  if (SOURCE_WEIGHT_MULTIPLIERS[source]) {
    return SOURCE_WEIGHT_MULTIPLIERS[source];
  }

  // FLAGSHIP JOURNALS - Highest tier (1.5x)
  // Exact match only for flagship journals to distinguish from subsidiary journals
  if (lowerSource === 'nature') return 1.5;
  if (lowerSource === 'cell') return 1.5;
  if (lowerSource === 'science') return 1.5;

  // Top-tier journals (1.3x)
  if (lowerSource.includes('lancet')) return 1.3;
  if (lowerSource.includes('nejm') || lowerSource.includes('new england journal of medicine')) return 1.3;

  // Nature subsidiary journals (1.3x)
  if (lowerSource.startsWith('nature ') || lowerSource.includes('nature communications') ||
      lowerSource.includes('nature medicine') || lowerSource.includes('nature genetics')) return 1.3;
  
  if (lowerSource.includes('communications biology')) return 1.0;
  if (lowerSource.includes('advanced science')) return 1.0;

  // Cell Press flagship journals (1.3x)
  if (lowerSource.includes('immunity')) return 1.3;
  if (lowerSource.includes('neuron')) return 1.3;
  if (lowerSource.includes('developmental cell')) return 1.3;
  if (lowerSource.includes('molecular cell')) return 1.3;
  if (lowerSource.includes('cancer cell')) return 1.3;

  // Cell Press subsidiary journals (1.2x)
  if (lowerSource.includes('cell stem cell') || lowerSource.includes('cell reports') ||
      lowerSource.includes('cell metabolism') || lowerSource.includes('cell systems') ||
      lowerSource.includes('cell genomics') || lowerSource.includes('cell chemical biology') ||
      lowerSource.includes('cell host') || lowerSource.includes('iscience') ||
      lowerSource.includes('star protocols') || lowerSource.includes('structure')) return 1.2;

  // Science subsidiary journals (1.3x)
  if (lowerSource.startsWith('science ') || lowerSource.includes('science translational') ||
      lowerSource.includes('science immunology') || lowerSource.includes('science signaling')) return 1.3;

  // High-quality specialty journals (1.2x)
  if (lowerSource.includes('pnas')) return 1.2;
  if (lowerSource.includes('jama')) return 1.2;

  // AHA flagship journals (1.3x) - must check before subsidiaries
  if (lowerSource === 'circulation' || lowerSource === 'circulation research') return 1.3;
  if (lowerSource.includes('circulation research')) return 1.3;

  // AHA subsidiary journals (1.2x)
  if (lowerSource.includes('hypertension')) return 1.2;
  if (lowerSource.includes('stroke')) return 1.2;
  if (lowerSource.includes('arteriosclerosis') || lowerSource.includes('atvb')) return 1.2;

  // Generic Circulation match (for variations) (1.3x)
  if (lowerSource.includes('circulation')) return 1.3;

  // AHA Journals (general fallback) (1.2x)
  if (lowerSource.includes('aha') || lowerSource.includes('heart')) return 1.2;

  // Known preprint servers
  if (lowerSource.includes('biorxiv') || lowerSource.includes('medrxiv') || lowerSource.includes('arxiv')) return 0.6;

  // Google Scholar - mixed quality, general search results
  if (lowerSource.includes('google') || lowerSource.includes('scholar')) return 0.7;

  // Low-impact open access journals
  if (lowerSource.includes('frontiers')) return 0.5;
  if (lowerSource.includes('mdpi')) return 0.5;
  if (lowerSource.includes('hindawi')) return 0.45;
  if (lowerSource.includes('icell')) return 0.4;
  if (lowerSource.includes('scientific reports')) return 0.75;

  // Conference papers (usually less rigorous than journals)
  if (lowerSource.includes('conference') || lowerSource.includes('proceedings') || lowerSource.includes('symposium')) return 0.8;

  // Default for unrecognized sources (books, unknown journals, etc.)
  return 0.2;
};

/**
 * Apply source-based weight to a paper's relevance score.
 * Adjusts the raw AI score based on source credibility.
 */
const applySourceWeight = (paper: Paper): Paper => {
  const source = paper.source || 'Unknown Source';
  const multiplier = getSourceMultiplier(source);
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
 * Apply keyword adjustments to all papers in array
 * This adds deterministic bonus/penalty points based on keyword matches
 */
const applyKeywordAdjustments = (papers: Paper[], keywords: string[], penaltyKeywords: string[] = []): Paper[] => {
  return papers.map(paper => {
    const { bonus, matchedKeywords, matchedPenalties } = calculateKeywordBonus(
      paper.title,
      paper.snippet || '',
      keywords,
      penaltyKeywords
    );

    // Apply bonus to relevance score (capped at 0-100)
    const adjustedScore = Math.max(0, Math.min(100, paper.relevanceScore + bonus));

    return {
      ...paper,
      relevanceScore: adjustedScore,
      matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : paper.matchedKeywords
    };
  });
};

/**
 * Calculate keyword bonus for a paper based on title and snippet matches.
 * This adds deterministic bonus points on top of AI-generated base scores.
 *
 * Bonus structure:
 * - Exact keyword in title: +20
 * - Partial word match in title (>3 chars): +10
 * - Exact keyword in snippet: +10
 * - Partial word match in snippet (>3 chars): +5
 *
 * Penalty structure (for irrelevant research areas):
 * - Exact penalty keyword in title: -25
 * - Exact penalty keyword in snippet: -15
 */
export interface KeywordBonusResult {
  bonus: number;
  matchedKeywords: string[];
  matchedPenalties: string[];
}

/**
 * Check if at least N words from the keyword appear in the text.
 * For multi-word keywords, requires stronger matching than single word.
 */
const countMatchingWords = (text: string, words: string[]): number => {
  return words.filter(w => text.includes(w)).length;
};

/**
 * Check if two words appear near each other in text (within ~50 chars).
 * This helps match phrases like "virtual cell" even if not exactly adjacent.
 */
const wordsAppearTogether = (text: string, word1: string, word2: string): boolean => {
  const idx1 = text.indexOf(word1);
  const idx2 = text.indexOf(word2);
  if (idx1 === -1 || idx2 === -1) return false;
  // Check if words are within 50 characters of each other
  return Math.abs(idx1 - idx2) <= 50;
};

export const calculateKeywordBonus = (title: string, snippet: string, keywords: string[], penaltyKeywords: string[] = []): KeywordBonusResult => {
  let bonus = 0;
  const matchedKeywords: string[] = [];
  const matchedPenalties: string[] = [];
  const titleLower = title.toLowerCase();
  const snippetLower = (snippet || '').toLowerCase();

  // Apply positive bonuses for keywords
  for (const keyword of keywords) {
    const kwLower = keyword.toLowerCase();
    // Split keyword into words, filter out short words (<=3 chars)
    const kwWords = kwLower.split(/[\s\-]+/).filter(w => w.length > 3);
    const isSingleWord = kwWords.length <= 1;

    let keywordMatched = false;

    // Check title for exact keyword match (full phrase)
    if (titleLower.includes(kwLower)) {
      bonus += 20;
      keywordMatched = true;
    }
    // Check title for partial match
    else if (isSingleWord) {
      // Single-word keyword: match if the word appears
      if (kwWords.length === 1 && titleLower.includes(kwWords[0])) {
        bonus += 10;
        keywordMatched = true;
      }
    } else {
      // Multi-word keyword: require at least 2 words to appear together
      const matchCount = countMatchingWords(titleLower, kwWords);
      if (matchCount >= 2) {
        // Check if at least 2 words appear near each other
        let foundPair = false;
        for (let i = 0; i < kwWords.length && !foundPair; i++) {
          for (let j = i + 1; j < kwWords.length && !foundPair; j++) {
            if (wordsAppearTogether(titleLower, kwWords[i], kwWords[j])) {
              foundPair = true;
            }
          }
        }
        if (foundPair) {
          bonus += 10;
          keywordMatched = true;
        }
      }
    }

    // Check snippet for exact keyword match
    if (snippetLower.includes(kwLower)) {
      bonus += 10;
      keywordMatched = true;
    }
    // Check snippet for partial match
    else if (isSingleWord) {
      // Single-word keyword: match if the word appears
      if (kwWords.length === 1 && snippetLower.includes(kwWords[0])) {
        bonus += 5;
        keywordMatched = true;
      }
    } else {
      // Multi-word keyword: require at least 2 words to appear together
      const matchCount = countMatchingWords(snippetLower, kwWords);
      if (matchCount >= 2) {
        let foundPair = false;
        for (let i = 0; i < kwWords.length && !foundPair; i++) {
          for (let j = i + 1; j < kwWords.length && !foundPair; j++) {
            if (wordsAppearTogether(snippetLower, kwWords[i], kwWords[j])) {
              foundPair = true;
            }
          }
        }
        if (foundPair) {
          bonus += 5;
          keywordMatched = true;
        }
      }
    }

    if (keywordMatched) {
      matchedKeywords.push(keyword);
    }
  }

  // Apply penalties for irrelevant research areas
  for (const penaltyKw of penaltyKeywords) {
    const pkwLower = penaltyKw.toLowerCase();

    // Check title for penalty keyword (exact match only for penalties)
    if (titleLower.includes(pkwLower)) {
      bonus -= 25;
      if (!matchedPenalties.includes(penaltyKw)) {
        matchedPenalties.push(penaltyKw);
      }
    }

    // Check snippet for penalty keyword
    if (snippetLower.includes(pkwLower)) {
      bonus -= 15;
      if (!matchedPenalties.includes(penaltyKw)) {
        matchedPenalties.push(penaltyKw);
      }
    }
  }

  return { bonus, matchedKeywords, matchedPenalties };
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

      // For network errors, wait progressively longer
      if (parsed.type === 'network' && attempt < maxRetries) {
        const waitTime = Math.min(2000 * Math.pow(2, attempt), 60000); // 4s, 8s, 16s, max 60s
        logger.warn(`Network error. Waiting ${waitTime}ms before retry...`);
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
  maxPapers: number = 200,
  penaltyKeywords: string[] = []
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  // NEW: Use ArticleExtractor for intelligent pre-processing
  // This extracts exact titles from HTML structure, reducing content by ~98%

  interface ExtractedArticleInfo {
    title: string;
    authors?: string;
    abstract?: string;
    doi?: string;
    journal: string;
  }

  const allExtractedArticles: ExtractedArticleInfo[] = [];

  // Parse email sections and extract articles using cheerio
  const emailBoundary = /--- EMAIL ID: ([^\n]+) ---/g;
  const sections = rawEmails.split(emailBoundary);

  for (let i = 1; i < sections.length; i += 2) {
    const emailBody = sections[i + 1] || '';
    if (!emailBody.trim()) continue;

    // Extract email metadata
    const fromMatch = emailBody.match(/From:\s*([^\n]+)/i);
    const subjectMatch = emailBody.match(/Subject:\s*([^\n]+)/i);
    const fromLine = fromMatch ? fromMatch[1] : '';
    const subjectLine = subjectMatch ? subjectMatch[1] : '';

    try {
      const extractedArticles = extractArticlesFromEmail(emailBody, fromLine, subjectLine);
      for (const article of extractedArticles) {
        allExtractedArticles.push({
          title: article.title,
          authors: article.authors,
          abstract: article.abstract,
          doi: article.doi,
          journal: article.journal || 'Unknown'
        });
      }
    } catch (extractError: any) {
      logger.warn(`Article extraction failed for ${fromLine.substring(0, 30)}, will use raw content`);
    }
  }

  logger.info(`[ArticleExtractor] Pre-extracted ${allExtractedArticles.length} articles from emails`);

  // Build optimized content from extracted articles
  let structuredContent = '';
  let linkMap = new Map<string, string>();
  let snippetMap = new Map<string, string>();
  const hasExtractedArticles = allExtractedArticles.length > 0;

  if (hasExtractedArticles) {
    // Use extracted articles - more token-efficient and accurate
    structuredContent = allExtractedArticles.map((article, idx) => {
      let articleBlock = `--- ARTICLE ${idx + 1} ---\n`;
      articleBlock += `TITLE: ${article.title}\n`;
      articleBlock += `SOURCE: ${article.journal}\n`;
      if (article.authors) articleBlock += `AUTHORS: ${article.authors}\n`;
      if (article.abstract) articleBlock += `ABSTRACT: ${article.abstract}\n`;
      if (article.doi) articleBlock += `DOI: ${article.doi}\n`;
      return articleBlock;
    }).join('\n\n');
  } else {
    // Fallback to old preprocessing if extraction found nothing
    logger.warn('[ArticleExtractor] No articles extracted, falling back to raw preprocessing');

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

    const linkResult = preprocessLinks(processedEmails);
    linkMap = linkResult.linkMap;
    const snippetResult = preprocessSnippets(linkResult.processedContent);
    snippetMap = snippetResult.snippetMap;
    structuredContent = snippetResult.processedContent;
  }

  // Build prompt based on whether we have extracted articles or raw content
  const prompt = hasExtractedArticles ? `
    Analyze the following pre-extracted academic papers from email alerts.

    **IMPORTANT: TITLES ARE PRE-EXTRACTED**
    - The TITLE field for each article has been extracted directly from the email HTML.
    - You MUST use these titles EXACTLY as provided - do NOT modify, paraphrase, or "improve" them.
    - Copy the title character-for-character into your output.

    **YOUR TASKS:**
    1. For each article, create a paper entry with the EXACT title provided.
    2. Parse the AUTHORS field (if present) into an array of up to 3 author names.
    3. Use the SOURCE field as the paper's source.
    4. Use the ABSTRACT field (if present) as the snippet, otherwise use empty string "".
    5. **Score** each paper based on relevance to these keywords: ${keywords.join(", ")}.
       - 80-100: Directly addresses keywords
       - 60-79: Contains related terms/concepts
       - 40-59: Tangentially related
       - 20-39: Weak connection
       - 0-19: Not relevant
    6. Include ALL papers regardless of relevance score (we filter later).
    7. SORT papers by relevance score descending.
    8. Generate a cohesive summary and academic-style review report.

    **EXTRACTED ARTICLES:**
    ${structuredContent}
  ` : `
    Analyze the following raw content from academic alert emails (e.g., Google Scholar, openRxiv, Nature Alerts).

    **IMPORTANT TOKEN-SAVING PLACEHOLDERS:**
    - Text snippets/descriptions have been replaced with placeholders like [S0], [S1], etc.

    **SOURCE DETECTION:**
    1. **Google Scholar emails**: Extract the ACTUAL journal/conference name from the citation line.
       - Citation format: "Authors - Journal Name, Year" or "Authors - Conference Name, Year"
       - Extract the text between the first " - " and the year (4-digit number like 2025, 2026)
       - Examples:
         * "L Simone, YF Ferrari Chen - Applied Artificial Intelligence, 2026" → source: "Applied Artificial Intelligence"
         * "J Smith - Nature Communications, 2025" → source: "Nature Communications"
         * "A Chen - bioRxiv 2026" → source: "bioRxiv"
       - Validation rules:
         * Must be longer than 3 characters
         * Should not be just numbers or punctuation (like "123", "...")
         * Should not contain ellipsis "..." or "…" (indicates truncated text)
         * If invalid, fallback to "Google Scholar"
       - IMPORTANT: "Google Scholar" is NOT a valid journal name - always extract the actual source

    2. **Nature emails**: Check the "Subject:" field for specific Nature journal names:
       - "Nature Medicine", "Nature Aging", "Nature Communications", "Nature Genetics", etc.
       - If subject contains a Nature journal name, use that as the source
       - Otherwise use "Nature"

    3. **Other sources**: Use the "From:" field:
       - openRxiv-mailer@alerts.highwire.org → "bioRxiv/medRxiv"
       - cellpress@notification.elsevier.com → "Cell Press"
       - ahajournals@ealerts.heart.org → "AHA Journals"
       - For unknown senders, use the domain name

    **SOURCES WITHOUT ABSTRACTS:**
    - bioRxiv/medRxiv, AHA Journals, and Cell Press emails typically do NOT contain abstracts/snippets.
    - For papers from these sources, use an **empty string ""** for the snippet field.

    1. **Extract ALL academic papers mentioned** up to ${maxPapers} papers.
    2. For each paper: title, authors (max 3), snippet (placeholder or ""), source.
    3. **Score** relevance to keywords: ${keywords.join(", ")} (0-100 scale).
    4. SORT by relevance score descending.
    5. Generate summary and academic-style review report.

    Content:
    ${structuredContent}
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
  const estimatedTokens = estimateTokens(structuredContent);
  logger.info(`Estimated tokens for content: ${estimatedTokens}${hasExtractedArticles ? ' (using extracted articles)' : ''}`);

  if (estimatedTokens > MAX_INPUT_TOKENS) {
    logger.warn(`Content exceeds token limit (${estimatedTokens} > ${MAX_INPUT_TOKENS}), processing in chunks...`);
    return processInChunks(rawEmails, keywords, maxPapers, penaltyKeywords, linkMap, snippetMap);
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

  // Helper to process result based on whether we used extracted articles
  const processResult = (result: any) => {
    if (hasExtractedArticles) {
      // No placeholder restoration needed - titles/abstracts are already in final form
      result.papers = applySourceWeights(result.papers);
      result.papers = applyKeywordAdjustments(result.papers, keywords, penaltyKeywords);
    } else {
      // Restore placeholders for raw content processing
      result.papers = restoreData(result.papers, linkMap, snippetMap);
      result.papers = applySourceWeights(result.papers);
      result.papers = applyKeywordAdjustments(result.papers, keywords, penaltyKeywords);
    }
    return result;
  };

  try {
    // Try primary model first with retry
    try {
      const result = await generateWithRetry('gemini-3-flash-preview');
      processResult(result);
      logger.success(`Successfully extracted ${result.papers.length} papers (with source weights + keyword adjustments)`);
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
        return processInChunks(rawEmails, keywords, maxPapers, penaltyKeywords, linkMap, snippetMap);
      }

      logger.warn(`Primary model failed, attempting fallback... ${parsed.message}`);

      // Fallback to pro model with retry
      try {
        const result = await generateWithRetry('gemini-3-pro-preview');
        processResult(result);
        logger.success(`Successfully extracted ${result.papers.length} papers (fallback, with source weights applied)`);
        return result;
      } catch (fallbackError: any) {
        const fallbackParsed = parseGeminiError(fallbackError);

        // If fallback also hits token limit, try chunking
        if (fallbackParsed.type === 'token_limit') {
          logger.warn('Fallback also hit token limit, switching to chunked processing...');
          return processInChunks(rawEmails, keywords, maxPapers, penaltyKeywords, linkMap, snippetMap);
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
  penaltyKeywords: string[] = [],
  globalLinkMap: Map<string, string> = new Map(),
  globalSnippetMap: Map<string, string> = new Map()
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
      
      const result = await processScholarEmails(chunk, keywords, chunkMaxPapers, penaltyKeywords);
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

  // Sort by relevance (source weights + keyword adjustments already applied per-chunk) and limit
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
 * Uses ArticleExtractor for intelligent pre-processing.
 * Uses a simpler schema that works better with proxy connections.
 */
export const processScholarEmailsLightweight = async (
  rawEmails: string,
  keywords: string[],
  maxPapers: number = 200,
  penaltyKeywords: string[] = []
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  logger.info('[Lightweight] Starting lightweight email processing with ArticleExtractor...');

  // Use ArticleExtractor for intelligent pre-processing
  interface ExtractedArticleInfo {
    title: string;
    authors?: string;
    abstract?: string;
    doi?: string;
    journal: string;
  }

  const allExtractedArticles: ExtractedArticleInfo[] = [];

  // Parse email sections and extract articles using cheerio
  const emailBoundary = /--- EMAIL ID: ([^\n]+) ---/g;
  const sections = rawEmails.split(emailBoundary);

  for (let i = 1; i < sections.length; i += 2) {
    const emailBody = sections[i + 1] || '';
    if (!emailBody.trim()) continue;

    const fromMatch = emailBody.match(/From:\s*([^\n]+)/i);
    const subjectMatch = emailBody.match(/Subject:\s*([^\n]+)/i);
    const fromLine = fromMatch ? fromMatch[1] : '';
    const subjectLine = subjectMatch ? subjectMatch[1] : '';

    try {
      const extractedArticles = extractArticlesFromEmail(emailBody, fromLine, subjectLine);
      for (const article of extractedArticles) {
        allExtractedArticles.push({
          title: article.title,
          authors: article.authors,
          abstract: article.abstract,
          doi: article.doi,
          journal: article.journal || 'Unknown'
        });
      }
      logger.info(`[Lightweight] Extracted ${extractedArticles.length} articles from ${fromLine.substring(0, 40)}`);
    } catch (extractError: any) {
      logger.warn(`[Lightweight] Article extraction failed for ${fromLine.substring(0, 30)}`);
    }
  }

  logger.info(`[Lightweight] Total pre-extracted: ${allExtractedArticles.length} articles`);

  // If ArticleExtractor found articles, use structured content
  if (allExtractedArticles.length > 0) {
    // Build structured content for AI processing
    const structuredContent = allExtractedArticles.map((article, idx) => {
      let block = `[${idx + 1}] TITLE: ${article.title}\n`;
      block += `SOURCE: ${article.journal}\n`;
      if (article.authors) block += `AUTHORS: ${article.authors}\n`;
      if (article.abstract) block += `ABSTRACT: ${article.abstract}\n`;
      return block;
    }).join('\n');

    const estimatedTokens = estimateTokens(structuredContent);
    logger.info(`[Lightweight] Structured content: ${(structuredContent.length / 1024).toFixed(1)} KB (~${estimatedTokens} tokens)`);

    // Single API call with all extracted articles
    const prompt = `You are an academic paper relevance scorer. Score these pre-extracted papers.

**IMPORTANT: TITLES ARE PRE-EXTRACTED - USE THEM EXACTLY AS PROVIDED**

For each paper, output:
- title: COPY the TITLE field EXACTLY (do not modify)
- authors: COPY the AUTHORS field (or empty if not present)
- source: COPY the SOURCE field EXACTLY
- relevanceScore: 0-100 based on relevance to: ${keywords.join(", ")}
  * 80-100: Directly addresses keywords
  * 60-79: Related terms/concepts
  * 40-59: Tangentially related
  * 20-39: Weak connection
  * 0-19: Not relevant

**EXTRACTED ARTICLES:**
${structuredContent}`;

    const simpleSchema = {
      type: Type.OBJECT,
      properties: {
        papers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              authors: { type: Type.STRING },
              source: { type: Type.STRING },
              relevanceScore: { type: Type.NUMBER }
            }
          }
        }
      }
    };

    try {
      const response = await executeWithRetry(async () => {
        return await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { responseMimeType: "application/json", responseSchema: simpleSchema }
        });
      }, 'gemini-3-flash-preview', 3);

      const jsonStr = response.text;
      if (!jsonStr) throw new Error("Empty response");

      const result = JSON.parse(jsonStr.trim());
      const papers: Paper[] = (result.papers || []).map((p: any, idx: number) => ({
        id: `paper-${Date.now()}-${idx}`,
        title: p.title || '',
        authors: p.authors ? p.authors.split(',').map((a: string) => a.trim()).slice(0, 3) : [],
        snippet: '',
        source: p.source || 'Unknown',
        date: new Date().toISOString().split('T')[0],
        relevanceScore: p.relevanceScore || 0,
        matchedKeywords: []
      }));

      // Apply source weights and keyword adjustments
      const weightedPapers = applySourceWeights(papers);
      const adjustedPapers = applyKeywordAdjustments(weightedPapers, keywords, penaltyKeywords);

      logger.success(`[Lightweight] Extracted ${adjustedPapers.length} papers with ArticleExtractor`);

      return {
        papers: adjustedPapers.sort((a, b) => b.relevanceScore - a.relevanceScore),
        summary: {
          overview: `Processed ${adjustedPapers.length} papers from ${allExtractedArticles.length} extracted articles.`,
          academicReport: '',
          keyTrends: [],
          topRecommendations: [],
          categorizedPapers: []
        }
      };
    } catch (error: any) {
      logger.warn(`[Lightweight] ArticleExtractor approach failed, falling back to chunking: ${error.message}`);
    }
  }

  // Fallback: Original chunking approach if ArticleExtractor didn't work
  logger.info('[Lightweight] Using fallback chunking approach...');

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

  // Helper function to detect source from email content
  const detectSourceFromContent = (content: string): string => {
    const lowerContent = content.toLowerCase();
    // Check From: header pattern
    const fromMatch = content.match(/From:\s*([^\n]+)/i);
    const fromLine = fromMatch ? fromMatch[1].toLowerCase() : '';

    if (fromLine.includes('scholar') || fromLine.includes('google')) {
      return 'Google Scholar';
    }
    if (fromLine.includes('biorxiv') || fromLine.includes('medrxiv') || fromLine.includes('highwire')) {
      return 'bioRxiv/medRxiv';
    }
    if (fromLine.includes('nature')) {
      return 'Nature';
    }
    if (fromLine.includes('cellpress') || fromLine.includes('cell.com') || fromLine.includes('elsevier')) {
      return 'Cell Press';
    }
    if (fromLine.includes('ahajournals') || fromLine.includes('heart.org')) {
      return 'AHA Journals';
    }
    if (fromLine.includes('springer')) {
      return 'Springer';
    }
    // Fallback: check content patterns
    if (lowerContent.includes('biorxiv') || lowerContent.includes('medrxiv')) {
      return 'bioRxiv/medRxiv';
    }
    if (lowerContent.includes('google scholar') || lowerContent.includes('gse_alrt')) {
      return 'Google Scholar';
    }
    return 'Unknown Source';
  };

  // Split content into smaller chunks (max 3000 chars each for reliability)
  // Track the source for each chunk
  const MAX_CHUNK_SIZE = 3000;
  interface ChunkWithSource {
    content: string;
    source: string;
  }
  const contentChunks: ChunkWithSource[] = [];

  // First, split by email boundaries to preserve source information
  const fallbackBoundary = /--- EMAIL ID: [^\n]+ ---/g;
  const emailSections = finalContent.split(fallbackBoundary).filter(s => s.trim());

  for (const section of emailSections) {
    const source = detectSourceFromContent(section);

    // For bioRxiv emails, split by paper entries (look for "doi:" patterns)
    // Otherwise split by size
    const doiPattern = /(?=doi:10\.\d+)/gi;
    const paperEntries = section.split(doiPattern);

    let currentChunk = '';
    for (const entry of paperEntries) {
      if (currentChunk.length + entry.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
        contentChunks.push({ content: currentChunk.trim(), source });
        currentChunk = entry;
      } else {
        currentChunk += entry;
      }
    }
    if (currentChunk.trim()) {
      contentChunks.push({ content: currentChunk.trim(), source });
    }
  }

  // If no chunks were created, split final content by size
  if (contentChunks.length === 0) {
    const defaultSource = detectSourceFromContent(finalContent);
    for (let i = 0; i < finalContent.length; i += MAX_CHUNK_SIZE) {
      contentChunks.push({ content: finalContent.substring(i, i + MAX_CHUNK_SIZE), source: defaultSource });
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
            source: { type: Type.STRING, description: "Journal or source name (e.g., Nature, bioRxiv, Cell)" },
            relevanceScore: { type: Type.NUMBER }
          }
        }
      }
    }
  };

  const allPapers: Paper[] = [];

  // Helper function to process a single chunk
  const processChunk = async (chunk: ChunkWithSource, index: number, isRetry: boolean = false) => {
    logger.info(`[Lightweight] ${isRetry ? 'Retrying' : 'Processing'} chunk ${index + 1}/${contentChunks.length} (email source: ${chunk.source})...`);

    const prompt = `You are an academic paper relevance scorer. Extract academic papers from this content and score their relevance to research keywords.

For each paper, extract:
- title: the paper title
- authors: author names (comma-separated)
- source: Extract the JOURNAL or PUBLICATION name from the citation line. Citation format is "Authors - Journal Name, Year" or "Authors - Conference Name, Year". Extract the text between "-" and the year/comma. Examples:
  * "L Simone, YF Ferrari Chen - Applied Artificial Intelligence, 2026" → source: "Applied Artificial Intelligence"
  * "J Smith, K Lee - Nature Communications, 2025" → source: "Nature Communications"
  * "A Chen - bioRxiv, 2026" → source: "bioRxiv"
  IMPORTANT: "Google Scholar" is NOT a valid source - it's just an email alert service. Extract the actual journal/conference name.
- relevanceScore: Score each paper from 0-100

**Score** these papers based on their relevance to these keywords: ${keywords.join(', ')}.
- You are an academic paper relevance scorer. Assign a 'relevanceScore' from 0 to 100 using these criteria:
  * 80-100: Title/abstract directly addresses one or more keywords (e.g., paper about "organoid development" matches "organoid")
  * 60-79: Title/abstract contains related terms or concepts (e.g., "aortic aneurysm" relates to "Aortic Disease", "Marfan" relates to "Marfan Syndrome")
  * 40-59: Tangentially related to the research areas (e.g., general cardiovascular paper when keywords include "vascular")
  * 20-39: Weak connection to keywords (e.g., uses similar techniques but different disease area)
  * 0-19: Not relevant to the keywords
- **IMPORTANT:** Do NOT filter out or omit papers that do not match the keywords. Include them with a lower score (e.g., 0-19) if they are unrelated.

Content to analyze:
${chunk.content}`;

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
      let chunkPapersCount = 0;
      for (const p of result.papers) {
        if (p.title && p.title.length > 10) {
          // Use AI-extracted source, but reject "Google Scholar" as it's not a real journal
          // Also reject sources that are too short or invalid
          let paperSource = p.source && p.source.length > 2 ? p.source : null;
          if (paperSource && paperSource.toLowerCase().includes('google scholar')) {
            paperSource = null; // Reject Google Scholar as source
          }
          // Fallback: use email source (Google Scholar gets 0.7 weight penalty)
          if (!paperSource) {
            paperSource = chunk.source;
          }

          // Calculate keyword bonus (deterministic boost based on keyword matches)
          // Use chunk content as "snippet" since we don't extract snippets separately
          const snippetFromChunk = chunk.content.substring(0, 1000); // Use first 1000 chars as context
          const { bonus, matchedKeywords, matchedPenalties } = calculateKeywordBonus(p.title, snippetFromChunk, keywords, penaltyKeywords);

          // Apply no-match penalty only for non-preprint sources
          // Preprints (bioRxiv, medRxiv) already have heavy source weight penalty
          const sourceLower = paperSource.toLowerCase();
          const isPreprint = sourceLower.includes('biorxiv') || sourceLower.includes('medrxiv') || sourceLower.includes('arxiv');
          const noMatchPenalty = (matchedKeywords.length === 0 && !isPreprint) ? -20 : 0;

          // Final score = AI base score + keyword bonus + no-match penalty (capped at 100, min 0)
          const baseScore = Math.round(p.relevanceScore || 0);
          const finalScore = Math.max(0, Math.min(100, baseScore + bonus + noMatchPenalty));

          const paper: Paper = {
            id: `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: p.title,
            authors: p.authors ? p.authors.split(',').map((a: string) => a.trim()).slice(0, 3) : [],
            snippet: '',
            link: '',
            source: paperSource,
            date: new Date().toISOString().split('T')[0],
            relevanceScore: finalScore,
            matchedKeywords: matchedKeywords
          };
          allPapers.push(paper);
          chunkPapersCount++;
        }
      }
      logger.info(`[Lightweight] Chunk ${index + 1}: extracted ${chunkPapersCount} papers`);
    }
  };

  const failedChunks: { index: number; chunk: ChunkWithSource }[] = [];

  // Initial pass
  for (let i = 0; i < contentChunks.length; i++) {
    try {
      await processChunk(contentChunks[i], i);
    } catch (chunkError: any) {
      logger.error(`[Lightweight] Chunk ${i + 1} failed:`, chunkError.message);
      failedChunks.push({ index: i, chunk: contentChunks[i] });
    }

    // Delay between chunks to avoid rate limiting
    if (i < contentChunks.length - 1) {
      await delay(2000);
    }
  }

  // Retry pass for failed chunks
  if (failedChunks.length > 0) {
    logger.warn(`[Lightweight] ${failedChunks.length} chunks failed. Waiting 5s before retrying...`);
    await delay(5000);

    for (const { index, chunk } of failedChunks) {
      try {
        await processChunk(chunk, index, true);
      } catch (retryError: any) {
        logger.error(`[Lightweight] Retry for chunk ${index + 1} failed permanently:`, retryError.message);
      }
      // Delay between retries
      await delay(2000);
    }
  }

  // Deduplicate, apply source weights, and apply keyword adjustments
  const dedupedPapers = deduplicatePapers(allPapers);
  const weightedPapers = applySourceWeights(dedupedPapers);
  const adjustedPapers = applyKeywordAdjustments(weightedPapers, keywords, penaltyKeywords);

  // Sort by relevance and limit
  const sortedPapers = adjustedPapers
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxPapers);

  logger.success(`[Lightweight] Complete: ${sortedPapers.length} unique papers (with source weights + keyword adjustments)`);

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

/**
 * Score pre-extracted articles without re-running ArticleExtractor.
 * This is used by the scheduler after it extracts articles using emailArticleExtractor.
 * Much more efficient than processScholarEmailsLightweight for pre-extracted content.
 */
export interface PreExtractedArticle {
  title: string;
  authors?: string;
  abstract?: string;
  journal: string;
  doi?: string;
}

export const scoreExtractedArticles = async (
  articles: PreExtractedArticle[],
  keywords: string[],
  maxPapers: number = 200,
  penaltyKeywords: string[] = []
): Promise<{ papers: Paper[] }> => {
  if (articles.length === 0) {
    return { papers: [] };
  }

  logger.info(`[ScoreArticles] Scoring ${articles.length} pre-extracted articles...`);

  // Log source distribution for debugging
  const sourceCount = new Map<string, number>();
  articles.forEach(article => {
    const source = article.journal || 'Unknown';
    sourceCount.set(source, (sourceCount.get(source) || 0) + 1);
  });
  logger.info(`[ScoreArticles] Source distribution: ${JSON.stringify(Array.from(sourceCount.entries()))}`);

  // Build structured content for AI processing
  const structuredContent = articles.map((article, idx) => {
    let block = `[${idx + 1}] TITLE: ${article.title}\n`;
    block += `SOURCE: ${article.journal}\n`;
    if (article.authors) block += `AUTHORS: ${article.authors}\n`;
    if (article.abstract) block += `ABSTRACT: ${article.abstract}\n`;
    return block;
  }).join('\n');

  const estimatedTokens = estimateTokens(structuredContent);
  logger.info(`[ScoreArticles] Content: ${(structuredContent.length / 1024).toFixed(1)} KB (~${estimatedTokens} tokens)`);

  const prompt = `You are an academic paper relevance scorer. Score these pre-extracted papers.

**CRITICAL RULES:**
1. Output ONLY valid JSON - NO explanations, NO reasoning, NO chain-of-thought
2. Copy TITLE, AUTHORS, and SOURCE fields EXACTLY as provided - do not modify them
3. Only the relevanceScore field should be your judgment (0-100)

**SCORING GUIDE:**
- 80-100: Directly addresses keywords
- 60-79: Related terms/concepts
- 40-59: Tangentially related
- 20-39: Weak connection
- 0-19: Not relevant

**Keywords to evaluate against:** ${keywords.join(", ")}

**EXTRACTED ARTICLES:**
${structuredContent}`;

  const simpleSchema = {
    type: Type.OBJECT,
    properties: {
      papers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "Copy exactly from TITLE field" },
            authors: { type: Type.STRING, description: "Copy exactly from AUTHORS field" },
            source: { type: Type.STRING, description: "Copy exactly from SOURCE field" },
            relevanceScore: { type: Type.NUMBER, description: "0-100 relevance score" }
          },
          required: ["title", "source", "relevanceScore"]
        }
      }
    },
    required: ["papers"]
  };

  try {
    const response = await executeWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: simpleSchema }
      });
    }, 'gemini-3-flash-preview', 3);

    const jsonStr = response.text;
    if (!jsonStr) throw new Error("Empty response");

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseError: any) {
      logger.error(`[ScoreArticles] Failed to parse JSON: ${parseError.message}`);
      logger.error(`[ScoreArticles] Response (first 500 chars): ${jsonStr.substring(0, 500)}`);
      throw new Error(`Invalid JSON from AI: ${parseError.message}`);
    }

    if (!parsed.papers || !Array.isArray(parsed.papers)) {
      throw new Error("Invalid response structure - missing papers array");
    }

    logger.info(`[ScoreArticles] AI returned ${parsed.papers.length} papers`);

    // Create multiple lookup keys for fuzzy matching
    const articleMap = new Map<string, PreExtractedArticle>();
    const normalizeTitle = (title: string): string => {
      return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .replace(/\s+/g, ' ');   // Normalize whitespace
    };

    articles.forEach(article => {
      // Add exact lowercase key
      articleMap.set(article.title.toLowerCase().trim(), article);
      // Add normalized key (no punctuation)
      articleMap.set(normalizeTitle(article.title), article);
    });

    // Helper function to find matching article with fuzzy matching
    const findOriginalArticle = (aiTitle: string): PreExtractedArticle | undefined => {
      const lowerTitle = aiTitle.toLowerCase().trim();
      const normalizedTitle = normalizeTitle(aiTitle);

      // Try exact match first
      if (articleMap.has(lowerTitle)) {
        return articleMap.get(lowerTitle);
      }

      // Try normalized match (no punctuation)
      if (articleMap.has(normalizedTitle)) {
        return articleMap.get(normalizedTitle);
      }

      // Try substring matching - find article whose title contains or is contained by AI title
      for (const article of articles) {
        const articleLower = article.title.toLowerCase().trim();
        const articleNorm = normalizeTitle(article.title);

        // Check if one contains the other (for truncated titles)
        if (articleLower.includes(lowerTitle) || lowerTitle.includes(articleLower)) {
          return article;
        }
        if (articleNorm.includes(normalizedTitle) || normalizedTitle.includes(articleNorm)) {
          return article;
        }

        // Check if first 50 chars match (handles slight ending differences)
        if (articleLower.substring(0, 50) === lowerTitle.substring(0, 50)) {
          return article;
        }
      }

      return undefined;
    };

    const papers: Paper[] = (parsed.papers || [])
      .map((p: any) => {
        // First, clean any chain-of-thought reasoning that leaked into the title
        // This happens when the AI includes its scoring rationale in the output
        if (p.title && typeof p.title === 'string') {
          // Patterns that indicate chain-of-thought reasoning leaked into title
          const cotPatterns = [
            /Reference to arterial\/vascular.*/i,
            /Score is moderate.*/i,
            /Score:?\s*\d+.*/i,
            /\(Weak connection\).*/i,
            /\(Tangentially related\).*/i,
            /\(Related terms\).*/i,
            /Wait,\s+.*/i,
            /Let's use.*/i,
            /Let's score.*/i,
            /Actually,\s+.*/i,
            /Adjusting to.*/i,
            /\bRelevant as\b.*/i,
            /\bAdjusted score\b.*/i,
            /\bFinal selection\b.*/i,
          ];

          for (const pattern of cotPatterns) {
            if (pattern.test(p.title)) {
              const cleanedTitle = p.title.replace(pattern, '').trim();
              if (cleanedTitle.length > 10 && cleanedTitle.length < p.title.length) {
                logger.warn(`[ScoreArticles] Cleaned chain-of-thought from title: "${p.title.substring(0, 60)}..." -> "${cleanedTitle.substring(0, 60)}..."`);
                p.title = cleanedTitle;
              }
            }
          }
        }

        // Try to recover malformed papers where fields got concatenated
        if (p.title && typeof p.title === 'string' &&
            (p.title.includes('"authors":') || p.title.includes('"source":') || p.title.includes('"relevanceScore":'))) {

          const titlePreview = p.title.length > 100 ? p.title.substring(0, 100) + '...' : p.title;
          logger.warn(`[ScoreArticles] Attempting to recover malformed paper: ${titlePreview}`);

          // Try to extract the actual title (everything before ", "authors":)
          let actualTitle = p.title;
          const authorsMatch = p.title.match(/^(.*?)"\s*,\s*"authors":/);
          if (authorsMatch) {
            actualTitle = authorsMatch[1].trim();
          } else {
            // Try other field separators
            const sourceMatch = p.title.match(/^(.*?)"\s*,\s*"source":/);
            const scoreMatch = p.title.match(/^(.*?)"\s*,\s*"relevanceScore":/);
            if (sourceMatch) actualTitle = sourceMatch[1].trim();
            else if (scoreMatch) actualTitle = scoreMatch[1].trim();
          }

          // Try to extract authors if present in the concatenated string
          let actualAuthors = p.authors || '';
          const authorsExtract = p.title.match(/"authors":\s*"([^"]+)"/);
          if (authorsExtract) {
            actualAuthors = authorsExtract[1];
          }

          // Try to extract source if present
          let actualSource = p.source || '';
          const sourceExtract = p.title.match(/"source":\s*"([^"]+)"/);
          if (sourceExtract) {
            actualSource = sourceExtract[1];
          }

          // Try to extract relevance score if present
          let actualScore = p.relevanceScore || 0;
          const scoreExtract = p.title.match(/"relevanceScore":\s*(\d+)/);
          if (scoreExtract) {
            actualScore = parseInt(scoreExtract[1], 10);
          }

          logger.info(`[ScoreArticles] Recovered: "${actualTitle.substring(0, 60)}${actualTitle.length > 60 ? '...' : ''}"`);

          return {
            ...p,
            title: actualTitle,
            authors: actualAuthors,
            source: actualSource,
            relevanceScore: actualScore
          };
        }

        return p;
      })
      .filter((p: any) => {
        // Now filter out papers that still don't have valid titles after recovery
        if (!p.title || typeof p.title !== 'string' || p.title.trim() === '') {
          logger.warn(`[ScoreArticles] Filtered paper with missing/invalid title after recovery`);
          return false;
        }
        return true;
      })
      .map((p: any) => {
        // Match back to original article to get snippet and link using fuzzy matching
        const originalArticle = findOriginalArticle(p.title);

        if (!originalArticle) {
          logger.warn(`[ScoreArticles] Filtering hallucinated paper (no match in original): "${p.title.substring(0, 80)}"`);
          return null; // Filter out hallucinated papers
        }

        // IMPORTANT: Prefer original article's journal field over AI's source
        // The AI sometimes returns "Unknown" or doesn't preserve exact source names
        const source = originalArticle.journal || p.source || 'Unknown';

        return {
          id: `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          title: originalArticle.title, // Use original title, not AI's potentially modified version
          authors: originalArticle.authors ? originalArticle.authors.split(/,\s*/).slice(0, 3) : (p.authors ? p.authors.split(/,\s*/).slice(0, 3) : []),
          snippet: originalArticle.abstract || '',
          link: originalArticle.doi ? `https://doi.org/${originalArticle.doi}` : '',
          source: source,
          date: new Date().toISOString().split('T')[0],
          relevanceScore: p.relevanceScore || 0,
          matchedKeywords: []
        };
      })
      .filter((p: any) => p !== null);

    const filteredCount = parsed.papers.length - papers.length;
    if (filteredCount > 0) {
      logger.warn(`[ScoreArticles] Filtered out ${filteredCount} malformed papers`);
    }

    // Step 1: Apply source weights (multipliers based on journal prestige)
    const weightedPapers = applySourceWeights(papers);

    // Log source weight applications for debugging
    if (weightedPapers.length > 0) {
      const sampleWeights = weightedPapers.slice(0, 5).map(p =>
        `${p.source}=${getSourceMultiplier(p.source)}x`
      );
      logger.info(`[ScoreArticles] Sample source weights: ${sampleWeights.join(', ')}`);
    }

    // Step 2: Apply keyword bonuses and penalties (deterministic adjustments)
    const adjustedPapers = applyKeywordAdjustments(weightedPapers, keywords, penaltyKeywords);

    // Step 3: Sort by relevance and limit
    const sortedPapers = adjustedPapers
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxPapers);

    logger.success(`[ScoreArticles] Scored ${sortedPapers.length} papers (with source weights + keyword adjustments)`);

    return { papers: sortedPapers };
  } catch (error: any) {
    logger.error(`[ScoreArticles] Failed: ${error.message}`);
    throw error;
  }
};

export const generateLiteratureReview = async (
  papers: Paper[],
  keywords: string[]
): Promise<string> => {
  // Clean any remaining placeholders as a safety net
  const cleanedPapers = cleanPlaceholders(papers);

  // Use single-shot approach for web app (simpler, no parallel complexity)
  return generateLiteratureReviewSingleShot(cleanedPapers, keywords);
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
