
import { GoogleGenAI } from "@google/genai";
import fs from 'fs';
import path from 'path';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Configure proxy
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || 'http://localhost:7897';
if (proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(dispatcher);
}

// Load env
const envPath = path.resolve(process.cwd(), '.env.local');
let apiKey = process.env.VITE_GEMINI_API_KEY;

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/VITE_GEMINI_API_KEY=(.*)/);
  if (match) {
    apiKey = match[1].trim();
  }
}

if (!apiKey) {
  console.error("No API Key found");
  process.exit(1);
}

const ai = new GoogleGenAI({ 
  apiKey,
  httpOptions: {
    timeout: 300000 // 5 minutes
  }
});

async function listModels() {
  try {
    const response = await ai.models.list();
    // The response structure depends on the SDK version, printing keys to debug
    console.log("Models found:");
    // @google/genai might return an array directly or an object with a list
    const models = Array.isArray(response) ? response : (response.models || response.data || []);
    
    // If it's the new SDK, it might be async iterable or have a different format
    // Let's try to iterate if possible or print.
    console.log(JSON.stringify(models, null, 2));
    
  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listModels();
