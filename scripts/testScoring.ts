#!/usr/bin/env npx tsx
/**
 * Test script to calculate the relevance score of a paper title
 * using the actual scoring logic from geminiService.ts INCLUDING Gemini AI scoring
 *
 * Usage:
 *   npx tsx scripts/testScoring.ts "Your paper title here"
 *   npx tsx scripts/testScoring.ts "Your paper title here" "Optional snippet text"
 *   npx tsx scripts/testScoring.ts "Your paper title here" "snippet" "Source Name"
 *   npx tsx scripts/testScoring.ts  # Uses default example title
 *
 * Environment:
 *   Requires VITE_GEMINI_API_KEY in .env.local or environment
 */

// Load environment variables and configure proxy FIRST
import './loadEnv.ts';

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { calculateKeywordBonus, getSourceMultiplier } from '../services/geminiService.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Gemini API
const apiKey = process.env.VITE_GEMINI_API_KEY || '';
if (!apiKey) {
  console.error('❌ Error: VITE_GEMINI_API_KEY not found in environment or .env.local');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Load keywords from keywords.json
const keywordsPath = join(__dirname, '..', 'keywords.json');
const keywordsConfig = JSON.parse(readFileSync(keywordsPath, 'utf-8'));
const keywords: string[] = keywordsConfig.keywords || [];
const penaltyKeywords: string[] = keywordsConfig.penaltyKeywords || [];

// Get title from command line args or use default
const title = process.argv[2] ||
  "Single-cell and spatial transcriptomics reveal mTOR-driven cellular fate of spindle cells and immune evasion in classic Kaposi's sarcoma";
const snippet = process.argv[3] || '';
const source = process.argv[4] || 'Unknown Source';

/**
 * Get AI base score from Gemini
 */
async function getAIBaseScore(title: string, snippet: string, keywords: string[]): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are an academic paper relevance scorer. Score this paper's relevance to the given research keywords.

Paper Title: "${title}"
${snippet ? `Snippet/Abstract: "${snippet}"` : ''}

Research Keywords: ${keywords.join(', ')}

Score from 0-100 based on:
- 80-100: Title/abstract directly addresses one or more keywords
- 60-79: Title/abstract contains related terms or concepts
- 40-59: Tangentially related to the research areas
- 20-39: Weak connection to keywords
- 0-19: Not relevant to the keywords

Return JSON with:
- score: number (0-100)
- reasoning: brief explanation (1-2 sentences)`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.NUMBER },
            reasoning: { type: Type.STRING }
          },
          required: ['score', 'reasoning']
        }
      }
    });

    const result = JSON.parse(response.text || '{"score": 30, "reasoning": "Unable to parse"}');
    return {
      score: Math.max(0, Math.min(100, Math.round(result.score))),
      reasoning: result.reasoning
    };
  } catch (error: any) {
    console.error('⚠️  Gemini API error:', error.message);
    return { score: 30, reasoning: 'Fallback score due to API error' };
  }
}

// Main async function
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ScholarPulse Score Calculator (with Gemini AI)');
  console.log('═'.repeat(80));
  console.log();

  console.log('📝 Input:');
  console.log(`   Title:   "${title}"`);
  console.log(`   Snippet: "${snippet || '(none)'}"`);
  console.log(`   Source:  "${source}"`);
  console.log();

  console.log('🔑 Keywords configured:');
  console.log(`   Positive: ${keywords.join(', ')}`);
  console.log(`   Penalty:  ${penaltyKeywords.join(', ')}`);
  console.log();

  // Get AI base score from Gemini
  console.log('🤖 Querying Gemini AI for base relevance score...');
  const aiResult = await getAIBaseScore(title, snippet, keywords);
  console.log(`   AI Score: ${aiResult.score}`);
  console.log(`   Reasoning: ${aiResult.reasoning}`);
  console.log();

  // Calculate keyword bonus using the actual function
  const result = calculateKeywordBonus(title, snippet, keywords, penaltyKeywords);

  console.log('─'.repeat(80));
  console.log('📈 Keyword Analysis:');
  console.log('─'.repeat(80));

  // Show detailed matching for each keyword
  const titleLower = title.toLowerCase();
  const snippetLower = snippet.toLowerCase();

  // Helper to check if two words appear near each other
  const wordsAppearTogether = (text: string, word1: string, word2: string): boolean => {
    const idx1 = text.indexOf(word1);
    const idx2 = text.indexOf(word2);
    if (idx1 === -1 || idx2 === -1) return false;
    return Math.abs(idx1 - idx2) <= 50;
  };

  console.log('\n  Positive Keywords:');
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    const kwWords = kwLower.split(/[\s\-]+/).filter(w => w.length > 3);
    const isSingleWord = kwWords.length <= 1;

    const exactTitle = titleLower.includes(kwLower);
    const exactSnippet = snippetLower.includes(kwLower);

    // For partial matching with new stricter rules
    let partialTitle = false;
    let partialSnippet = false;
    let matchedWordsTitle: string[] = [];
    let matchedWordsSnippet: string[] = [];

    if (!exactTitle) {
      if (isSingleWord) {
        // Single-word: just check if word appears
        if (kwWords.length === 1 && titleLower.includes(kwWords[0])) {
          partialTitle = true;
          matchedWordsTitle = [kwWords[0]];
        }
      } else {
        // Multi-word: need 2+ words appearing together
        matchedWordsTitle = kwWords.filter(w => titleLower.includes(w));
        if (matchedWordsTitle.length >= 2) {
          // Check if any pair appears together
          for (let i = 0; i < matchedWordsTitle.length && !partialTitle; i++) {
            for (let j = i + 1; j < matchedWordsTitle.length && !partialTitle; j++) {
              if (wordsAppearTogether(titleLower, matchedWordsTitle[i], matchedWordsTitle[j])) {
                partialTitle = true;
              }
            }
          }
        }
      }
    }

    if (!exactSnippet) {
      if (isSingleWord) {
        if (kwWords.length === 1 && snippetLower.includes(kwWords[0])) {
          partialSnippet = true;
          matchedWordsSnippet = [kwWords[0]];
        }
      } else {
        matchedWordsSnippet = kwWords.filter(w => snippetLower.includes(w));
        if (matchedWordsSnippet.length >= 2) {
          for (let i = 0; i < matchedWordsSnippet.length && !partialSnippet; i++) {
            for (let j = i + 1; j < matchedWordsSnippet.length && !partialSnippet; j++) {
              if (wordsAppearTogether(snippetLower, matchedWordsSnippet[i], matchedWordsSnippet[j])) {
                partialSnippet = true;
              }
            }
          }
        }
      }
    }

    let bonus = 0;
    let matchType = '';

    if (exactTitle) { bonus += 20; matchType = '✅ Exact in title (+20)'; }
    else if (partialTitle) { bonus += 10; matchType = `⚡ Partial in title (+10) [${matchedWordsTitle.join(', ')}]`; }

    if (exactSnippet) { bonus += 10; matchType += matchType ? ', Exact in snippet (+10)' : '✅ Exact in snippet (+10)'; }
    else if (partialSnippet) {
      bonus += 5; matchType += matchType ? `, Partial in snippet (+5) [${matchedWordsSnippet.join(', ')}]` : `⚡ Partial in snippet (+5) [${matchedWordsSnippet.join(', ')}]`;
    }

    if (bonus === 0) {
      const foundWords = kwWords.filter(w => titleLower.includes(w) || snippetLower.includes(w));
      if (foundWords.length === 1 && !isSingleWord) {
        console.log(`    ❌ "${kw}" → No match (only 1 word found: "${foundWords[0]}", need 2+ together)`);
      } else {
        console.log(`    ❌ "${kw}" → No match`);
      }
      console.log(`       Words checked: [${kwWords.join(', ')}]${isSingleWord ? ' (single-word)' : ' (multi-word, need 2+ together)'}`);
    } else {
      console.log(`    ${matchType.startsWith('✅') ? '✅' : '⚡'} "${kw}" → ${matchType}`);
      console.log(`       Words checked: [${kwWords.join(', ')}]${isSingleWord ? ' (single-word)' : ' (multi-word)'}`);
    }
  }

  console.log('\n  Penalty Keywords:');
  for (const pkw of penaltyKeywords) {
    const pkwLower = pkw.toLowerCase();
    const inTitle = titleLower.includes(pkwLower);
    const inSnippet = snippetLower.includes(pkwLower);

    let penalty = 0;
    if (inTitle) penalty -= 25;
    if (inSnippet) penalty -= 15;

    if (penalty === 0) {
      console.log(`    ✅ "${pkw}" → Not found (no penalty)`);
    } else {
      const where = [];
      if (inTitle) where.push('title (-25)');
      if (inSnippet) where.push('snippet (-15)');
      console.log(`    ⚠️  "${pkw}" → Found in ${where.join(', ')}`);
    }
  }

  // Get source multiplier
  const sourceMultiplier = getSourceMultiplier(source);

  console.log('\n' + '─'.repeat(80));
  console.log('🧮 Score Calculation:');
  console.log('─'.repeat(80));

  // Use the actual AI score
  const aiBaseScore = aiResult.score;
  const noMatchPenalty = (result.matchedKeywords.length === 0 &&
    !source.toLowerCase().includes('biorxiv') &&
    !source.toLowerCase().includes('medrxiv')) ? -20 : 0;

  const rawScore = Math.max(0, Math.min(100, aiBaseScore + result.bonus + noMatchPenalty));
  const finalScore = Math.min(100, Math.round(rawScore * sourceMultiplier));

  console.log(`
  🤖 AI Base Score:             ${aiBaseScore}
  + Keyword Bonus:              ${result.bonus >= 0 ? '+' : ''}${result.bonus}
  + No-match Penalty:           ${noMatchPenalty === 0 ? '0' : noMatchPenalty}
  ────────────────────────────────
  Raw Score:                    ${rawScore}

  × Source Multiplier:          ×${sourceMultiplier.toFixed(2)} (${source})
  ────────────────────────────────
  Final Score:                  ${finalScore}
`);

  console.log('─'.repeat(80));
  console.log('📋 Summary:');
  console.log('─'.repeat(80));
  console.log(`  AI Reasoning:      ${aiResult.reasoning}`);
  console.log(`  Matched Keywords:  ${result.matchedKeywords.length > 0 ? result.matchedKeywords.join(', ') : '(none)'}`);
  console.log(`  Matched Penalties: ${result.matchedPenalties.length > 0 ? result.matchedPenalties.join(', ') : '(none)'}`);
  console.log(`  Total Bonus:       ${result.bonus >= 0 ? '+' : ''}${result.bonus}`);
  console.log(`  Final Score:       ${finalScore}/100`);
  console.log();

  // Score interpretation
  let interpretation = '';
  if (finalScore >= 80) interpretation = '🌟 Highly relevant - top priority paper';
  else if (finalScore >= 60) interpretation = '👍 Relevant - worth reading';
  else if (finalScore >= 40) interpretation = '📖 Moderately relevant - skim recommended';
  else if (finalScore >= 20) interpretation = '📋 Low relevance - check if related to interests';
  else interpretation = '❌ Not relevant to configured keywords';

  console.log(`  Interpretation:    ${interpretation}`);
  console.log('═'.repeat(80));
}

// Run main
main().catch(console.error);
