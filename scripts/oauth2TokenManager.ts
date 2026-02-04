import fs from 'fs';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const TOKEN_PATH = path.resolve(process.cwd(), 'oauth2_tokens.json');

export interface OAuth2Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number; // timestamp in ms
  scope: string;
}

export interface OAuth2Config {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

/**
 * Manages OAuth2 tokens for server-side Gmail access
 */
export class OAuth2TokenManager {
  private tokens: OAuth2Tokens | null = null;
  private config: OAuth2Config;
  private dispatcher: ProxyAgent | undefined;

  constructor(config: OAuth2Config) {
    this.config = config;
    this.loadTokens();
    
    // Configure proxy if available
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyUrl) {
        this.dispatcher = new ProxyAgent({
            uri: proxyUrl,
            connect: { timeout: 30000 }
        });
        console.log(`[OAuth2] Proxy configured for token manager: ${proxyUrl}`);
    }
  }

  /**
   * Helper to perform fetch with proxy support
   */
  private async fetchWithProxy(url: string, init: any): Promise<any> {
      if (this.dispatcher) {
          return undiciFetch(url, { ...init, dispatcher: this.dispatcher });
      }
      return undiciFetch(url, init);
  }

  /**
   * Load tokens from file
   */
  private loadTokens(): void {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const data = fs.readFileSync(TOKEN_PATH, 'utf-8');
        this.tokens = JSON.parse(data);
        console.log('[OAuth2] Tokens loaded from file');
      }
    } catch (e) {
      console.warn('[OAuth2] Failed to load tokens:', e);
    }
  }

  /**
   * Save tokens to file
   */
  private saveTokens(): void {
    try {
      if (this.tokens) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(this.tokens, null, 2));
        console.log('[OAuth2] Tokens saved to file');
      }
    } catch (e) {
      console.error('[OAuth2] Failed to save tokens:', e);
    }
  }

  /**
   * Check if we have valid tokens
   */
  hasValidTokens(): boolean {
    return this.tokens !== null && this.tokens.refresh_token !== undefined;
  }

  /**
   * Check if access token is expired
   */
  isAccessTokenExpired(): boolean {
    if (!this.tokens) return true;
    // Consider expired 5 minutes before actual expiry
    return Date.now() >= (this.tokens.expiry_date - 5 * 60 * 1000);
  }

  /**
   * Generate authorization URL for user to visit
   */
  getAuthorizationUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.client_id,
      redirect_uri: this.config.redirect_uri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent', // Force consent to always get refresh token
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<OAuth2Tokens> {
    const response = await this.fetchWithProxy('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: this.config.redirect_uri,
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json() as any;

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expiry_date: Date.now() + (data.expires_in * 1000),
      scope: data.scope,
    };

    this.saveTokens();
    console.log('[OAuth2] Tokens obtained and saved');

    return this.tokens;
  }

  /**
   * Refresh the access token using refresh token
   */
  async refreshAccessToken(): Promise<string> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available. Please re-authorize.');
    }

    console.log('[OAuth2] Refreshing access token...');

    const response = await this.fetchWithProxy('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        refresh_token: this.tokens.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      // Log the error but don't clear tokens automatically - it might be a temporary network issue
      // User can manually re-authorize if needed via the web UI
      if (response.status === 400 || response.status === 401) {
        console.error('[OAuth2] Refresh token may be invalid or revoked. Please check your authorization.');
        console.error('[OAuth2] If this persists, re-authorize via Settings -> Server-Side Auth');
      }
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json() as any;

    this.tokens.access_token = data.access_token;
    this.tokens.expiry_date = Date.now() + (data.expires_in * 1000);

    // Sometimes a new refresh token is returned
    if (data.refresh_token) {
      this.tokens.refresh_token = data.refresh_token;
    }

    this.saveTokens();
    console.log('[OAuth2] Access token refreshed successfully');

    return this.tokens.access_token;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.hasValidTokens()) {
      throw new Error('No tokens available. Please authorize first.');
    }

    if (this.isAccessTokenExpired()) {
      return await this.refreshAccessToken();
    }

    return this.tokens!.access_token;
  }

  /**
   * Clear all tokens
   */
  clearTokens(): void {
    this.tokens = null;
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        fs.unlinkSync(TOKEN_PATH);
        console.log('[OAuth2] Tokens cleared');
      }
    } catch (e) {
      console.warn('[OAuth2] Failed to delete token file:', e);
    }
  }

  /**
   * Get current tokens (for debugging)
   */
  getTokens(): OAuth2Tokens | null {
    return this.tokens;
  }
}

/**
 * Load OAuth2 config from environment or config file
 */
export function loadOAuth2Config(): OAuth2Config {
  const configPath = path.resolve(process.cwd(), 'oauth2.config.json');

  // Try loading from config file first
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: config.redirect_uri || 'http://localhost:3000/oauth2callback',
    };
  }

  // Fall back to environment variables
  const client_id = process.env.GOOGLE_CLIENT_ID || '';
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || '';

  if (!client_id || !client_secret) {
    throw new Error('OAuth2 config not found. Create oauth2.config.json or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.');
  }

  return {
    client_id,
    client_secret,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
  };
}
