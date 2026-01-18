
import React, { useState } from 'react';
import { Upload, Clipboard, Send, Info, Bookmark, TrendingUp, Mail } from 'lucide-react';

interface ImportViewProps {
  onImport: (content: string) => void;
  isProcessing: boolean;
  onSyncGmail: () => void;
  isAuthorized: boolean;
}

const ImportView: React.FC<ImportViewProps> = ({ onImport, isProcessing, onSyncGmail, isAuthorized }) => {
  const [content, setContent] = useState('');

  const handleSubmit = () => {
    if (!content.trim()) return;
    onImport(content);
  };

  const handlePasteSample = () => {
    const sample = `
      Google Scholar Alert: Large Language Models
      New results for [large language models]
      
      Paper: "Emergent Abilities of Large Language Models"
      Authors: J Wei, Y Tay, R Bommasani, C Raffel... - Transactions on Machine Learning Research, 2022
      Description: We discuss emergent abilities of large language models.
      Link: https://scholar.google.com/scholar?cluster=12345
    `;
    setContent(sample);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-8 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-800 mb-2">Import Alert Content</h2>
            <p className="text-slate-500 text-sm">
              Sync directly from Gmail or paste raw text content from your Google Scholar alert emails.
            </p>
          </div>
          <button 
            onClick={onSyncGmail}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all shadow-lg ${
              isAuthorized 
              ? 'bg-blue-600 text-white shadow-blue-200 hover:bg-blue-700' 
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Mail className="w-5 h-5" />
            {isAuthorized ? 'Sync from Gmail' : 'Configure Gmail'}
          </button>
        </div>
        
        <div className="p-8">
          <div className="relative group">
            <textarea
              className="w-full h-80 p-6 bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl focus:border-blue-500 focus:ring-0 transition-all text-sm font-mono text-slate-600 resize-none"
              placeholder="Or paste email content here... (Ctrl+V)"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isProcessing}
            />
            {content.length === 0 && !isProcessing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-50">
                <Clipboard className="w-12 h-12 text-slate-300 mb-2" />
                <p className="text-sm font-medium">Manual Paste Area</p>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <button 
              onClick={handlePasteSample}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1.5"
              disabled={isProcessing}
            >
              <Info className="w-4 h-4" />
              Use sample data
            </button>
            <button 
              onClick={handleSubmit}
              disabled={!content.trim() || isProcessing}
              className={`px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-all ${
                !content.trim() || isProcessing
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-slate-900 text-white shadow-lg'
              }`}
            >
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Processing...
                </>
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  Analyze Manual Input
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 bg-blue-50/50 rounded-2xl border border-blue-100 flex gap-4 items-start">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg"><Info className="w-5 h-5" /></div>
          <div>
            <h4 className="font-bold text-blue-900 text-sm mb-1">Gmail Sync</h4>
            <p className="text-blue-800/70 text-xs leading-relaxed">
              We automatically sync alerts from Google Scholar, Nature, and others.
            </p>
          </div>
        </div>
        <div className="p-6 bg-purple-50/50 rounded-2xl border border-purple-100 flex gap-4 items-start">
          <div className="p-2 bg-purple-100 text-purple-600 rounded-lg"><Bookmark className="w-5 h-5" /></div>
          <div>
            <h4 className="font-bold text-purple-900 text-sm mb-1">Smart Extraction</h4>
            <p className="text-purple-800/70 text-xs leading-relaxed">
              Gemini reads messy email text and extracts clear paper titles, authors, and links.
            </p>
          </div>
        </div>
        <div className="p-6 bg-green-50/50 rounded-2xl border border-green-100 flex gap-4 items-start">
          <div className="p-2 bg-green-100 text-green-600 rounded-lg"><TrendingUp className="w-5 h-5" /></div>
          <div>
            <h4 className="font-bold text-green-900 text-sm mb-1">Trends Discovery</h4>
            <p className="text-green-800/70 text-xs leading-relaxed">
              Identify key research shifts across multiple email alerts instantly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImportView;
