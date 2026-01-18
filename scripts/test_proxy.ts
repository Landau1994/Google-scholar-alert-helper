
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import './loadEnv.ts';
import { GoogleGenAI } from "@google/genai";

async function main() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || 'http://localhost:7897';
  console.log(`Setting up proxy: ${proxyUrl}`);

  if (proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(dispatcher);
    console.log("Global dispatcher set to ProxyAgent.");
  }

  const apiKey = process.env.VITE_GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey });

  try {
    console.log("Testing connection with proxy...");
    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: 'Hello via proxy'
    });
    console.log("Response:", response.text);
    console.log("SUCCESS: Proxy works.");
  } catch (error) {
    console.error("FAILURE:", error);
  }
}

main();
