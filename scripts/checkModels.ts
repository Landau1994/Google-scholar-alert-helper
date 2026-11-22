import './loadEnv.ts';
import { GoogleGenAI } from '@google/genai';
import {
  GEMINI_FLASH_MODEL,
  GEMINI_TEXT_FALLBACK_MODELS,
  GEMINI_EMBEDDING_MODEL,
  normalizeModelName,
  pickBestFlashModelFromList,
  pickBestEmbeddingModelFromList,
  type ListedModelInfo,
} from '../services/geminiModels.ts';
import { readEmbeddingMetadata } from '../services/vectorService.ts';

async function main() {
  const apiKey = process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Missing VITE_GEMINI_API_KEY in .env.local or environment.');
    process.exit(1);
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 60000 },
  });

  console.log('🔍 Checking configured Gemini models against Google Models API...\n');

  const pager: any = await ai.models.list();
  const models: ListedModelInfo[] = [];
  if (pager && typeof pager[Symbol.asyncIterator] === 'function') {
    for await (const m of pager) {
      models.push(m);
    }
  } else if (Array.isArray(pager)) {
    models.push(...pager);
  } else if (pager?.models && Array.isArray(pager.models)) {
    models.push(...pager.models);
  }

  const availableNames = new Set(models.filter(m => m.name).map(m => normalizeModelName(m.name!)));
  console.log(`📋 Retrieved ${availableNames.size} available models from Google API.\n`);

  let hasIssue = false;

  // 1. Check primary text model
  const flashAvailable = availableNames.has(normalizeModelName(GEMINI_FLASH_MODEL));
  const bestFlash = pickBestFlashModelFromList(models);
  console.log(`🧠 Text Model (Primary): ${GEMINI_FLASH_MODEL}`);
  if (flashAvailable) {
    console.log('   ✅ Available');
  } else {
    hasIssue = true;
    console.log('   ⚠️  NOT FOUND in available model list (may be deprecated or renamed)!');
    if (bestFlash) {
      console.log(`   👉 Recommended replacement: ${bestFlash}`);
    }
  }

  // Check static fallbacks
  const fallbackStatus = GEMINI_TEXT_FALLBACK_MODELS.slice(1).map(m => {
    const ok = availableNames.has(normalizeModelName(m));
    return `${m} (${ok ? '✅' : '❌'})`;
  });
  console.log(`   Fallback chain: ${fallbackStatus.join(', ') || '(none)'}`);
  if (bestFlash && bestFlash !== GEMINI_FLASH_MODEL) {
    console.log(`   ℹ️  Latest auto-detected Flash candidate: ${bestFlash}`);
  }

  // 2. Check embedding model & LanceDB metadata compatibility
  const embedAvailable = availableNames.has(normalizeModelName(GEMINI_EMBEDDING_MODEL));
  const bestEmbed = pickBestEmbeddingModelFromList(models);
  const meta = readEmbeddingMetadata();

  console.log(`\n📐 Embedding Model: ${GEMINI_EMBEDDING_MODEL}`);
  if (embedAvailable) {
    console.log('   ✅ Available');
  } else {
    hasIssue = true;
    console.log('   ⚠️  NOT FOUND in available model list (may be deprecated or renamed)!');
    if (bestEmbed) {
      console.log(`   👉 Recommended replacement: ${bestEmbed}`);
      console.log('   👉 After updating VITE_GEMINI_EMBEDDING_MODEL, run: npm run reembed');
    }
  }

  if (meta) {
    const matches = meta.model === GEMINI_EMBEDDING_MODEL;
    console.log(`   LanceDB index metadata: model=${meta.model}, dimensions=${meta.dimensions}, updated=${meta.updatedAt}`);
    if (!matches) {
      hasIssue = true;
      console.log('   ⚠️  MISMATCH between configured embedding model and LanceDB index! Run: npm run reembed');
    } else {
      console.log('   ✅ Matches LanceDB index');
    }
  } else {
    console.log('   ℹ️  No data/embedding_meta.json yet (will be bootstrapped automatically on next index/search).');
  }

  console.log('');
  if (hasIssue) {
    console.log('⚠️  One or more model health checks need attention.');
    process.exit(1);
  }
  console.log('🎉 All configured Gemini models are healthy and compatible!');
}

main().catch((err) => {
  console.error('❌ Model health check failed:', err?.message || err);
  process.exit(1);
});
