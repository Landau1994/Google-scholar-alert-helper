import React, { useState, useEffect, useMemo } from 'react';
import { CalendarClock, FileText, BookOpen, Download, RefreshCw, Clock, Copy, Check, Search, Code, Eye, Loader2, AlertCircle } from 'lucide-react';
import { ScheduledReportItem } from '../types';
import MarkdownRenderer from './MarkdownRenderer';

interface ScheduledReportsProps {
  onViewReport: (content: string, filename: string) => void;
}

const PAGE_SIZE = 30;

const ScheduledReports: React.FC<ScheduledReportsProps> = ({ onViewReport }) => {
  const [reports, setReports] = useState<ScheduledReportItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'review' | 'papers'>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const fetchReports = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/scheduled-reports');
      if (!res.ok) {
        throw new Error(`Failed to fetch scheduled reports (HTTP ${res.status})`);
      }
      const data = await res.json();
      setReports(data);
    } catch (e: any) {
      console.error('Failed to fetch scheduled reports', e);
      setError(e.message || 'Failed to load scheduled reports.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const loadReport = async (filename: string) => {
    setIsLoadingContent(true);
    setError(null);
    try {
      const res = await fetch(`/api/load-scheduled-report?filename=${encodeURIComponent(filename)}`);
      if (!res.ok) {
        throw new Error(`Failed to load report (HTTP ${res.status})`);
      }
      const data = await res.json();
      setSelectedReport(filename);
      setReportContent(data.content);
      onViewReport(data.content, filename);
    } catch (e: any) {
      console.error('Failed to load report', e);
      setError(e.message || 'Failed to load selected report.');
    } finally {
      setIsLoadingContent(false);
    }
  };

  const downloadReport = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (content: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = content;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!ok) throw new Error('execCommand copy failed');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy', e);
      const truncated = content.length > 1000 ? content.substring(0, 1000) + '...\n\n[Truncated. Please use Download instead.]' : content;
      prompt('Copy failed. Please copy manually (Ctrl+C):', truncated);
    }
  };

  const filteredReports = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return reports.filter((report) => {
      if (typeFilter !== 'all' && report.type !== typeFilter) return false;
      if (!q) return true;
      return report.filename.toLowerCase().includes(q) || report.date.toLowerCase().includes(q);
    });
  }, [reports, searchQuery, typeFilter]);

  const visibleReports = useMemo(
    () => filteredReports.slice(0, visibleCount),
    [filteredReports, visibleCount]
  );

  // Group visible reports by date
  const groupedReports = useMemo(() => {
    return visibleReports.reduce((acc, report) => {
      const dateKey = report.date.split(',')[0] || report.date.split(' ')[0];
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(report);
      return acc;
    }, {} as Record<string, ScheduledReportItem[]>);
  }, [visibleReports]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
            <CalendarClock className="w-7 h-7 text-blue-600" />
            Scheduled Daily Reports
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Automatically generated reports from the scheduler ({reports.length} total files)
          </p>
        </div>
        <button
          onClick={fetchReports}
          disabled={isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {reports.length === 0 && !isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No Scheduled Reports Yet</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Scheduled reports will appear here after the scheduler runs. Make sure the scheduler is running with pm2.
          </p>
          <div className="mt-6 p-4 bg-slate-50 rounded-xl text-left max-w-md mx-auto">
            <p className="text-xs font-mono text-slate-600">
              pm2 start "npm run scheduler" --name scholarpulse-scheduler
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Reports List */}
          <div className="lg:col-span-1 space-y-4">
            {/* Search & Type Filter */}
            <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  placeholder="Filter by date or filename..."
                  className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                {(['all', 'review', 'papers'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTypeFilter(t);
                      setVisibleCount(PAGE_SIZE);
                    }}
                    className={`flex-1 py-1 text-xs font-semibold rounded-md transition-colors ${
                      typeFilter === t ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {t === 'all' ? 'All' : t === 'review' ? 'Reviews' : 'Paper Lists'}
                  </button>
                ))}
              </div>
            </div>

            {filteredReports.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-xs text-slate-500">
                No reports match your filter.
              </div>
            ) : (
              <>
                <div className="space-y-4 max-h-[68vh] overflow-y-auto pr-1">
                  {Object.entries(groupedReports).map(([date, dateReports]: [string, ScheduledReportItem[]]) => (
                    <div key={date} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                        <h3 className="text-xs font-semibold text-slate-700">{date}</h3>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {dateReports.map((report) => (
                          <button
                            key={report.filename}
                            onClick={() => loadReport(report.filename)}
                            className={`w-full px-4 py-3 text-left hover:bg-slate-50 transition-colors flex items-center gap-3 ${
                              selectedReport === report.filename ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                            }`}
                          >
                            {report.type === 'review' ? (
                              <BookOpen className="w-4 h-4 text-purple-500 shrink-0" />
                            ) : (
                              <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-slate-700 truncate">
                                {report.type === 'review' ? 'Literature Review' : 'Paper List'}
                              </p>
                              <p className="text-xs text-slate-400 truncate">{report.filename}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {visibleCount < filteredReports.length && (
                  <button
                    onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                    className="w-full py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    Load more ({filteredReports.length - visibleCount} remaining)
                  </button>
                )}
              </>
            )}
          </div>

          {/* Report Content */}
          <div className="lg:col-span-2">
            {isLoadingContent ? (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center h-full flex flex-col items-center justify-center">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-3" />
                <p className="text-sm text-slate-500">Loading report...</p>
              </div>
            ) : selectedReport && reportContent ? (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-700 truncate">{selectedReport}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setViewMode(m => (m === 'rendered' ? 'raw' : 'rendered'))}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-50 transition-all"
                      title="Toggle between formatted Markdown and raw text"
                    >
                      {viewMode === 'rendered' ? <Code className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {viewMode === 'rendered' ? 'Raw' : 'Formatted'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(reportContent)}
                      className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs font-medium transition-all ${
                        copied
                          ? 'bg-green-50 border-green-200 text-green-600'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={() => downloadReport(selectedReport, reportContent)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-50 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>
                </div>
                <div className="p-6 max-h-[75vh] overflow-y-auto">
                  {viewMode === 'rendered' ? (
                    <MarkdownRenderer content={reportContent} />
                  ) : (
                    <pre className="whitespace-pre-wrap text-xs text-slate-700 font-mono leading-relaxed">
                      {reportContent}
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center h-full flex items-center justify-center">
                <div>
                  <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-sm text-slate-500">Select a report to view its contents</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ScheduledReports;
