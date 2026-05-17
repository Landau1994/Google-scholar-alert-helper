
import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, Sparkles, TrendingUp, BookOpen, ChevronRight, Layers, X, ExternalLink, User, Calendar, FileText, Copy, Check } from 'lucide-react';
import { Paper } from '../types';
import { generateLiteratureReview } from '../services/geminiService';

interface Theme {
  id: string;
  name: string;
  summary: string;
  paperCount: number;
  keyPapers: string[];
  growth: 'rising' | 'stable' | 'fading';
}

interface ThemeStats {
  totalPapers: number;
  clusterCount: number;
}

type TimeFilter = 'all' | '7d' | '30d' | '90d' | '1y';

const ThemesView: React.FC = () => {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [stats, setStats] = useState<ThemeStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Modal State
  const [exploringTheme, setExploringTheme] = useState<Theme | null>(null);
  const [themePapers, setThemePapers] = useState<Paper[]>([]);
  const [isExploring, setIsExploring] = useState(false);
  
  // Summary State
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [generatedSummary, setGeneratedSummary] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  
  // Custom Theme State
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [customThemeName, setCustomThemeName] = useState('');

  const generateThemes = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/theme-insights');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to fetch themes with status ${response.status}`);
      }
      const data = await response.json();
      
      setThemes(data.themes);
      setStats(data.stats);
      setHasData(true);
    } catch (error: any) {
      console.error('Error generating themes:', error);
      setError(error.message || 'An unexpected error occurred while generating insights.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleExplore = async (theme: Theme) => {
    setExploringTheme(theme);
    setIsExploring(true);
    setTimeFilter('all');
    setGeneratedSummary(null);
    try {
      // Fetch more papers to allow filtering by time
      const response = await fetch(`/api/vector-search?q=${encodeURIComponent(theme.name)}&limit=50`);
      if (!response.ok) throw new Error('Search failed');
      const data = await response.json();
      setThemePapers(data);
    } catch (error) {
      console.error('Explore error:', error);
      setThemePapers([]);
    } finally {
      setIsExploring(false);
    }
  };

  const handleAddCustomTheme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customThemeName.trim()) return;

    const newTheme: Theme = {
      id: `custom-${Date.now()}`,
      name: customThemeName.trim(),
      summary: 'Custom tracked theme.',
      paperCount: 0, // Will be updated when explored
      keyPapers: [],
      growth: 'stable'
    };

    setThemes(prev => [newTheme, ...prev]);
    setIsAddingCustom(false);
    setCustomThemeName('');
    handleExplore(newTheme);
  };

  const filteredPapers = useMemo(() => {
    if (timeFilter === 'all') return themePapers;
    const now = Date.now();
    return themePapers.filter(p => {
      if (!p.date) return true;
      const pDate = new Date(p.date).getTime();
      if (isNaN(pDate)) return true;
      
      if (timeFilter === '7d') return now - pDate <= 7 * 24 * 60 * 60 * 1000;
      if (timeFilter === '30d') return now - pDate <= 30 * 24 * 60 * 60 * 1000;
      if (timeFilter === '90d') return now - pDate <= 90 * 24 * 60 * 60 * 1000;
      if (timeFilter === '1y') return now - pDate <= 365 * 24 * 60 * 60 * 1000;
      return true;
    });
  }, [themePapers, timeFilter]);

  const handleGenerateSummary = async () => {
    if (!exploringTheme || filteredPapers.length === 0) return;
    
    setIsGeneratingSummary(true);
    setGeneratedSummary(null);
    try {
      // Generate AI review
      const reviewText = await generateLiteratureReview(filteredPapers.slice(0, 30), [exploringTheme.name]);
      
      // Append citation list
      let finalText = reviewText + "\n\n### References\n";
      filteredPapers.slice(0, 30).forEach((p, i) => {
        const authors = p.authors?.length ? p.authors.join(', ') : 'Unknown authors';
        finalText += `[${i + 1}] ${p.title}. *${authors}*. ${p.source} (${p.date || 'Unknown Date'}).\n`;
      });
      
      setGeneratedSummary(finalText);
    } catch (err: any) {
      console.error('Failed to generate summary:', err);
      alert('Failed to generate summary: ' + (err.message || 'Unknown error'));
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  const copyToClipboard = async () => {
    if (!generatedSummary) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(generatedSummary);
      } else {
        // Fallback for HTTP: use legacy execCommand
        const textArea = document.createElement('textarea');
        textArea.value = generatedSummary;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!success) throw new Error('execCommand failed');
      }
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed', err);
      // Final fallback: show text in a prompt for manual copy if both methods fail
      const truncated = generatedSummary.length > 1000 ? generatedSummary.substring(0, 1000) + '...\n\n[Text truncated. Please copy manually.]' : generatedSummary;
      prompt('Copy failed. Please copy manually (Ctrl+C):', truncated);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8 relative">
      {/* Existing Header and Content */}
      <div className="max-w-5xl mx-auto">
        <header className="mb-8 flex justify-between items-end">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Theme Insights</h1>
            <p className="text-slate-600">AI-powered clustering of historical papers to identify research trends.</p>
          </div>
          {(!hasData || error) && !isLoading && (
            <button
              onClick={generateThemes}
              className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-900/20 transition-all active:scale-95"
            >
              <Sparkles className="w-5 h-5" />
              {error ? 'Retry Insights' : 'Generate Insights'}
            </button>
          )}
        </header>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-center gap-3">
            <span className="font-bold">Error:</span> {error}
          </div>
        )}

        {isLoading ? (
          <div className="bg-white border border-slate-200 rounded-3xl p-12 text-center shadow-sm">
            <div className="relative w-24 h-24 mx-auto mb-6">
              <div className="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-25"></div>
              <div className="relative bg-blue-50 w-24 h-24 rounded-full flex items-center justify-center">
                <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
              </div>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Analyzing Research Landscape</h2>
            <p className="text-slate-500 max-w-md mx-auto">
              Our AI is currently clustering your vectorized papers into semantic themes and identifying emerging trends...
            </p>
          </div>
        ) : !hasData ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl p-6 opacity-40">
                <div className="w-10 h-10 bg-slate-100 rounded-lg mb-4"></div>
                <div className="h-4 bg-slate-100 rounded w-3/4 mb-2"></div>
                <div className="h-3 bg-slate-100 rounded w-full mb-1"></div>
                <div className="h-3 bg-slate-100 rounded w-5/6"></div>
              </div>
            ))}
            <div className="md:col-span-3 text-center py-10">
              <p className="text-slate-400 italic">Click "Generate Insights" to start the analysis.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-blue-600 rounded-2xl p-6 text-white shadow-lg shadow-blue-900/20">
                <TrendingUp className="w-8 h-8 mb-4 opacity-80" />
                <div className="text-3xl font-bold mb-1">
                  {themes.filter(t => t.growth === 'rising').length}
                </div>
                <div className="text-sm font-medium opacity-80">Emerging High-Growth Themes</div>
              </div>
              <div className="bg-slate-900 rounded-2xl p-6 text-white shadow-lg shadow-slate-900/20">
                <Layers className="w-8 h-8 mb-4 opacity-80 text-blue-400" />
                <div className="text-3xl font-bold mb-1">{stats?.totalPapers || 0}</div>
                <div className="text-sm font-medium opacity-80">Papers Analyzed</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                <BookOpen className="w-8 h-8 mb-4 text-blue-600" />
                <div className="text-3xl font-bold mb-1 text-slate-900">{stats?.clusterCount || 0}</div>
                <div className="text-sm font-medium text-slate-500">Distinct Research Clusters</div>
              </div>
            </div>

            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-4">
              <TrendingUp className="w-5 h-5 text-blue-600" />
              Identified Theme Clusters
            </h2>

            {isAddingCustom ? (
              <form onSubmit={handleAddCustomTheme} className="mb-6 bg-white p-4 rounded-2xl border border-blue-200 shadow-sm flex items-center gap-3">
                <input
                  type="text"
                  value={customThemeName}
                  onChange={(e) => setCustomThemeName(e.target.value)}
                  placeholder="Enter a research topic (e.g., Marfan Syndrome)"
                  className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  autoFocus
                />
                <button type="submit" disabled={!customThemeName.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50">
                  Track
                </button>
                <button type="button" onClick={() => setIsAddingCustom(false)} className="px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-semibold">
                  Cancel
                </button>
              </form>
            ) : (
              <div className="mb-6 flex">
                <button 
                  onClick={() => setIsAddingCustom(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm font-semibold hover:border-blue-300 hover:text-blue-600 transition-colors shadow-sm"
                >
                  <Sparkles className="w-4 h-4" />
                  Track Custom Theme
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {themes.map(theme => (
                <div key={theme.id} className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all flex flex-col border-l-4 border-l-blue-500">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-bold text-slate-900 leading-tight pr-4">{theme.name}</h3>
                    {theme.growth === 'rising' && (
                      <span className="shrink-0 flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-[10px] font-bold uppercase tracking-wider border border-emerald-100">
                        <TrendingUp className="w-3 h-3" />
                        Rising
                      </span>
                    )}
                  </div>
                  
                  <p className="text-sm text-slate-600 mb-6 flex-1 italic leading-relaxed">
                    "{theme.summary}"
                  </p>

                  <div className="space-y-3 mb-6">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Key References</p>
                    {theme.keyPapers.map((paper, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-xs text-slate-700">
                        <ChevronRight className="w-3 h-3 mt-0.5 text-blue-500 shrink-0" />
                        <span className="line-clamp-1">{paper}</span>
                      </div>
                    ))}
                  </div>

                  <div className="pt-4 border-t border-slate-100 flex justify-between items-center">
                    <span className="text-xs font-medium text-slate-400">{theme.paperCount} Papers in cluster</span>
                    <button 
                      onClick={() => handleExplore(theme)}
                      className="text-xs font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors"
                    >
                      Explore Cluster
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Explore Cluster Modal */}
      {exploringTheme && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-slate-100 flex items-start justify-between bg-slate-50">
              <div className="flex-1 mr-4">
                <h2 className="text-xl font-bold text-slate-900 mb-1">
                  Theme: {exploringTheme.name}
                </h2>
                <div className="flex items-center gap-4 mt-3">
                  <div className="flex items-center gap-2 bg-white rounded-lg border border-slate-200 p-1 overflow-x-auto">
                    <button onClick={() => setTimeFilter('all')} className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${timeFilter === 'all' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>All Time</button>
                    <button onClick={() => setTimeFilter('7d')} className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${timeFilter === '7d' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>Last 7 Days</button>
                    <button onClick={() => setTimeFilter('30d')} className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${timeFilter === '30d' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>Last 30 Days</button>
                    <button onClick={() => setTimeFilter('90d')} className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${timeFilter === '90d' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>Last 90 Days</button>
                    <button onClick={() => setTimeFilter('1y')} className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${timeFilter === '1y' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>Last Year</button>
                  </div>
                  
                  <button 
                    onClick={handleGenerateSummary}
                    disabled={isGeneratingSummary || isExploring || filteredPapers.length === 0}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 transition-colors shadow-sm"
                  >
                    {isGeneratingSummary ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                    Generate Summary ({filteredPapers.length})
                  </button>
                </div>
              </div>
              <button 
                onClick={() => setExploringTheme(null)}
                className="p-2 hover:bg-slate-200 rounded-full transition-colors shrink-0"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50">
              {isExploring ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-4" />
                  <p className="text-sm font-medium text-slate-600">Finding related papers...</p>
                </div>
              ) : filteredPapers.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <BookOpen className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                  <p>No papers found for this theme in the selected timeframe.</p>
                </div>
              ) : generatedSummary ? (
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm relative">
                  <button 
                    onClick={copyToClipboard}
                    className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition-colors flex items-center gap-2 text-xs font-bold"
                  >
                    {isCopied ? <><Check className="w-4 h-4 text-emerald-600" /> Copied</> : <><Copy className="w-4 h-4" /> Copy</>}
                  </button>
                  <div className="prose prose-sm prose-blue max-w-none prose-headings:font-bold prose-a:text-blue-600">
                    {/* Render basic markdown since we might not have react-markdown installed. Using a simple split for now or just pre-wrap */}
                    <div className="whitespace-pre-wrap font-sans text-slate-700 leading-relaxed">
                      {generatedSummary}
                    </div>
                  </div>
                  <div className="mt-8 pt-4 border-t border-slate-100">
                    <button 
                      onClick={() => setGeneratedSummary(null)}
                      className="text-sm text-blue-600 hover:text-blue-700 font-semibold"
                    >
                      ← Back to Paper List
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-4">
                    <BookOpen className="w-4 h-4" />
                    Top Papers ({filteredPapers.length})
                  </h3>
                  {filteredPapers.map((paper, idx) => (
                    <div key={paper.id || idx} className="p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-300 transition-colors shadow-sm">
                      <h4 className="text-sm font-bold text-slate-900 mb-2 leading-snug">
                        {paper.title}
                      </h4>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-3">
                        {paper.authors && paper.authors.length > 0 && (
                          <div className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            <span className="line-clamp-1">{paper.authors.join(', ')}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>{paper.date || 'Recent'}</span>
                        </div>
                        <span className="px-2 py-0.5 bg-slate-100 rounded font-medium text-slate-700">
                          {paper.source}
                        </span>
                      </div>
                      {paper.snippet && (
                        <p className="text-xs text-slate-600 line-clamp-2 mb-3 italic">
                          "{paper.snippet}"
                        </p>
                      )}
                      {paper.link && (
                        <a 
                          href={paper.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700"
                        >
                          Read Source <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemesView;
