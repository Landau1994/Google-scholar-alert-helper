
import React, { useState } from 'react';
import { RawEmail, Paper } from '../types';
import { CheckCircle, Clock, FileText, ArrowRight, Trash2, Eye, ChevronDown, ChevronUp, Loader2, ExternalLink } from 'lucide-react';

interface PreviewProps {
  emails: RawEmail[];
  onConfirm: (selectedEmails: RawEmail[]) => void;
  onCancel: () => void;
  onAnalyze: (email: RawEmail) => Promise<Paper[]>;
}

const Preview: React.FC<PreviewProps> = ({ emails, onConfirm, onCancel, onAnalyze }) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(emails.map(e => e.id)));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [analyzedPapers, setAnalyzedPapers] = useState<Record<string, Paper[]>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const toggleEmail = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleExpand = async (e: React.MouseEvent, email: RawEmail) => {
    e.stopPropagation();
    if (expandedId === email.id) {
      setExpandedId(null);
      return;
    }
    
    setExpandedId(email.id);
    
    if (!analyzedPapers[email.id]) {
      setIsAnalyzing(true);
      try {
        const papers = await onAnalyze(email);
        setAnalyzedPapers(prev => ({...prev, [email.id]: papers}));
      } catch (err) {
        console.error(err);
        alert("Failed to analyze email content.");
      } finally {
        setIsAnalyzing(false);
      }
    }
  };

  const handleConfirm = () => {
    const selected = emails.filter(e => selectedIds.has(e.id));
    onConfirm(selected);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Preview Emails</h2>
          <p className="text-slate-500">Review fetched alerts before processing.</p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={onCancel}
            className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleConfirm}
            disabled={selectedIds.size === 0}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
          >
            Process {selectedIds.size} Emails
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <span className="text-xs font-bold uppercase text-slate-500 tracking-wider">
            {emails.length} Emails found
          </span>
          <div className="flex gap-3">
            <button
              onClick={() => setSelectedIds(new Set(emails.map(e => e.id)))}
              className="text-xs font-bold text-blue-600 hover:text-blue-700"
            >
              Select All
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs font-bold text-slate-500 hover:text-slate-700"
            >
              Unselect All
            </button>
          </div>
        </div>
        
        <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
          {emails.map((email) => (
            <React.Fragment key={email.id}>
              <div 
                onClick={() => toggleEmail(email.id)}
                className={`p-5 flex gap-4 cursor-pointer transition-colors ${
                  selectedIds.has(email.id) ? 'bg-blue-50/30' : 'hover:bg-slate-50'
                }`}
              >
                <div className={`mt-1 w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-all ${
                  selectedIds.has(email.id) ? 'bg-blue-600 border-blue-600' : 'border-slate-300 bg-white'
                }`}>
                  {selectedIds.has(email.id) && <CheckCircle className="w-3.5 h-3.5 text-white" />}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-bold text-slate-800 text-sm truncate">{email.subject || "Google Scholar Alert"}</h4>
                    <div className="flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                      <Clock className="w-3 h-3" />
                      {email.date}
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed line-clamp-2">
                    {email.snippet}
                  </p>
                </div>

                <button
                  onClick={(e) => handleExpand(e, email)}
                  className={`self-start p-2 rounded-lg transition-colors ${
                    expandedId === email.id 
                    ? 'bg-blue-100 text-blue-600' 
                    : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                  }`}
                  title="Analyze and view papers in this email"
                >
                  {expandedId === email.id ? <ChevronUp className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>

              {expandedId === email.id && (
                <div className="bg-slate-50/50 border-b border-slate-100 p-4 pl-14 animate-in slide-in-from-top-2">
                  {isAnalyzing && !analyzedPapers[email.id] ? (
                    <div className="flex items-center gap-3 text-sm text-slate-500 py-4">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      Analyzing email content with Gemini...
                    </div>
                  ) : analyzedPapers[email.id] ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h5 className="text-xs font-bold uppercase text-slate-500 tracking-wider">
                          {analyzedPapers[email.id].length} Papers Found
                        </h5>
                      </div>
                      {analyzedPapers[email.id].length > 0 ? (
                        <div className="grid gap-3">
                          {analyzedPapers[email.id].map((paper, idx) => (
                            <div key={idx} className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm hover:border-blue-300 transition-colors">
                              <div className="flex justify-between items-start gap-3">
                                <h6 className="text-sm font-bold text-slate-800 leading-tight">
                                  {paper.title}
                                </h6>
                                {paper.link && (
                                  <a
                                    href={paper.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="shrink-0 text-blue-600 hover:text-blue-700"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                  </a>
                                )}
                              </div>
                              <p className="text-xs text-slate-500 mt-1">{paper.authors.join(', ')}</p>
                              <p className="text-xs text-slate-600 mt-2 line-clamp-2 italic">"{paper.snippet}"</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-500 italic">No papers found in this email.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Preview;
