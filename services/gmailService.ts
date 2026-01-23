
import { RawEmail } from "../types";
import { logger } from "../utils/logger";

// Add global declarations for Google API client libraries
declare var gapi: any;
declare var google: any;

const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_STORAGE_KEY = 'scholar_pulse_gmail_token';

interface StoredToken {
  access_token: string;
  expires_at: number; // timestamp when token expires
}

export class GmailService {
  private tokenClient: any;
  private accessToken: string | null = null;

  constructor(
    private clientId: string,
    private onAuthSuccess: (token: string) => void,
    private onAuthError: (error: any) => void
  ) {
    // Try to restore token from localStorage on construction
    this.restoreToken();
  }

  /**
   * Saves the access token to localStorage with expiry time
   */
  private saveToken(token: string, expiresIn: number = 3600) {
    const storedToken: StoredToken = {
      access_token: token,
      expires_at: Date.now() + (expiresIn * 1000) - 60000 // Subtract 1 minute buffer
    };
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(storedToken));
      logger.info("Access token saved to localStorage");
    } catch (e) {
      logger.warn("Failed to save token to localStorage:", e);
    }
  }

  /**
   * Restores the access token from localStorage if valid
   */
  private restoreToken(): boolean {
    try {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        const tokenData: StoredToken = JSON.parse(stored);
        if (tokenData.expires_at > Date.now()) {
          this.accessToken = tokenData.access_token;
          logger.success("Access token restored from localStorage");
          // Notify that auth is restored
          setTimeout(() => this.onAuthSuccess(tokenData.access_token), 0);
          return true;
        } else {
          logger.info("Stored token expired, clearing...");
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      }
    } catch (e) {
      logger.warn("Failed to restore token from localStorage:", e);
    }
    return false;
  }

  /**
   * Checks if the current token is valid (exists and not expired)
   */
  isTokenValid(): boolean {
    try {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        const tokenData: StoredToken = JSON.parse(stored);
        return tokenData.expires_at > Date.now();
      }
    } catch (e) {
      // Ignore
    }
    return false;
  }

  /**
   * Clears the stored token
   */
  clearToken() {
    this.accessToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    logger.info("Access token cleared");
  }

  /**
   * Initializes the Google Identity Services token client.
   * This should be called once before requesting a token.
   */
  init() {
    if (typeof google === 'undefined' || !google.accounts) {
      throw new Error("Google Identity Services (gsi) script not loaded yet.");
    }

    try {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPES,
        callback: (resp: any) => {
          if (resp.error !== undefined) {
            console.error("OAuth Error:", resp);
            this.onAuthError(resp);
            return;
          }
          logger.success("OAuth Success: Access token received.");
          this.accessToken = resp.access_token;
          // Save token with expiry (default 3600 seconds = 1 hour)
          this.saveToken(resp.access_token, resp.expires_in || 3600);
          this.onAuthSuccess(resp.access_token);
        },
      });
      logger.info(`Gmail Service initialized with Client ID: ${this.clientId}`);
    } catch (e) {
      logger.error("Failed to initialize token client:", e);
      throw e;
    }
  }

  /**
   * Triggers the Google OAuth2 consent popup.
   * @param forceConsent If true, always show consent screen. If false, try silent auth first.
   */
  requestToken(forceConsent: boolean = true) {
    if (!this.tokenClient) {
      this.init();
    }
    logger.info("Requesting access token...");
    this.tokenClient.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
  }

  /**
   * Fetches latest Scholar Alert emails using the Gmail API.
   * @param limit Maximum number of emails to fetch
   * @param hours Number of hours back to search
   * @param onProgress Optional callback to report fetching progress (current, total)
   */
  async fetchScholarEmails(limit: number, hours: number, onProgress?: (current: number, total: number) => void): Promise<RawEmail[]> {
    if (!this.accessToken) {
      throw new Error("Not authorized");
    }

    // Check if token is still valid
    if (!this.isTokenValid()) {
      this.clearToken();
      throw new Error("Token expired. Please re-authorize.");
    }

    logger.info(`Fetching up to ${limit} emails from the last ${hours} hours...`);
    
    // Load gapi client if not already loaded
    if (typeof gapi === 'undefined') throw new Error("GAPI script not loaded");

    await new Promise((resolve) => gapi.load('client', resolve));
    
    await gapi.client.init({
      discoveryDocs: [DISCOVERY_DOC],
    });
    
    gapi.client.setToken({ access_token: this.accessToken });

    // Calculate timestamp for "hours ago" in seconds
    const timestamp = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

    // Search for Google Scholar alerts and OpenRxiv alerts
    const response = await gapi.client.gmail.users.messages.list({
      userId: 'me',
      q: `{from:scholaralerts-noreply@google.com from:openRxiv-mailer@alerts.highwire.org from:cellpress@notification.elsevier.com from:ealert@nature.com from:ahajournals@ealerts.heart.org from:alerts@nature.com} after:${timestamp}`,
      maxResults: limit
    });

    const messages = response.result.messages || [];
    if (messages.length === 0) return [];

    const fetchedEmails: RawEmail[] = [];
    const total = messages.length;

    if (onProgress) onProgress(0, total);

    for (let i = 0; i < total; i++) {
      const msg = messages[i];
      try {
        const fullMsg = await gapi.client.gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'full'
        });

        const headers = fullMsg.result.payload?.headers || [];
        const dateHeader = headers.find((h: any) => h.name === 'Date');
        const date = dateHeader ? dateHeader.value : 'Unknown Date';
        const subjectHeader = headers.find((h: any) => h.name === 'Subject');
        const subject = subjectHeader ? subjectHeader.value : 'No Subject';
        const fromHeader = headers.find((h: any) => h.name === 'From');
        const from = fromHeader ? fromHeader.value : 'Unknown Sender';
        const snippet = fullMsg.result.snippet || 'No snippet';

        const parts = fullMsg.result.payload?.parts;
        let body = "";

        // Helper function to recursively find body content in nested parts (for bioRxiv emails)
        const extractBodyRecursive = (parts: any[], preferredType: string): string => {
          for (const part of parts) {
            if (part.mimeType === preferredType && part.body?.data) {
              return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            }
            if (part.parts) {
              const nested = extractBodyRecursive(part.parts, preferredType);
              if (nested) return nested;
            }
          }
          return "";
        };

        const isBioRxivEmail = from.includes('openRxiv-mailer@alerts.highwire.org');

        if (parts) {
          if (isBioRxivEmail) {
            // bioRxiv emails: try text/plain first, fallback to HTML
            body = extractBodyRecursive(parts, 'text/plain');
            if (!body) {
              const htmlBody = extractBodyRecursive(parts, 'text/html');
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
            // Other emails: original behavior
            const textPart = parts.find((p: any) => p.mimeType === 'text/plain');
            if (textPart && textPart.body?.data) {
              body = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            }
          }
        } else if (fullMsg.result.payload?.body?.data) {
          body = atob(fullMsg.result.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        }
        
        fetchedEmails.push({
            id: msg.id!,
            subject: subject,
            date: date,
            snippet: snippet,
            body: body,
            from: from
        });
        
        // Update progress
        if (onProgress) onProgress(i + 1, total);
        
      } catch (e) {
        logger.warn(`Could not fetch message ${msg.id}:`, e);
      }
    }

    // Deduplicate emails by subject (same subject = duplicate alert)
    const seenSubjects = new Set<string>();
    const uniqueEmails = fetchedEmails.filter(email => {
      if (seenSubjects.has(email.subject)) {
        return false;
      }
      seenSubjects.add(email.subject);
      return true;
    });

    if (uniqueEmails.length < fetchedEmails.length) {
      logger.info(`Removed ${fetchedEmails.length - uniqueEmails.length} duplicate emails (by subject)`);
    }

    return uniqueEmails;
  }
}
