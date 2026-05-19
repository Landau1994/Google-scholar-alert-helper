
import React, { useState } from 'react';
import { Search, Loader2, ExternalLink, Calendar, User, BookOpen, Download, Filter, FileText, Check } from 'lucide-react';
import { Paper } from '../types';

interface SearchResult extends Paper {
  _distance?: number;
}

type TimeFilter = 'all' | '7' | '30' | '90' | '365';

const ArchiveView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [journal, setJournal] = useState('');
  const [exactJournal, setExactJournal] = useState(false);
  const [days, setDays] = useState<TimeFilter>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExported, setIsExported] = useState(false);

  const handleSearch = async (e?: React.FormEvent, overrideDays?: TimeFilter) => {
    if (e) e.preventDefault();
    
    const activeDays = overrideDays || days;
    if (!query.trim() && !journal.trim() && activeDays === 'all') {
      return;
    }

    setIsLoading(true);
    setHasSearched(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.append('q', query.trim());
      if (journal.trim()) {
        params.append('source', journal.trim());
        if (exactJournal) params.append('exact_source', 'true');
      }
      params.append('limit', '50');
      if (activeDays !== 'all') params.append('days', activeDays);

      const response = await fetch(`/api/vector-search?${params.toString()}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Search failed with status ${response.status}`);
      }
      const data = await response.json();
      setResults(data);
    } catch (error: any) {
      console.error('Search error:', error);
      setError(error.message || 'An unexpected error occurred during search.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFilterChange = (newDays: TimeFilter) => {
    setDays(newDays);
    if (hasSearched && (query.trim() || journal.trim() || newDays !== 'all')) {
      handleSearch(undefined, newDays);
    }
  };

  const handleExport = () => {
    if (results.length === 0) return;
    
    setIsExporting(true);
    try {
      let markdown = `# ScholarPulse Historical Search Results\n\n`;
      markdown += `**Query**: ${query}\n`;
      if (journal.trim()) {
        markdown += `**Journal/Source**: ${journal.trim()} ${exactJournal ? '(Exact Match)' : '(Partial Match)'}\n`;
      }
      markdown += `**Filter**: ${days === 'all' ? 'All Time' : `Last ${days} Days`}\n`;
      markdown += `**Date**: ${new Date().toLocaleString()}\n`;
      markdown += `**Total Results**: ${results.length}\n\n`;
      markdown += `---\n\n`;

      results.forEach((paper, i) => {
        markdown += `### [${i + 1}] ${paper.title}\n`;
        markdown += `- **Authors**: ${paper.authors.join(', ')}\n`;
        markdown += `- **Source**: ${paper.source} (${paper.date})\n`;
        markdown += `- **Relevance**: ${paper.relevanceScore}%\n`;
        if (paper._distance !== undefined) {
          markdown += `- **Semantic Match**: ${(1 - paper._distance).toFixed(3)}\n`;
        }
        markdown += `- **Link**: [${paper.link}](${paper.link})\n`;
        markdown += `- **Snippet**: *${paper.snippet}*\n\n`;
      });

      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scholarpulse-search-${query.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setIsExported(true);
      setTimeout(() => setIsExported(false), 2000);
    } catch (err) {
      console.error('Export failed', err);
      alert('Failed to export results.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Historical Archive</h1>
          <p className="text-slate-600">Search through thousands of historical papers using semantic search.</p>
        </header>

        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm mb-8">
          <form onSubmit={handleSearch} className="mb-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter keywords or research topics (e.g., 'mTOR signaling')..."
                className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all text-lg"
              />
            </div>
            
            <div className="flex gap-3 items-start">
              <div className="relative flex-1 flex flex-col gap-2">
                <div className="relative">
                  <BookOpen className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="text"
                    value={journal}
                    onChange={(e) => setJournal(e.target.value)}
                    placeholder="Filter by journal or source (e.g., 'Nature', 'bioRxiv')..."
                    className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all text-sm"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-500 ml-2 cursor-pointer w-max font-medium">
                  <input 
                    type="checkbox" 
                    checked={exactJournal}
                    onChange={(e) => setExactJournal(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  Exact match (e.g., match "Nature" but not "Nature Medicine")
                </label>
              </div>
              <button
                type="submit"
                disabled={isLoading || (!query.trim() && !journal.trim() && days === 'all')}
                className="px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-900/20 active:scale-95 flex items-center gap-2 h-[46px]"
              >
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                  <>
                    <Search className="w-4 h-4" />
                    Search
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-6">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5" />
                Timeframe:
              </span>
              <div className="flex bg-slate-100 p-1 rounded-xl">
                {(['all', '7', '30', '90', '365'] as TimeFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => handleFilterChange(f)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      days === f
                        ? 'bg-white text-blue-600 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {f === 'all' ? 'All Time' : f === '365' ? '1 Year' : `${f} Days`}
                  </button>
                ))}
              </div>
            </div>

            {results.length > 0 && (
              <button
                onClick={handleExport}
                disabled={isExporting}
                className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-50"
              >
                {isExported ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-400" />
                    Exported!
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Export Markdown ({results.length})
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-center gap-3">
            <span className="font-bold">Error:</span> {error}
          </div>
        )}

        <div className="space-y-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <div className="relative w-16 h-16 mb-6">
                <div className="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-25"></div>
                <div className="relative bg-white border border-slate-200 w-16 h-16 rounded-full flex items-center justify-center shadow-sm">
                  <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                </div>
              </div>
              <p className="text-lg font-medium text-slate-600">Analyzing thousands of papers...</p>
              <p className="text-sm">Semantic search powered by LanceDB</p>
            </div>
          ) : hasSearched && results.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-16 text-center shadow-sm">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <Search className="w-10 h-10 text-slate-300" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">No matching papers found</h3>
              <p className="text-slate-500 max-w-sm mx-auto">
                Try adjusting your search terms, using broader topics, or extending the timeframe filter.
              </p>
            </div>
          ) : (
            results.map((paper) => (
              <div key={paper.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all group border-l-4 border-l-transparent hover:border-l-blue-500">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors leading-snug">
                      {paper.title}
                    </h3>
                  </div>
                  <div className="ml-4 flex flex-col items-end shrink-0">
                    <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-bold border border-blue-100">
                      Score: {paper.relevanceScore}%
                    </span>
                    {paper._distance !== undefined && (
                      <span className="text-[10px] font-mono text-slate-400 mt-1 uppercase tracking-tighter">
                        Sim: {(1 - paper._distance).toFixed(3)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-y-2 gap-x-4 text-xs text-slate-500 mb-4 font-medium">
                  <div className="flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-slate-400" />
                    <span className="line-clamp-1">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-slate-400" />
                    <span>{paper.source}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    <span>{paper.date}</span>
                  </div>
                </div>

                <p className="text-sm text-slate-600 leading-relaxed mb-5 line-clamp-3 italic bg-slate-50 p-3 rounded-xl border border-slate-100">
                  "{paper.snippet}"
                </p>

                <div className="flex items-center justify-between mt-auto">
                  <div className="flex gap-2">
                    {paper.matchedKeywords.slice(0, 3).map(kw => (
                      <span key={kw} className="px-2.5 py-1 bg-white border border-slate-200 text-slate-600 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                        {kw}
                      </span>
                    ))}
                  </div>
                  <a 
                    href={paper.link} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    View Source
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ArchiveView;
