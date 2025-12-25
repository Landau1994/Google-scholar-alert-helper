
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Paper, Keyword, DigestSummary, ViewState } from './types';
import { processScholarEmails } from './services/geminiService';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ImportView from './components/ImportView';
import KeywordManager from './components/KeywordManager';
import { Bell, BookOpen, Settings, LayoutDashboard, PlusCircle, Search, Mail, CheckCircle, AlertCircle, Loader2, Copy, ExternalLink, HelpCircle } from 'lucide-react';
import { GmailService } from './services/gmailService';

const INITIAL_KEYWORDS: Keyword[] = [
  { id: '1', text: 'Large Language Models', color: 'bg-blue-100 text-blue-700' },
  { id: '2', text: 'Graph Neural Networks', color: 'bg-purple-100 text-purple-700' },
  { id: '3', text: 'Multi-agent Reinforcement Learning', color: 'bg-green-100 text-green-700' }
];

const App: React.FC = () => {
  const [view, setView] = useState<ViewState>('dashboard');
  const [keywords, setKeywords] = useState<Keyword[]>(INITIAL_KEYWORDS);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [summary, setSummary] = useState<DigestSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Gmail Sync State
  const [clientId, setClientId] = useState(localStorage.getItem('scholar_pulse_client_id') || '');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const gmailServiceRef = useRef<GmailService | null>(null);

  // Get current origin for debugging/setup
  const currentOrigin = window.location.origin;

  useEffect(() => {
    if (clientId) {
      gmailServiceRef.current = new GmailService(
        clientId,
        (token) => {
          setIsAuthorized(true);
          localStorage.setItem('scholar_pulse_client_id', clientId);
        },
        (error) => {
          setIsAuthorized(false);
          console.error("Auth callback error:", error);
          if (error.error === 'access_denied') {
            alert("Access Denied: Please ensure you are added as a 'Test User' in your Google Cloud Project and that you check the 'View email messages' box during login.");
          } else if (error.error === 'popup_closed_by_user') {
            alert("Authorization window was closed.");
          } else if (error.error === 'idpiframe_initialization_failed') {
            alert("Initialization failed. This usually happens if third-party cookies are blocked.");
          }
        }
      );
    }
  }, [clientId]);

  const handleAuthorize = () => {
    if (!clientId) {
      alert("Please enter a Client ID first.");
      return;
    }
    
    try {
      if (!gmailServiceRef.current) {
        gmailServiceRef.current = new GmailService(
          clientId,
          () => setIsAuthorized(true),
          () => setIsAuthorized(false)
        );
      }
      gmailServiceRef.current.requestToken();
    } catch (err) {
      alert("Authorization failed. Ensure the Google script is loaded and your Client ID is correct.");
      console.error(err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  const syncFromGmail = async () => {
    if (!isAuthorized) {
      alert("Please authorize with Google in Settings first.");
      setView('settings');
      return;
    }

    setIsLoading(true);
    try {
      const content = await gmailServiceRef.current?.fetchScholarEmails();
      if (!content || !content.trim()) {
        alert("No Scholar emails found in your recent messages (checked last 15). Note that only 'Scholar Alert' emails from scholaralerts-noreply@google.com are processed.");
        return;
      }
      await handleImport(content);
    } catch (error) {
      console.error("Sync error:", error);
      alert("Error syncing from Gmail. You may need to re-authorize.");
      setIsAuthorized(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async (rawContent: string) => {
    setIsLoading(true);
    try {
      const keywordTexts = keywords.map(k => k.text);
      const result = await processScholarEmails(rawContent, keywordTexts);
      setPapers(result.papers);
      setSummary(result.summary);
      setView('dashboard');
    } catch (error) {
      console.error("AI Process error:", error);
      alert("Error processing content with AI. Please check your API key or input.");
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

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      <Sidebar currentView={view} setView={setView} />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-8 shrink-0 z-10">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-slate-800">
              {view === 'dashboard' && 'Academic Dashboard'}
              {view === 'import' && 'Import Alerts'}
              {view === 'keywords' && 'My Interests'}
              {view === 'settings' && 'Settings'}
            </h1>
            {isLoading && (
              <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-600 rounded-full text-xs font-medium">
                <Loader2 className="w-3 h-3 animate-spin" />
                Processing...
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={syncFromGmail}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-all shadow-md shadow-blue-200 disabled:opacity-50"
            >
              <Mail className="w-4 h-4" />
              Sync Gmail
            </button>
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-white text-sm font-bold">U</div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {view === 'dashboard' && <Dashboard papers={papers} summary={summary} keywords={keywords} onGoToImport={() => setView('import')} />}
          {view === 'import' && <ImportView onImport={handleImport} isProcessing={isLoading} onSyncGmail={syncFromGmail} isAuthorized={isAuthorized} />}
          {view === 'keywords' && <KeywordManager keywords={keywords} onAdd={addKeyword} onRemove={removeKeyword} />}
          {view === 'settings' && (
            <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl shadow-sm border border-slate-200 space-y-8 animate-in fade-in duration-500">
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
                    <div className="flex items-center gap-2 bg-white p-2 rounded-lg border border-blue-200">
                      <code className="text-xs font-bold text-blue-600 flex-1 break-all">{currentOrigin}</code>
                      <button 
                        onClick={() => copyToClipboard(currentOrigin)}
                        className="p-1.5 hover:bg-slate-100 rounded text-slate-500"
                        title="Copy to clipboard"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
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
      </main>
    </div>
  );
};

export default App;
