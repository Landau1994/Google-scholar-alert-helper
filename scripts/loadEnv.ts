import fs from 'fs';
import path from 'path';
import { setGlobalDispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

const envPath = path.resolve(process.cwd(), '.env.local');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');

  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} else {
    console.warn("Warning: .env.local file not found at", envPath);
}

// Configure proxy for all fetch requests
// Must be done after loading env vars but before any other imports
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    bodyTimeout: 120000, // 2 minutes for request body timeout
    headersTimeout: 60000, // 1 minute for headers timeout
    connect: {
      timeout: 30000 // 30 seconds for connection timeout
    }
  });
  setGlobalDispatcher(dispatcher);

  // Replace global fetch with undici's fetch to ensure proxy is used
  // Node's native fetch doesn't respect undici's global dispatcher
  (globalThis as any).fetch = (url: string | URL | Request, init?: RequestInit) => {
    return undiciFetch(url as any, { ...init as any, dispatcher });
  };

  console.log(`[LoadEnv] Proxy configured for all fetch requests: ${proxyUrl}`);
}
