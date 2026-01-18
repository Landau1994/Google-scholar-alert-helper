import React, { useState, useEffect } from 'react';
import { CalendarClock, FileText, BookOpen, Download, RefreshCw, Clock, Copy, Check } from 'lucide-react';
import { ScheduledReportItem } from '../types';

interface ScheduledReportsProps {
  onViewReport: (content: string, filename: string) => void;
}

const ScheduledReports: React.FC<ScheduledReportsProps> = ({ onViewReport }) => {
  const [reports, setReports] = useState<ScheduledReportItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const fetchReports = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/scheduled-reports');
      if (res.ok) {
        const data = await res.json();
        setReports(data);
      }
    } catch (e) {
      console.error('Failed to fetch scheduled reports', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const loadReport = async (filename: string) => {
    try {
      const res = await fetch(`/api/load-scheduled-report?filename=${encodeURIComponent(filename)}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedReport(filename);
        setReportContent(data.content);
      }
    } catch (e) {
      console.error('Failed to load report', e);
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
      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
      } else {
        // Fallback for non-secure contexts
        const textArea = document.createElement('textarea');
        textArea.value = content;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy', e);
      alert('Failed to copy to clipboard');
    }
  };

  // Group reports by date
  const groupedReports = reports.reduce((acc, report) => {
    const dateKey = report.date.split(',')[0] || report.date.split(' ')[0];
    if (!acc[dateKey]) {
      acc[dateKey] = [];
    }
    acc[dateKey].push(report);
    return acc;
  }, {} as Record<string, ScheduledReportItem[]>);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
            <CalendarClock className="w-7 h-7 text-blue-600" />
            Scheduled Daily Reports
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Automatically generated reports from the scheduler (runs daily at 8:00 AM)
          </p>
        </div>
        <button
          onClick={fetchReports}
          disabled={isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

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
            {Object.entries(groupedReports).map(([date, dateReports]: [string, ScheduledReportItem[]]) => (
              <div key={date} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                  <h3 className="text-sm font-semibold text-slate-700">{date}</h3>
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

          {/* Report Content */}
          <div className="lg:col-span-2">
            {selectedReport && reportContent ? (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700 truncate">{selectedReport}</h3>
                  <div className="flex items-center gap-2">
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
                <div className="p-6 max-h-[70vh] overflow-y-auto">
                  <div className="prose prose-sm prose-slate max-w-none">
                    <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans leading-relaxed">
                      {reportContent}
                    </pre>
                  </div>
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
