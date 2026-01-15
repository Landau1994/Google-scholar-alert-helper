
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  snippet: string;
  link: string;
  source: string; // e.g., "Google Scholar Alert"
  date: string;
  relevanceScore: number;
  matchedKeywords: string[];
}

export interface Keyword {
  id: string;
  text: string;
  color: string;
}

export interface DigestSummary {
  overview: string;
  academicReport: string;
  keyTrends: string[];
  topRecommendations: string[];
  categorizedPapers: {
    keyword: string;
    paperIds: string[];
  }[];
}

export interface RawEmail {
  id: string;
  subject: string;
  snippet: string;
  date: string;
  body: string;
  from: string; // Sender email address for source identification
}

export interface AppSettings {
  syncLimit: number;
  syncHours: number;
  analysisLimit: number;
  weeklyGoal: number;
  batchSize: number;
  minScore: number;
  // Scheduling settings
  schedulerEnabled: boolean;
  schedulerTime: string; // HH:mm format
  schedulerTimezone: string;
}

export interface HistoryItem {
  filename: string;
  timestamp: number;
  date: string;
}

export interface ScheduledReportItem {
  filename: string;
  timestamp: number;
  date: string;
  type: 'papers' | 'review';
}

export type ViewState = 'dashboard' | 'import' | 'keywords' | 'settings' | 'preview' | 'scheduled-reports';
