
import React, { useState } from 'react';
import { Search, Loader2, ExternalLink, Calendar, User, BookOpen } from 'lucide-react';
import { Paper } from '../types';

interface SearchResult extends Paper {
  _distance?: number;
}

const ArchiveView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setHasSearched(true);
    setError(null);
    try {
      const response = await fetch(`/api/vector-search?q=${encodeURIComponent(query)}&limit=30`);
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

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Historical Archive</h1>
          <p className="text-slate-600">Search through thousands of historical papers using semantic search.</p>
        </header>

        <form onSubmit={handleSearch} className="mb-8 relative">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter keywords or research topics (e.g., 'mTOR signaling in aortic aneurysm')..."
              className="w-full pl-12 pr-24 py-4 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg"
            />
            <button
              type="submit"
              disabled={isLoading || !query.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-6 py-2 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Search'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400 ml-4">
            AI-powered semantic search finds relevant papers even without exact keyword matches.
          </p>
        </form>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-center gap-3">
            <span className="font-bold">Error:</span> {error}
          </div>
        )}

        <div className="space-y-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <Loader2 className="w-12 h-12 animate-spin mb-4 text-blue-500" />
              <p className="text-lg">Analyzing thousands of papers...</p>
            </div>
          ) : hasSearched && results.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Search className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-medium text-slate-900 mb-1">No matching papers found</h3>
              <p className="text-slate-500">Try adjusting your search terms or using broader topics.</p>
            </div>
          ) : (
            results.map((paper) => (
              <div key={paper.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow group">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors leading-snug">
                      {paper.title}
                    </h3>
                  </div>
                  <div className="ml-4 flex flex-col items-end shrink-0">
                    <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-bold border border-blue-100">
                      Score: {paper.relevanceScore}
                    </span>
                    {paper._distance !== undefined && (
                      <span className="text-[10px] text-slate-400 mt-1">
                        Rel: {(1 - paper._distance).toFixed(3)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-y-2 gap-x-4 text-xs text-slate-500 mb-4">
                  <div className="flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />
                    <span className="line-clamp-1">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>{paper.source}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{paper.date}</span>
                  </div>
                </div>

                <p className="text-sm text-slate-600 leading-relaxed mb-4 line-clamp-3 italic">
                  "{paper.snippet}"
                </p>

                <div className="flex items-center justify-between mt-auto">
                  <div className="flex gap-2">
                    {paper.matchedKeywords.slice(0, 3).map(kw => (
                      <span key={kw} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                        {kw}
                      </span>
                    ))}
                  </div>
                  <a 
                    href={paper.link} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700"
                  >
                    View Paper
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
