
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Paper, Keyword, DigestSummary, ViewState, RawEmail, AppSettings, HistoryItem } from './types';
import { processScholarEmails, generateLiteratureReview, deduplicatePapers } from './services/geminiService';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ImportView from './components/ImportView';
import KeywordManager from './components/KeywordManager';
import { GmailService } from './services/gmailService';

import ErrorBoundary from './components/ErrorBoundary';
import Preview from './components/Preview';
import LogViewer from './components/LogViewer';
import ScheduledReports from './components/ScheduledReports';
import { Bell, BookOpen, Settings, LayoutDashboard, PlusCircle, Search, Mail, CheckCircle, AlertCircle, Loader2, Copy, ExternalLink, HelpCircle, Download, ArrowRight, X, FileText, History, Terminal, CalendarClock } from 'lucide-react';

const INITIAL_KEYWORDS: Keyword[] = [
  { id: '1', text: 'Aortic Disease', color: 'bg-blue-100 text-blue-700' },
  { id: '2', text: 'Marfan Syndrome', color: 'bg-purple-100 text-purple-700' },
  { id: '3', text: 'organoid', color: 'bg-green-100 text-green-700' },
  { id: '4', text: 'AI virtual cell', color: 'bg-orange-100 text-orange-700' },
  { id: '5', text: 'single-cell proteomics', color: 'bg-pink-100 text-pink-700' }
];

const DEFAULT_SETTINGS: AppSettings = {
  syncLimit: 200,
  syncHours: 168,
  analysisLimit: 200,
  weeklyGoal: 50,
  batchSize: 20,
  minScore: 10,
  schedulerEnabled: false,
  schedulerTime: '08:00',
  schedulerTimezone: 'Asia/Shanghai'
};

const AppContent: React.FC = () => {
  // Persist View State
  const [view, setView] = useState<ViewState>(() => {
    try {
      return (localStorage.getItem('scholar_pulse_view') as ViewState) || 'dashboard';
    } catch { return 'dashboard'; }
  });

  useEffect(() => {
    try { localStorage.setItem('scholar_pulse_view', view); } catch (e) { console.warn('Failed to save view state', e); }
  }, [view]);

  // Persist Settings
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('scholar_pulse_settings_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
      return DEFAULT_SETTINGS;
    } catch { return DEFAULT_SETTINGS; }
  });

  useEffect(() => {
    try { localStorage.setItem('scholar_pulse_settings_v2', JSON.stringify(settings)); } catch (e) { console.warn('Failed to save settings', e); }

    // Sync processing settings to scheduler config
    (async () => {
      try {
        const res = await fetch('/api/scheduler-config');
        const schedulerConfig = await res.json();
        // Merge processing settings into scheduler config
        const updatedConfig = {
          ...schedulerConfig,
          batchSize: settings.batchSize,
          analysisLimit: settings.analysisLimit,
          minScore: settings.minScore
        };
        await fetch('/api/scheduler-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedConfig)
        });
      } catch (e) {
        console.warn('Failed to sync settings to scheduler config', e);
      }
    })();
  }, [settings]);

  // Persist Keywords
  const [keywords, setKeywords] = useState<Keyword[]>(() => {
    try {
      const saved = localStorage.getItem('scholar_pulse_keywords');
      return saved ? JSON.parse(saved) : INITIAL_KEYWORDS;
    } catch { return INITIAL_KEYWORDS; }
  });

  useEffect(() => {
    try { localStorage.setItem('scholar_pulse_keywords', JSON.stringify(keywords)); } catch (e) { console.warn('Failed to save keywords', e); }

    // Sync keywords to file for scheduler
    (async () => {
      try {
        const keywordTexts = keywords.map(k => k.text);
        await fetch('/api/keywords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(keywordTexts)
        });
      } catch (e) {
        console.warn('Failed to sync keywords to file', e);
      }
    })();
  }, [keywords]);

  // Persist Papers
  const [papers, setPapers] = useState<Paper[]>(() => {
    try {
      const saved = localStorage.getItem('scholar_pulse_papers');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem('scholar_pulse_papers', JSON.stringify(papers)); } catch (e) { console.warn('Failed to save papers', e); }
  }, [papers]);

  // Persist Summary
  const [summary, setSummary] = useState<DigestSummary | null>(() => {
    try {
      const saved = localStorage.getItem('scholar_pulse_summary');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  useEffect(() => {
    if (summary) {
      try { localStorage.setItem('scholar_pulse_summary', JSON.stringify(summary)); } catch (e) { console.warn('Failed to save summary', e); }
    }
  }, [summary]);

  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  // History State
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Server-side OAuth2 State
  const [serverAuthStatus, setServerAuthStatus] = useState<{
    authorized: boolean;
    configured: boolean;
    loading: boolean;
  }>({ authorized: false, configured: false, loading: true });

  const [serverAuthConfig, setServerAuthConfig] = useState({
    client_id: '',
    client_secret: '',
  });

  const fetchServerAuthStatus = useCallback(async () => {
    try {
      const [configRes, statusRes] = await Promise.all([
        fetch('/api/oauth2/config'),
        fetch('/api/oauth2/status'),
      ]);

      const configData = await configRes.json();
      const statusData = await statusRes.json();

      setServerAuthStatus({
        authorized: statusData.authorized || false,
        configured: configData.configured || false,
        loading: false,
      });

      if (configData.client_id) {
        setServerAuthConfig(prev => ({ ...prev, client_id: configData.client_id }));
      }
    } catch (e) {
      console.error('Failed to fetch server auth status', e);
      setServerAuthStatus({ authorized: false, configured: false, loading: false });
    }
  }, []);

  useEffect(() => {
    fetchServerAuthStatus();
  }, [fetchServerAuthStatus]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      }
    } catch (e) {
      console.error("Failed to fetch history", e);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const loadReport = async (filename: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/load-report?filename=${filename}`);
      if (!res.ok) throw new Error('Failed to load report');
      
      const data = await res.json();
      if (data.papers && data.summary) {
          setPapers(data.papers);
          setSummary(data.summary);
          setView('dashboard');
      }
    } catch (e) {
        console.error(e);
        alert("Failed to load report");
    } finally {
        setIsLoading(false);
    }
  };

  // Persist Fetched Emails (for Preview recovery)
  const [fetchedEmails, setFetchedEmails] = useState<RawEmail[]>(() => {
    try {
      const saved = localStorage.getItem('scholar_pulse_fetched_emails');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  useEffect(() => {
    try { 
      localStorage.setItem('scholar_pulse_fetched_emails', JSON.stringify(fetchedEmails)); 
    } catch (e) { 
      console.error('Storage quota exceeded! Emails too large to save automatically.', e);
      // Optional: alert user or handle gracefully
    }
  }, [fetchedEmails]);

  const [syncStatus, setSyncStatus] = useState<{
    stage: 'idle' | 'fetching' | 'analyzing';
    current: number;
    total: number;
  }>({ stage: 'idle', current: 0, total: 0 });
  
  // Utility to save to our new local server API
  const saveToLocalFolder = async (filename: string, content: any) => {
    try {
      await fetch('/api/save-emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          content: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
        })
      });
      console.log(`Successfully saved ${filename} to synced_emails folder`);
      fetchHistory(); // Refresh history
    } catch (error) {
      console.error('Failed to save to local folder', error);
    }
  };

  // Gmail Sync State
  const [clientId, setClientId] = useState(localStorage.getItem('scholar_pulse_client_id') || '');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const gmailServiceRef = useRef<GmailService | null>(null);

  // Get current origin for debugging/setup
  const currentOrigin = window.location.origin;
  const currentHostname = window.location.hostname;
  const currentPort = window.location.port;
  
  // Check if current hostname is an IP address
  const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(currentHostname);
  const nipDomain = isIP ? `${currentHostname}.nip.io${currentPort ? `:${currentPort}` : ''}` : null;
  const nipURL = nipDomain ? `http://${nipDomain}` : null;

  useEffect(() => {
    if (clientId) {
      const handleSuccess = (token: string) => {
        setIsAuthorized(true);
        localStorage.setItem('scholar_pulse_client_id', clientId);
      };
      const handleError = (error: any) => {
        setIsAuthorized(false);
        console.error("Auth callback error:", error);
      };

      const service = new GmailService(clientId, handleSuccess, handleError);
      gmailServiceRef.current = service;

      // Check if token was restored (will call handleSuccess via setTimeout if valid)
      // The GmailService constructor automatically restores and validates the token
    }
  }, [clientId]);

  const handleAuthorize = () => {
    if (!clientId) {
      alert("Please enter a Client ID first.");
      return;
    }
    
    try {
      if (!gmailServiceRef.current) {
        const handleSuccess = () => {
          setIsAuthorized(true);
          localStorage.setItem('scholar_pulse_client_id', clientId);
        };
        const handleError = () => setIsAuthorized(false);
        gmailServiceRef.current = new GmailService(clientId, handleSuccess, handleError);
      }
      gmailServiceRef.current.requestToken();
    } catch (err) {
      alert("Authorization failed. Ensure the Google script is loaded and your Client ID is correct.");
      console.error(err);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      // Try modern clipboard API first (requires HTTPS)
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        alert("Copied to clipboard!");
        return;
      }

      // Fallback for HTTP: use legacy execCommand
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const success = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (success) {
        alert("Copied to clipboard!");
      } else {
        throw new Error('execCommand failed');
      }
    } catch (err) {
      console.error('Copy failed:', err);
      // Final fallback: show text in a prompt for manual copy
      const truncated = text.length > 1000 ? text.substring(0, 1000) + '...\n\n[Text truncated. Use Export Report instead.]' : text;
      prompt('Copy failed. Please copy manually (Ctrl+C):', truncated);
    }
  };

  const syncFromGmail = async () => {
    if (!isAuthorized) {
      alert("Please authorize with Google in Settings first.");
      setView('settings');
      return;
    }

    setIsLoading(true);
    setSyncStatus({ stage: 'fetching', current: 0, total: 0 });
    setShowLogs(true); // Auto-show logs

    try {
      const emails = await gmailServiceRef.current?.fetchScholarEmails(
        settings.syncLimit,
        settings.syncHours,
        (current, total) => {
          setSyncStatus({ stage: 'fetching', current, total });
        }
      );

      if (!emails || emails.length === 0) {
        alert(`No academic alert emails found from the last ${settings.syncHours} hours.`);
        setSyncStatus({ stage: 'idle', current: 0, total: 0 });
        return;
      }

      // Deduplicate incoming emails internally
      const uniqueIncoming = emails.filter((e, i, self) => 
        i === self.findIndex(t => t.id === e.id)
      );

      // Replace the current list with the new batch (process only the current sync file)
      const newEmails = uniqueIncoming;

      if (newEmails.length === 0) {
        alert("No emails found.");
        setSyncStatus({ stage: 'idle', current: 0, total: 0 });
        return;
      }

      setFetchedEmails(newEmails);
      
      // Auto-save raw new emails to local folder
      await saveToLocalFolder(`sync-${Date.now()}.json`, newEmails);
      setView('preview');
    } catch (error: any) {
      console.error("Sync error:", error);
      const errorMessage = error?.message || "Unknown error";
      if (errorMessage.includes("expired") || errorMessage.includes("Not authorized")) {
        alert("Your session has expired. Please re-authorize with Google.");
        gmailServiceRef.current?.clearToken();
      } else {
        alert("Error syncing from Gmail. You may need to re-authorize.");
      }
      setIsAuthorized(false);
    } finally {
      setIsLoading(false);
      setSyncStatus({ stage: 'idle', current: 0, total: 0 });
    }
  };

  const analyzeSingleEmail = async (email: RawEmail): Promise<Paper[]> => {
    try {
      const keywordTexts = keywords.map(k => k.text);
      // Analyze specific email content
      const result = await processScholarEmails(email.body, keywordTexts, settings.analysisLimit);
      return result.papers;
    } catch (error) {
      console.error("Single email analysis error:", error);
      throw error;
    }
  };

  const processSelectedEmails = async (selectedEmails: RawEmail[]) => {
    setIsLoading(true);
    setShowLogs(true); // Auto-show logs
    
    const BATCH_SIZE = settings.batchSize || 20;
    const totalBatches = Math.ceil(selectedEmails.length / BATCH_SIZE);
    
    let allPapers: Paper[] = [];
    let combinedSummary: DigestSummary = {
      overview: '',
      academicReport: '',
      keyTrends: [],
      topRecommendations: [],
      categorizedPapers: []
    };
    
    try {
      const keywordTexts = keywords.map(k => k.text);
      
      for (let i = 0; i < totalBatches; i++) {
        const start = i * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, selectedEmails.length);
        const batch = selectedEmails.slice(start, end);
        
        setSyncStatus({ 
          stage: 'analyzing', 
          current: start, 
          total: selectedEmails.length 
        });
        
        console.log(`Processing batch ${i + 1}/${totalBatches} (${batch.length} emails)...`);
        
        // Combine bodies for this batch
        const rawContent = batch.map(e => `--- EMAIL ID: ${e.id} ---\nFrom: ${e.from || 'Unknown'}\nSubject: ${e.subject}\n${e.body}\n\n`).join('');
        
        try {
          const result = await processScholarEmails(rawContent, keywordTexts, settings.analysisLimit);
          
          // Accumulate papers
          allPapers = [...allPapers, ...result.papers];
          
          // Accumulate summary info (simple merge)
          combinedSummary.keyTrends = [...new Set([...combinedSummary.keyTrends, ...(result.summary.keyTrends || [])])].slice(0, 15);
          combinedSummary.topRecommendations = [...new Set([...combinedSummary.topRecommendations, ...(result.summary.topRecommendations || [])])].slice(0, 15);
          combinedSummary.overview += (result.summary.overview || '') + '\n\n';
          
          // Update interim state so user sees progress (with deduplication)
          const dedupedPapers = deduplicatePapers(allPapers);
          const interimSorted = dedupedPapers
             .filter(p => p.relevanceScore >= settings.minScore)
             .sort((a, b) => b.relevanceScore - a.relevanceScore);

          setPapers(interimSorted);

        } catch (batchError) {
          console.error(`Error processing batch ${i + 1}:`, batchError);
          // Continue to next batch even if this one failed
        }
      }

      // Post-processing: Deduplicate, Filter and Sort
      const dedupedPapers = deduplicatePapers(allPapers);
      const validPapers = dedupedPapers.filter(p => p.relevanceScore >= settings.minScore);
      const sortedPapers = validPapers.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // Generate high-quality literature review immediately on the aggregated set
      setSyncStatus({ stage: 'analyzing', current: selectedEmails.length, total: selectedEmails.length });
      console.log("Generating final literature review...");
      
      const contextPapers = sortedPapers.slice(0, 200);
      let highQualityReport = '';
      
      if (contextPapers.length > 0) {
        try {
          highQualityReport = await generateLiteratureReview(contextPapers, keywordTexts);
        } catch (reportError) {
          console.error("Failed to generate final report:", reportError);
          highQualityReport = "Failed to generate comprehensive report. Please check individual paper summaries.";
        }
      } else {
        highQualityReport = "No relevant papers found to generate a report.";
      }
      
      const enhancedSummary = {
          ...combinedSummary,
          overview: combinedSummary.overview.trim().substring(0, 1000) + '...', // Truncate generic overview
          academicReport: highQualityReport
      };
      
      setPapers(sortedPapers);
      setSummary(enhancedSummary);
      
      // Auto-save processed analysis to local folder
      await saveToLocalFolder(`analysis-${Date.now()}.json`, { papers: sortedPapers, summary: enhancedSummary });
      
      setView('dashboard');
    } catch (error: any) {
      console.error("AI Process error:", error);
      const errorMessage = error?.message || "Error processing content with AI. Please check your API key or input.";
      alert(errorMessage);
    } finally {
      setIsLoading(false);
      setSyncStatus({ stage: 'idle', current: 0, total: 0 });
    }
  };

  const handleImport = async (rawContent: string) => {
    // Legacy support for manual text import
    setIsLoading(true);
    try {
      const keywordTexts = keywords.map(k => k.text);
      const result = await processScholarEmails(rawContent, keywordTexts, settings.analysisLimit);
      
      // Deduplicate, filter low relevance and sort by relevance score descending
      const dedupedPapers = deduplicatePapers(result.papers);
      const validPapers = dedupedPapers.filter(p => p.relevanceScore >= settings.minScore);
      const sortedPapers = validPapers.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // Generate high-quality literature review immediately
      const contextPapers = sortedPapers.slice(0, 200);
      const highQualityReport = await generateLiteratureReview(contextPapers, keywordTexts);
      
      const enhancedSummary = {
          ...result.summary,
          academicReport: highQualityReport
      };

      setPapers(sortedPapers);
      setSummary(enhancedSummary);

      // Auto-save to local folder
      await saveToLocalFolder(`manual-import-${Date.now()}.json`, { ...result, papers: sortedPapers, summary: enhancedSummary });

      setView('dashboard');
    } catch (error: any) {
      console.error("AI Process error:", error);
      const errorMessage = error?.message || "Error processing content with AI. Please check your API key or input.";
      alert(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const addKeyword = (text: string) => {
    const colors = ['bg-blue-100 text-blue-700', 'bg-purple-100 text-purple-700', 'bg-green-100 text-green-700', 'bg-orange-100 text-orange-700', 'bg-pink-100 text-pink-700'];
    const newKeyword: Keyword = { id: Date.now().toString(), text, color: colors[Math.floor(Math.random() * colors.length)] };
    setKeywords([...keywords, newKeyword]);
  };

  const removeKeyword = (id: string) => setKeywords(keywords.filter(k => k.id !== id));

  const generateReportContent = (currentSummary: DigestSummary | null = summary) => {
    if (!currentSummary || papers.length === 0) return '';

    const date = new Date().toLocaleDateString();
    let report = `# ScholarPulse Report - ${date}\n\n`;
    
    if (currentSummary.academicReport) {
      report += `${currentSummary.academicReport}\n\n`;
    } else {
      report += `## Executive Summary\n${currentSummary.overview}\n\n`;
      
      report += `## Key Trends\n`;
      currentSummary.keyTrends.forEach(trend => {
        report += `- ${trend}\n`;
      });
      report += `\n`;

      report += `## Top Recommendations\n`;
      currentSummary.topRecommendations.forEach((rec, i) => {
        report += `${i + 1}. ${rec}\n`;
      });
      report += `\n`;
    }

    report += `## Detailed References\n`;
    const sortedPapers = [...papers].sort((a, b) => b.relevanceScore - a.relevanceScore);
    sortedPapers.forEach((paper, i) => {
      report += `### [${i + 1}] ${paper.title}\n`;
      report += `- **Authors**: ${paper.authors.join(', ')}\n`;
      report += `- **Source**: ${paper.source} (${paper.date})\n`;
      report += `- **Relevance**: ${paper.relevanceScore}%\n`;
      report += `- **Snippet**: ${paper.snippet}\n\n`;
    });
    
    return report;
  };

  const generateReport = () => {
    const report = generateReportContent();
    if (!report) return;

    const blob = new Blob([report], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scholarpulse-report-${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyReportMarkdown = async () => {
    if (papers.length === 0) return;
    
    let activeSummary = summary;

    // If report is missing or looks incomplete (legacy), generate it
    if (!activeSummary?.academicReport || activeSummary.academicReport.length < 50) {
      setIsGeneratingReport(true);
      try {
        const keywordTexts = keywords.map(k => k.text);
        const sortedPapers = [...papers].sort((a, b) => b.relevanceScore - a.relevanceScore);
        const contextPapers = sortedPapers.slice(0, 200);
        
        const reviewBody = await generateLiteratureReview(contextPapers, keywordTexts);

        if (activeSummary) {
          activeSummary = { ...activeSummary, academicReport: reviewBody };
          setSummary(activeSummary);
        }
      } catch (e) {
        console.error("Failed to generate report", e);
        alert("Failed to generate detailed report.");
        setIsGeneratingReport(false);
        return;
      } finally {
        setIsGeneratingReport(false);
      }
    }

    const fullReport = generateReportContent(activeSummary);
    copyToClipboard(fullReport);
  };

  const exportRawData = () => {
    if (fetchedEmails.length === 0) return;
    
    const data = JSON.stringify(fetchedEmails, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `emails-sync-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      <Sidebar 
        currentView={view} 
        setView={setView} 
        stats={{ analyzedCount: papers.length, weeklyGoal: settings.weeklyGoal }}
        history={history}
        onLoadReport={loadReport}
      />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-8 shrink-0 z-10">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-slate-800">
              {view === 'dashboard' && 'Academic Dashboard'}
              {view === 'import' && 'Import Alerts'}
              {view === 'keywords' && 'My Interests'}
              {view === 'settings' && 'Settings'}
              {view === 'preview' && 'Review Emails'}
              {view === 'scheduled-reports' && 'Daily Reports'}
            </h1>
            {isLoading && (
              <div className="flex items-center gap-3 px-4 py-1.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-100">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {syncStatus.stage === 'fetching' ? (
                  <span className="flex items-center gap-2">
                    Fetching emails
                    <span className="font-bold">{syncStatus.current} / {syncStatus.total}</span>
                    <div className="w-16 h-1.5 bg-blue-200 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-blue-600 transition-all duration-300 ease-out"
                        style={{ width: `${(syncStatus.current / (syncStatus.total || 1)) * 100}%` }}
                      />
                    </div>
                  </span>
                ) : (
                  <span>Analyzing content with AI...</span>
                )}
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            {view === 'dashboard' && papers.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={copyReportMarkdown}
                  disabled={isGeneratingReport}
                  className="flex items-center gap-2 px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Generate detailed review and copy to clipboard"
                >
                  {isGeneratingReport ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy Report
                    </>
                  )}
                </button>
                <button
                  onClick={generateReport}
                  className="flex items-center gap-2 px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-all shadow-sm"
                >
                  <Download className="w-4 h-4" />
                  Export Report
                </button>
                <button
                  onClick={exportRawData}
                  className="flex items-center gap-2 px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-all shadow-sm"
                  title="Export raw JSON data to synced_emails folder"
                >
                  <FileText className="w-4 h-4" />
                  Export Raw
                </button>
              </div>
            )}
            <button 
              onClick={syncFromGmail}
              disabled={isLoading || view === 'preview'}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-all shadow-md shadow-blue-200 disabled:opacity-50"
            >
              <Mail className="w-4 h-4" />
              Sync Gmail
            </button>
            
            {fetchedEmails.length > 0 && view !== 'preview' && (
              <button 
                onClick={() => setView('preview')}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 border border-slate-300 rounded-lg text-sm font-semibold hover:bg-slate-200 transition-all shadow-sm"
                title="Process already synced emails"
              >
                <History className="w-4 h-4" />
                Review Synced
              </button>
            )}

            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-white text-sm font-bold">U</div>
            <button 
              onClick={() => setShowLogs(!showLogs)}
              className={`p-2 rounded-lg transition-all ${showLogs ? 'bg-slate-200 text-slate-800' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`}
              title="Toggle System Logs"
            >
              <Terminal className="w-5 h-5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {view === 'dashboard' && <Dashboard papers={papers} summary={summary} keywords={keywords} onGoToImport={() => setView('import')} />}
          {view === 'import' && <ImportView onImport={async (content) => {
            // Adapt legacy string import to direct processing
             setIsLoading(true);
             setShowLogs(true);
             try {
               const keywordTexts = keywords.map(k => k.text);
               const result = await processScholarEmails(content, keywordTexts);
               setPapers(result.papers);
               setSummary(result.summary);
               setView('dashboard');
             } catch (error: any) {
               console.error("AI Process error:", error);
               const errorMessage = error?.message || "Error processing content with AI. Please check your API key or input.";
               alert(errorMessage);
             } finally {
               setIsLoading(false);
             }
          }} isProcessing={isLoading} onSyncGmail={syncFromGmail} isAuthorized={isAuthorized} />}
          {view === 'keywords' && <KeywordManager keywords={keywords} onAdd={addKeyword} onRemove={removeKeyword} />}
          {view === 'preview' && (
            <Preview
              emails={fetchedEmails}
              onConfirm={processSelectedEmails}
              onCancel={() => setView('dashboard')}
              onAnalyze={analyzeSingleEmail}
            />
          )}
          {view === 'scheduled-reports' && (
            <ScheduledReports
              onViewReport={(content, filename) => {
                console.log('Viewing report:', filename);
              }}
            />
          )}
          {view === 'settings' && (
            <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl shadow-sm border border-slate-200 space-y-8 animate-in fade-in duration-500">
              <div>
                <h2 className="text-2xl font-bold mb-2">Preferences</h2>
                <p className="text-sm text-slate-500 mb-6">Customize how the application fetches and processes data.</p>
                
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Sync Limit (Emails)</label>
                      <input 
                        type="number" 
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.syncLimit}
                        onChange={(e) => setSettings({ ...settings, syncLimit: parseInt(e.target.value) || 10 })}
                        min="1"
                        max="500"
                      />
                      <p className="text-xs text-slate-500 mt-2">Max number of emails to fetch from Gmail.</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Sync Range (Hours)</label>
                      <input 
                        type="number" 
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.syncHours}
                        onChange={(e) => setSettings({ ...settings, syncHours: parseInt(e.target.value) || 1 })}
                        min="1"
                        max="720"
                      />
                      <p className="text-xs text-slate-500 mt-2">How many hours back to search for alerts.</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 md:col-span-2">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Analysis Limit (Papers)</label>
                      <input 
                        type="number" 
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.analysisLimit}
                        onChange={(e) => setSettings({ ...settings, analysisLimit: parseInt(e.target.value) || 10 })}
                        min="1"
                        max="200"
                      />
                      <p className="text-xs text-slate-500 mt-2">Max number of papers to extract and analyze in a single batch.</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 md:col-span-2">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Processing Batch Size (Emails)</label>
                      <input 
                        type="number" 
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.batchSize}
                        onChange={(e) => setSettings({ ...settings, batchSize: parseInt(e.target.value) || 5 })}
                        min="1"
                        max="100"
                      />
                      <p className="text-xs text-slate-500 mt-2">Number of emails to send to AI in one session. Lower this if you encounter timeouts.</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 md:col-span-2">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Weekly Goal (Papers)</label>
                      <input
                        type="number"
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.weeklyGoal}
                        onChange={(e) => setSettings({ ...settings, weeklyGoal: parseInt(e.target.value) || 1 })}
                        min="1"
                        max="1000"
                      />
                      <p className="text-xs text-slate-500 mt-2">Target number of papers to analyze per week (for progress tracking).</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 md:col-span-2">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Minimum Relevance Score</label>
                      <input
                        type="number"
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.minScore}
                        onChange={(e) => setSettings({ ...settings, minScore: parseInt(e.target.value) || 0 })}
                        min="0"
                        max="100"
                      />
                      <p className="text-xs text-slate-500 mt-2">Papers with relevance score below this threshold will be filtered out (0-100).</p>
                    </div>
                  </div>
                </div>
              </div>

              <hr className="border-slate-100" />

              <div>
                <h2 className="text-2xl font-bold mb-2 flex items-center gap-3">
                  <CalendarClock className="w-6 h-6 text-blue-600" />
                  Scheduled Reports
                </h2>
                <p className="text-sm text-slate-500 mb-6">Configure automatic daily report generation. The scheduler runs as a separate process.</p>

                <div className="space-y-6">
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <label className="block text-sm font-bold text-slate-700">Enable Scheduled Reports</label>
                        <p className="text-xs text-slate-500 mt-1">Generate reports automatically at the specified time</p>
                      </div>
                      <button
                        onClick={async () => {
                          const newEnabled = !settings.schedulerEnabled;
                          setSettings({ ...settings, schedulerEnabled: newEnabled });
                          try {
                            await fetch('/api/scheduler-config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                enabled: newEnabled,
                                time: settings.schedulerTime,
                                timezone: settings.schedulerTimezone
                              })
                            });
                          } catch (e) {
                            console.error('Failed to save scheduler config', e);
                          }
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          settings.schedulerEnabled ? 'bg-blue-600' : 'bg-slate-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            settings.schedulerEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Report Time</label>
                      <input
                        type="time"
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.schedulerTime}
                        onChange={async (e) => {
                          const newTime = e.target.value;
                          setSettings({ ...settings, schedulerTime: newTime });
                          try {
                            await fetch('/api/scheduler-config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                enabled: settings.schedulerEnabled,
                                time: newTime,
                                timezone: settings.schedulerTimezone
                              })
                            });
                          } catch (e) {
                            console.error('Failed to save scheduler config', e);
                          }
                        }}
                      />
                      <p className="text-xs text-slate-500 mt-2">Time to generate daily reports</p>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <label className="block text-sm font-bold text-slate-700 mb-2">Timezone</label>
                      <select
                        className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={settings.schedulerTimezone}
                        onChange={async (e) => {
                          const newTimezone = e.target.value;
                          setSettings({ ...settings, schedulerTimezone: newTimezone });
                          try {
                            await fetch('/api/scheduler-config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                enabled: settings.schedulerEnabled,
                                time: settings.schedulerTime,
                                timezone: newTimezone
                              })
                            });
                          } catch (e) {
                            console.error('Failed to save scheduler config', e);
                          }
                        }}
                      >
                        <option value="Asia/Shanghai">Asia/Shanghai (CST)</option>
                        <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
                        <option value="America/New_York">America/New_York (EST)</option>
                        <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
                        <option value="Europe/London">Europe/London (GMT)</option>
                        <option value="Europe/Paris">Europe/Paris (CET)</option>
                        <option value="UTC">UTC</option>
                      </select>
                      <p className="text-xs text-slate-500 mt-2">Timezone for scheduled reports</p>
                    </div>
                  </div>

                  <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                    <p className="text-xs text-blue-800 mb-3">
                      <b>Note:</b> After changing settings, restart the scheduler for changes to take effect:
                    </p>
                    <div className="bg-white p-3 rounded-lg border border-blue-200 font-mono text-xs text-slate-700 space-y-1">
                      <p>pm2 restart scholarpulse-scheduler</p>
                    </div>
                  </div>

                  {/* Server-Side Gmail Auth for Scheduler */}
                  <div className="mt-6 p-4 bg-green-50 rounded-xl border border-green-200">
                    <h3 className="text-sm font-bold text-green-900 mb-3 flex items-center gap-2">
                      <Mail className="w-4 h-4" />
                      Server-Side Gmail Authorization
                    </h3>
                    <p className="text-xs text-green-800 mb-4">
                      For automatic email syncing, the scheduler needs server-side Gmail access with refresh tokens.
                      This is separate from browser-based auth and won't expire.
                    </p>

                    {serverAuthStatus.loading ? (
                      <div className="text-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-green-600" />
                      </div>
                    ) : serverAuthStatus.authorized ? (
                      <div className="flex items-center gap-3 p-3 bg-white rounded-lg border border-green-200">
                        <CheckCircle className="w-5 h-5 text-green-600" />
                        <div>
                          <p className="text-sm font-medium text-green-800">Server-Side Auth Active</p>
                          <p className="text-xs text-green-600">Scheduler can automatically sync emails</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Show redirect URI info */}
                        <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                          <p className="text-xs font-medium text-amber-800 mb-2">Redirect URI for Google Cloud Console:</p>
                          <code className="text-xs bg-white px-2 py-1 rounded border border-amber-200 block break-all">
                            {nipURL ? `${nipURL}/oauth2callback` : `${currentOrigin}/oauth2callback`}
                          </code>
                          {nipURL && currentOrigin !== nipURL && (
                            <p className="text-[10px] text-amber-700 mt-2">
                              ⚠️ You should access this app via <a href={nipURL} className="underline font-bold">{nipURL}</a> for OAuth to work correctly.
                            </p>
                          )}
                        </div>

                        {!serverAuthStatus.configured ? (
                          <>
                            <div className="space-y-3">
                              <div>
                                <label className="block text-xs font-medium text-green-800 mb-1">Client ID</label>
                                <input
                                  type="text"
                                  placeholder="xxx.apps.googleusercontent.com"
                                  className="w-full px-3 py-2 text-sm border border-green-200 rounded-lg bg-white"
                                  value={serverAuthConfig.client_id}
                                  onChange={(e) => setServerAuthConfig({ ...serverAuthConfig, client_id: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-green-800 mb-1">Client Secret</label>
                                <input
                                  type="password"
                                  placeholder="Your client secret"
                                  className="w-full px-3 py-2 text-sm border border-green-200 rounded-lg bg-white"
                                  value={serverAuthConfig.client_secret}
                                  onChange={(e) => setServerAuthConfig({ ...serverAuthConfig, client_secret: e.target.value })}
                                />
                                <p className="text-[10px] text-green-600 mt-1">
                                  Get this from Google Cloud Console → Credentials → OAuth 2.0 Client ID
                                </p>
                              </div>
                              <button
                                onClick={async () => {
                                  if (!serverAuthConfig.client_id || !serverAuthConfig.client_secret) {
                                    alert('Please enter both Client ID and Client Secret');
                                    return;
                                  }
                                  // Use nip.io URL if available
                                  const redirectUri = nipURL ? `${nipURL}/oauth2callback` : `${currentOrigin}/oauth2callback`;
                                  try {
                                    await fetch('/api/oauth2/config', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        client_id: serverAuthConfig.client_id,
                                        client_secret: serverAuthConfig.client_secret,
                                        redirect_uri: redirectUri
                                      })
                                    });
                                    await fetchServerAuthStatus();
                                  } catch (e) {
                                    alert('Failed to save config');
                                  }
                                }}
                                className="w-full px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
                              >
                                Save Configuration
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch('/api/oauth2/auth-url');
                                const data = await res.json();
                                if (data.url) {
                                  window.location.href = data.url;
                                }
                              } catch (e) {
                                alert('Failed to get authorization URL');
                              }
                            }}
                            className="w-full px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 flex items-center justify-center gap-2"
                          >
                            <Mail className="w-4 h-4" />
                            Authorize Gmail Access
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <hr className="border-slate-100" />

              <div>
                <h2 className="text-2xl font-bold mb-2">Google Integration Setup</h2>
                <p className="text-sm text-slate-500 mb-6">Follow these steps carefully to fix "access_denied" or "redirect_uri_mismatch".</p>
                
                <div className="space-y-6">
                  {/* Step 1: Client ID */}
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                    <label className="block text-sm font-bold text-slate-700 mb-2">Step 1: Enter OAuth Client ID</label>
                    <input 
                      type="text" 
                      className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
                      placeholder="xxx-yyy.apps.googleusercontent.com"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </div>

                  {/* Step 2: Whitelist Origin */}
                  <div className="p-4 bg-blue-50/50 rounded-xl border border-blue-100">
                    <label className="block text-sm font-bold text-blue-900 mb-2">Step 2: Whitelist this Origin</label>
                    <p className="text-xs text-blue-800 mb-3 leading-relaxed">
                      Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="font-bold underline inline-flex items-center gap-0.5">Google Cloud Console <ExternalLink className="w-3 h-3" /></a>, 
                      edit your Client ID, and add this exact URL to <b>Authorized JavaScript origins</b>:
                    </p>
                    <div className="flex items-center gap-2 bg-white p-2 rounded-lg border border-blue-200 mb-4">
                      <code className="text-xs font-bold text-blue-600 flex-1 break-all">{currentOrigin}</code>
                      <button 
                        onClick={() => copyToClipboard(currentOrigin)}
                        className="p-1.5 hover:bg-slate-100 rounded text-slate-500"
                        title="Copy to clipboard"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>

                    {nipURL && (
                      <div className="mt-4 p-3 bg-indigo-50 rounded-lg border border-indigo-100">
                        <p className="text-xs font-bold text-indigo-900 mb-2 flex items-center gap-1.5">
                          <PlusCircle className="w-3.5 h-3.5" />
                          Recommended: Use "Magic Domain" (nip.io)
                        </p>
                        <p className="text-[11px] text-indigo-800 mb-3">
                          Google often blocks raw IP addresses. Use this URL instead to trick Google into thinking it's a real domain:
                        </p>
                        <div className="flex items-center gap-2 bg-white p-2 rounded-lg border border-indigo-200">
                          <code className="text-xs font-bold text-indigo-600 flex-1 break-all">{nipURL}</code>
                          <button 
                            onClick={() => copyToClipboard(nipURL)}
                            className="p-1.5 hover:bg-slate-100 rounded text-slate-500"
                            title="Copy to clipboard"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="text-[10px] text-indigo-500 mt-2 italic">
                          Note: You must access the app using this URL in your browser for this to work.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Step 3: Troubleshooting Access Denied */}
                  <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                    <label className="block text-sm font-bold text-amber-900 mb-2 flex items-center gap-2">
                      <HelpCircle className="w-4 h-4" />
                      Getting Error 403: access_denied?
                    </label>
                    <ul className="text-xs text-amber-800 space-y-2 list-disc pl-4">
                      <li><b>Add Test User:</b> If your GCP project is in "Testing" mode, go to the <b>OAuth consent screen</b> tab in Google Console and add your email to the <b>Test users</b> list.</li>
                      <li><b>Grant Permission:</b> When the Google login popup appears, you <b>must check the box</b> that says <i>"View your email messages and settings"</i>. If unchecked, the app cannot read alerts.</li>
                    </ul>
                  </div>

                  {/* Step 4: Authorize */}
                  <div className="flex items-center justify-between p-6 bg-slate-900 text-white rounded-xl shadow-xl shadow-slate-200">
                    <div className="flex items-center gap-4">
                      {isAuthorized ? (
                        <div className="p-2 bg-green-500/20 text-green-400 rounded-full ring-4 ring-green-500/10"><CheckCircle className="w-6 h-6" /></div>
                      ) : (
                        <div className="p-2 bg-white/10 text-white/40 rounded-full"><AlertCircle className="w-6 h-6" /></div>
                      )}
                      <div>
                        <p className="text-sm font-bold">{isAuthorized ? 'Authenticated' : 'Step 4: Connect Account'}</p>
                        <p className="text-xs text-slate-400">{isAuthorized ? 'Ready to sync scholar alerts' : 'Open the Google login popup'}</p>
                      </div>
                    </div>
                    <button 
                      onClick={handleAuthorize}
                      disabled={!clientId}
                      className={`px-6 py-2 rounded-lg text-sm font-bold transition-all active:scale-95 ${
                        isAuthorized 
                        ? 'bg-slate-700 hover:bg-slate-600' 
                        : 'bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                      }`}
                    >
                      {isAuthorized ? 'Re-authorize' : 'Authorize Now'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <LogViewer isVisible={showLogs} onClose={() => setShowLogs(false)} />
      </main>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
};

export default App;
