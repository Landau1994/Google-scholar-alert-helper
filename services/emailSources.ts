/**
 * Canonical list of academic alert sender email addresses synced from Gmail.
 * Shared by both browser-based GmailService and server-side syncGmail script.
 */
export const ACADEMIC_ALERT_SENDERS = [
  'scholaralerts-noreply@google.com',
  'openRxiv-mailer@alerts.highwire.org',
  'cellpress@notification.elsevier.com',
  'ealert@nature.com',
  'alerts@nature.com',
  'ahajournals@ealerts.heart.org',
  'etoc@oup.com',
  'blood@hematology.org',
] as const;

/**
 * Build the Gmail search query string for academic alert emails after a UNIX timestamp (seconds).
 */
export function buildGmailAlertQuery(afterTimestampSeconds: number): string {
  const fromClauses = ACADEMIC_ALERT_SENDERS.map(sender => `from:${sender}`).join(' ');
  return `{${fromClauses}} after:${afterTimestampSeconds}`;
}
