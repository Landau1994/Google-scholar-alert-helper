import './loadEnv.ts';
import fs from 'fs';
import path from 'path';
import { OAuth2TokenManager, loadOAuth2Config } from './oauth2TokenManager.ts';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Configure proxy for Node.js fetch
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(dispatcher);
  console.log(`[GmailSync] Proxy configured: ${proxyUrl}`);
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const syncedEmailsDir = path.resolve(process.cwd(), 'synced_emails');

// Ensure directory exists
if (!fs.existsSync(syncedEmailsDir)) {
  fs.mkdirSync(syncedEmailsDir, { recursive: true });
}

interface RawEmail {
  id: string;
  subject: string;
  snippet: string;
  date: string;
  body: string;
  from: string;
}

/**
 * Fetch emails from Gmail API using server-side OAuth2
 */
async function fetchGmailEmails(accessToken: string, hours: number, limit: number): Promise<RawEmail[]> {
  const timestamp = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

  // Search query for academic alert emails
  const query = encodeURIComponent(
    `{from:scholaralerts-noreply@google.com from:openRxiv-mailer@alerts.highwire.org from:cellpress@notification.elsevier.com from:ealert@nature.com from:ahajournals@ealerts.heart.org from:alerts@nature.com} after:${timestamp}`
  );

  console.log(`[GmailSync] Fetching emails from the last ${hours} hours...`);

  // List messages
  const listUrl = `${GMAIL_API_BASE}/users/me/messages?q=${query}&maxResults=${limit}`;
  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listResponse.ok) {
    const error = await listResponse.text();
    throw new Error(`Failed to list messages: ${error}`);
  }

  const listData = await listResponse.json();
  const messages = listData.messages || [];

  if (messages.length === 0) {
    console.log('[GmailSync] No emails found matching criteria');
    return [];
  }

  console.log(`[GmailSync] Found ${messages.length} messages, fetching details...`);

  const emails: RawEmail[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    try {
      const msgUrl = `${GMAIL_API_BASE}/users/me/messages/${msg.id}?format=full`;
      const msgResponse = await fetch(msgUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!msgResponse.ok) {
        console.warn(`[GmailSync] Failed to fetch message ${msg.id}`);
        continue;
      }

      const msgData = await msgResponse.json();

      // Extract headers
      const headers = msgData.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const subject = getHeader('Subject') || 'No Subject';
      const date = getHeader('Date') || 'Unknown Date';
      const from = getHeader('From') || 'Unknown Sender';
      const snippet = msgData.snippet || '';

      // Extract body
      let body = '';
      const payload = msgData.payload;

      // Helper function to recursively find body content in nested parts (for bioRxiv emails)
      const extractBodyRecursive = (parts: any[], preferredType: string): string => {
        for (const part of parts) {
          if (part.mimeType === preferredType && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) {
            const nested = extractBodyRecursive(part.parts, preferredType);
            if (nested) return nested;
          }
        }
        return '';
      };

      const isBioRxivEmail = from.includes('openRxiv-mailer@alerts.highwire.org');

      if (payload?.parts) {
        if (isBioRxivEmail) {
          // bioRxiv emails: recursively search for text/plain first, fallback to HTML
          body = extractBodyRecursive(payload.parts, 'text/plain');
          if (!body) {
            const htmlBody = extractBodyRecursive(payload.parts, 'text/html');
            if (htmlBody) {
              // Convert HTML to structured plain text, preserving paper boundaries
              body = htmlBody
                // Remove style and script blocks
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                // Convert block elements to newlines to preserve structure
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n\n')
                .replace(/<\/div>/gi, '\n')
                .replace(/<\/tr>/gi, '\n')
                .replace(/<\/li>/gi, '\n')
                .replace(/<hr[^>]*>/gi, '\n---\n')
                // Remove remaining HTML tags
                .replace(/<[^>]+>/g, ' ')
                // Decode HTML entities
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&aacute;/gi, 'á')
                .replace(/&eacute;/gi, 'é')
                .replace(/&iacute;/gi, 'í')
                .replace(/&oacute;/gi, 'ó')
                .replace(/&uacute;/gi, 'ú')
                .replace(/&#x[0-9a-f]+;/gi, '') // Remove hex entities
                .replace(/&#\d+;/gi, '')        // Remove decimal entities
                // Normalize whitespace but preserve newlines
                .replace(/[ \t]+/g, ' ')        // Collapse horizontal whitespace only
                .replace(/\n /g, '\n')          // Remove leading space after newline
                .replace(/ \n/g, '\n')          // Remove trailing space before newline
                .replace(/\n{3,}/g, '\n\n')     // Max 2 consecutive newlines
                .trim();
            }
          }
        } else {
          // Other emails: original behavior (top-level parts only)
          const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
          const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');

          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          } else if (htmlPart?.body?.data) {
            body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
          }
        }
      } else if (payload?.body?.data) {
        // Simple message
        body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      }

      emails.push({
        id: msg.id,
        subject,
        snippet,
        date,
        body,
        from,
      });

      // Progress indicator
      if ((i + 1) % 10 === 0 || i === messages.length - 1) {
        console.log(`[GmailSync] Fetched ${i + 1}/${messages.length} emails`);
      }
    } catch (e) {
      console.warn(`[GmailSync] Error fetching message ${msg.id}:`, e);
    }
  }

  return emails;
}

/**
 * Main sync function - can be called by scheduler
 */
export async function syncGmailEmails(hours: number = 24, limit: number = 200): Promise<string | null> {
  console.log('[GmailSync] Starting Gmail sync...');

  try {
    const config = loadOAuth2Config();
    const tokenManager = new OAuth2TokenManager(config);

    if (!tokenManager.hasValidTokens()) {
      console.error('[GmailSync] No valid OAuth2 tokens found.');
      console.error('[GmailSync] Please authorize via the web UI first: Settings -> Server-Side Auth');
      return null;
    }

    // Get valid access token (will refresh if expired)
    const accessToken = await tokenManager.getValidAccessToken();

    // Fetch emails
    const emails = await fetchGmailEmails(accessToken, hours, limit);

    if (emails.length === 0) {
      console.log('[GmailSync] No new emails to save');
      return null;
    }

    // Save to sync file
    const filename = `sync-${Date.now()}.json`;
    const filepath = path.join(syncedEmailsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(emails, null, 2));

    console.log(`[GmailSync] Saved ${emails.length} emails to ${filename}`);
    return filepath;
  } catch (e) {
    console.error('[GmailSync] Sync failed:', e);
    throw e;
  }
}

// Run directly if called as script
if (process.argv[1]?.endsWith('syncGmail.ts')) {
  const hours = parseInt(process.argv[2] || '24', 10);
  const limit = parseInt(process.argv[3] || '200', 10);

  syncGmailEmails(hours, limit)
    .then((filepath) => {
      if (filepath) {
        console.log(`[GmailSync] Success! Emails saved to: ${filepath}`);
      } else {
        console.log('[GmailSync] No emails synced');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error('[GmailSync] Failed:', e);
      process.exit(1);
    });
}
