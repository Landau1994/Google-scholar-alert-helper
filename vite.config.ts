import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local for proxy settings
const envLocalPath = path.resolve(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#][^=]*)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

// Configure proxy for outbound requests
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

if (proxyUrl) {
  console.log(`[Vite] Using proxy: ${proxyUrl}`);
}

// Helper function for fetch with proxy support
const proxyFetch = (url: string, options: any = {}) => {
  if (proxyAgent) {
    return undiciFetch(url, { ...options, dispatcher: proxyAgent });
  }
  return fetch(url, options);
};

// https://vite.dev/config/
export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    host: true, // This makes the server accessible externally
    allowedHosts: true, // Allow magic domains like nip.io
  },
  plugins: [
    react(),
    {
      name: 'save-emails-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url || '';
          
          if (url === '/api/save-emails' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const { filename, content } = JSON.parse(body);
                const dir = path.resolve(__dirname, 'synced_emails');
                
                // Ensure directory exists
                if (!fs.existsSync(dir)) {
                  fs.mkdirSync(dir);
                }

                fs.writeFileSync(path.join(dir, filename), content);
                
                res.statusCode = 200;
                res.end(JSON.stringify({ status: 'success' }));
              } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
              }
            });
            return;
          }

          if (url === '/api/history' && req.method === 'GET') {
            try {
              const dir = path.resolve(__dirname, 'synced_emails');
              if (!fs.existsSync(dir)) {
                res.end(JSON.stringify([]));
                return;
              }

              const files = fs.readdirSync(dir)
                .filter(f => f.startsWith('analysis-') && f.endsWith('.json'))
                .sort((a, b) => b.localeCompare(a)); // Newest first

              const history = files.map(filename => {
                const timestamp = parseInt(filename.replace('analysis-', '').replace('.json', ''));
                return {
                  filename,
                  timestamp,
                  date: new Date(timestamp).toLocaleDateString() + ' ' + new Date(timestamp).toLocaleTimeString()
                };
              });

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(history));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          if (url.startsWith('/api/load-report') && req.method === 'GET') {
            try {
              const urlObj = new URL(url, `http://${req.headers.host}`);
              const filename = urlObj.searchParams.get('filename');

              if (!filename || !filename.startsWith('analysis-') || !filename.endsWith('.json')) {
                res.statusCode = 400;
                res.end(JSON.stringify({ status: 'error', message: 'Invalid filename' }));
                return;
              }

              const filePath = path.resolve(__dirname, 'synced_emails', filename);
              if (!fs.existsSync(filePath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ status: 'error', message: 'File not found' }));
                return;
              }

              const content = fs.readFileSync(filePath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(content);
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // API: List scheduled reports
          if (url === '/api/scheduled-reports' && req.method === 'GET') {
            try {
              const reportsDir = path.resolve(__dirname, 'reports');
              if (!fs.existsSync(reportsDir)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify([]));
                return;
              }

              const files = fs.readdirSync(reportsDir)
                .filter(f => f.endsWith('.md'))
                .sort((a, b) => b.localeCompare(a));

              const reports = files.map(filename => {
                const match = filename.match(/daily_(papers|review)_(.+)\.md/);
                const type = match ? match[1] : 'unknown';
                const timestampStr = match ? match[2] : '';
                const timestamp = timestampStr ? new Date(timestampStr.replace(/-/g, (m, i) => i < 10 ? '-' : i < 13 ? 'T' : i < 16 ? ':' : i < 19 ? ':' : '.')).getTime() : 0;

                return {
                  filename,
                  timestamp: timestamp || Date.now(),
                  date: timestamp ? new Date(timestamp).toLocaleString() : filename,
                  type
                };
              });

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(reports));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // API: Load scheduled report content
          if (url.startsWith('/api/load-scheduled-report') && req.method === 'GET') {
            try {
              const urlObj = new URL(url, `http://${req.headers.host}`);
              const filename = urlObj.searchParams.get('filename');

              if (!filename || !filename.endsWith('.md')) {
                res.statusCode = 400;
                res.end(JSON.stringify({ status: 'error', message: 'Invalid filename' }));
                return;
              }

              const filePath = path.resolve(__dirname, 'reports', filename);
              if (!fs.existsSync(filePath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ status: 'error', message: 'File not found' }));
                return;
              }

              const content = fs.readFileSync(filePath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ content, filename }));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // API: Get/Set scheduler config
          if (url === '/api/scheduler-config' && req.method === 'GET') {
            try {
              const configPath = path.resolve(__dirname, 'scheduler.config.json');
              if (!fs.existsSync(configPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ enabled: false, time: '08:00', timezone: 'Asia/Shanghai' }));
                return;
              }
              const content = fs.readFileSync(configPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(content);
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          if (url === '/api/scheduler-config' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const config = JSON.parse(body);
                const configPath = path.resolve(__dirname, 'scheduler.config.json');
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ status: 'success' }));
              } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
              }
            });
            return;
          }

          // API: Get/Set keywords for scheduler
          if (url === '/api/keywords' && req.method === 'GET') {
            try {
              const keywordsPath = path.resolve(__dirname, 'keywords.json');
              if (!fs.existsSync(keywordsPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify([]));
                return;
              }
              const content = fs.readFileSync(keywordsPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(content);
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          if (url === '/api/keywords' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const keywords = JSON.parse(body);
                const keywordsPath = path.resolve(__dirname, 'keywords.json');
                fs.writeFileSync(keywordsPath, JSON.stringify(keywords, null, 2));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ status: 'success' }));
              } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
              }
            });
            return;
          }

          // API: OAuth2 - Save config (client_id, client_secret)
          if (url === '/api/oauth2/config' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const config = JSON.parse(body);
                const configPath = path.resolve(__dirname, 'oauth2.config.json');
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ status: 'success' }));
              } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
              }
            });
            return;
          }

          // API: OAuth2 - Get config (without secret)
          if (url === '/api/oauth2/config' && req.method === 'GET') {
            try {
              const configPath = path.resolve(__dirname, 'oauth2.config.json');
              if (!fs.existsSync(configPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ configured: false }));
                return;
              }
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                configured: true,
                client_id: config.client_id,
                redirect_uri: config.redirect_uri || `http://${req.headers.host}/oauth2callback`
              }));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // API: OAuth2 - Get authorization URL
          if (url === '/api/oauth2/auth-url' && req.method === 'GET') {
            try {
              const configPath = path.resolve(__dirname, 'oauth2.config.json');
              if (!fs.existsSync(configPath)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ status: 'error', message: 'OAuth2 not configured' }));
                return;
              }
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              const redirectUri = config.redirect_uri || `http://${req.headers.host}/oauth2callback`;

              const params = new URLSearchParams({
                client_id: config.client_id,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: 'https://www.googleapis.com/auth/gmail.readonly',
                access_type: 'offline',
                prompt: 'consent',
              });

              const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ url: authUrl }));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // API: OAuth2 - Check token status
          if (url === '/api/oauth2/status' && req.method === 'GET') {
            try {
              const tokenPath = path.resolve(__dirname, 'oauth2_tokens.json');
              if (!fs.existsSync(tokenPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ authorized: false }));
                return;
              }
              const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
              const hasRefreshToken = !!tokens.refresh_token;
              const isExpired = Date.now() >= tokens.expiry_date;

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                authorized: hasRefreshToken,
                accessTokenExpired: isExpired,
                expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toLocaleString() : null
              }));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ status: 'error', message: (error as Error).message }));
            }
            return;
          }

          // OAuth2 callback page - exchanges code for tokens
          if (url.startsWith('/oauth2callback') && req.method === 'GET') {
            const urlObj = new URL(url, `http://${req.headers.host}`);
            const code = urlObj.searchParams.get('code');
            const errorParam = urlObj.searchParams.get('error');

            if (errorParam) {
              res.setHeader('Content-Type', 'text/html');
              res.end(`
                <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                  <h1 style="color: #dc2626;">Authorization Failed</h1>
                  <p>Error: ${errorParam}</p>
                  <p><a href="/">Return to app</a></p>
                </body></html>
              `);
              return;
            }

            if (!code) {
              res.setHeader('Content-Type', 'text/html');
              res.end(`
                <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                  <h1 style="color: #dc2626;">Missing Authorization Code</h1>
                  <p><a href="/">Return to app</a></p>
                </body></html>
              `);
              return;
            }

            // Handle async token exchange
            (async () => {
              try {
                // Load config
                const configPath = path.resolve(__dirname, 'oauth2.config.json');
                if (!fs.existsSync(configPath)) {
                  res.statusCode = 400;
                  res.end('OAuth2 not configured');
                  return;
                }
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                const redirectUri = config.redirect_uri || `http://${req.headers.host}/oauth2callback`;

                // Exchange code for tokens (with proxy support)
                const tokenResponse = await proxyFetch('https://oauth2.googleapis.com/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    client_id: config.client_id,
                    client_secret: config.client_secret,
                    code: code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri,
                  }).toString(),
                });

                if (!tokenResponse.ok) {
                  const errText = await tokenResponse.text();
                  res.setHeader('Content-Type', 'text/html');
                  res.end(`
                    <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                      <h1 style="color: #dc2626;">Token Exchange Failed</h1>
                      <p>${errText}</p>
                      <p><a href="/">Return to app</a></p>
                    </body></html>
                  `);
                  return;
                }

                const tokenData = await tokenResponse.json();

                // Save tokens
                const tokens = {
                  access_token: tokenData.access_token,
                  refresh_token: tokenData.refresh_token,
                  token_type: tokenData.token_type,
                  expiry_date: Date.now() + (tokenData.expires_in * 1000),
                  scope: tokenData.scope,
                };

                const tokenPath = path.resolve(__dirname, 'oauth2_tokens.json');
                fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

                res.setHeader('Content-Type', 'text/html');
                res.end(`
                  <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                    <h1 style="color: #16a34a;">Authorization Successful!</h1>
                    <p>Server-side Gmail access has been configured.</p>
                    <p>The scheduler can now automatically sync emails.</p>
                    <p><a href="/" style="color: #2563eb;">Return to app</a></p>
                    <script>setTimeout(() => window.location.href = '/', 3000);</script>
                  </body></html>
                `);
              } catch (error) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/html');
                res.end(`
                  <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                    <h1 style="color: #dc2626;">Error</h1>
                    <p>${(error as Error).message}</p>
                    <p><a href="/">Return to app</a></p>
                  </body></html>
                `);
              }
            })();
            return;
          }

          next();
        });
      }
    }
  ],
});
