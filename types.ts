
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
  keyTrends: string[];
  topRecommendations: string[];
  categorizedPapers: {
    keyword: string;
    paperIds: string[];
  }[];
}

export type ViewState = 'dashboard' | 'import' | 'keywords' | 'settings';
