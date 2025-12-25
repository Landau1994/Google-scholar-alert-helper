
// Add global declarations for Google API client libraries
declare var gapi: any;
declare var google: any;

const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

export class GmailService {
  private tokenClient: any;
  private accessToken: string | null = null;

  constructor(
    private clientId: string, 
    private onAuthSuccess: (token: string) => void,
    private onAuthError: (error: any) => void
  ) {}

  /**
   * Safe base64 decoding for UTF-8 content
   */
  private decodeBase64(data: string): string {
    try {
      // Gmail uses URL-safe base64
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const binString = atob(base64);
      const bytes = new Uint8Array(binString.length);
      for (let i = 0; i < binString.length; i++) {
        bytes[i] = binString.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    } catch (e) {
      console.warn("Decoding error, fallback to raw atob", e);
      return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    }
  }

  /**
   * Initializes the Google Identity Services token client.
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
            console.error("OAuth Error Response:", resp);
            // Common errors: access_denied, immediate_failed, popup_closed_by_user
            this.onAuthError(resp);
            return;
          }
          
          // Check if the specific scope was actually granted
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPES)) {
            console.warn("User did not grant all required scopes.");
            this.onAuthError({ error: 'insufficient_scopes', message: 'Permissions not granted.' });
            return;
          }

          console.log("OAuth Success: Access token received.");
          this.accessToken = resp.access_token;
          this.onAuthSuccess(resp.access_token);
        },
      });
      console.log("Gmail Service initialized with Client ID:", this.clientId);
    } catch (e) {
      console.error("Failed to initialize token client:", e);
      throw e;
    }
  }

  /**
   * Triggers the Google OAuth2 consent popup.
   */
  requestToken() {
    if (!this.tokenClient) {
      this.init();
    }
    console.log("Requesting access token...");
    // Force a fresh consent if needed to ensure checkboxes appear
    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  /**
   * Fetches latest Scholar Alert emails using the Gmail API.
   */
  async fetchScholarEmails(): Promise<string> {
    if (!this.accessToken) throw new Error("Not authorized");

    console.log("Fetching emails from Gmail API...");
    
    // Load gapi client if not already loaded
    if (typeof gapi === 'undefined') throw new Error("GAPI script not loaded");

    await new Promise((resolve) => gapi.load('client', resolve));
    
    await gapi.client.init({
      discoveryDocs: [DISCOVERY_DOC],
    });
    
    gapi.client.setToken({ access_token: this.accessToken });

    // Search for Google Scholar alerts
    const response = await gapi.client.gmail.users.messages.list({
      userId: 'me',
      q: 'from:scholaralerts-noreply@google.com',
      maxResults: 15
    });

    const messages = response.result.messages || [];
    if (messages.length === 0) return "";

    let combinedContent = "";

    for (const msg of messages) {
      try {
        const fullMsg = await gapi.client.gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'full'
        });

        const parts = fullMsg.result.payload?.parts;
        let body = "";
        
        if (parts) {
          // Priority for plain text, otherwise HTML
          const textPart = parts.find((p: any) => p.mimeType === 'text/plain') || parts.find((p: any) => p.mimeType === 'text/html');
          if (textPart && textPart.body?.data) {
            body = this.decodeBase64(textPart.body.data);
          }
        } else if (fullMsg.result.payload?.body?.data) {
          body = this.decodeBase64(fullMsg.result.payload.body.data);
        }
        
        combinedContent += `--- EMAIL ID: ${msg.id} ---\n${body}\n\n`;
      } catch (e) {
        console.warn(`Could not fetch message ${msg.id}:`, e);
      }
    }

    return combinedContent;
  }
}
