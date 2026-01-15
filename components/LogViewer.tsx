
import React, { useEffect, useState, useRef } from 'react';
import { logger, LogEntry } from '../utils/logger';
import { X, Terminal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

interface LogViewerProps {
  onClose?: () => void;
  isVisible: boolean;
}

const LogViewer: React.FC<LogViewerProps> = ({ onClose, isVisible }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initial logs
    setLogs([...logger.getLogs()]);

    // Subscribe to new logs
    const unsubscribe = logger.subscribe((entry) => {
      setLogs(prev => [...prev, entry]);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isVisible, isExpanded]);

  if (!isVisible) return null;

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'info': return 'text-blue-400';
      case 'success': return 'text-green-400';
      case 'warn': return 'text-yellow-400';
      case 'error': return 'text-red-400';
      default: return 'text-slate-300';
    }
  };

  const clearLogs = () => {
    logger.clear();
    setLogs([]);
  };

  return (
    <div className={`fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-700 shadow-2xl transition-all duration-300 z-50 flex flex-col ${isExpanded ? 'h-2/3' : 'h-48'}`}>
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2 text-slate-200 font-mono text-sm">
          <Terminal className="w-4 h-4 text-blue-400" />
          <span>System Logs</span>
          <span className="bg-slate-700 px-2 py-0.5 rounded text-xs text-slate-400">{logs.length} events</span>
        </div>
        <div className="flex items-center gap-2">
           <button 
            onClick={clearLogs}
            className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
            title="Clear Logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          {onClose && (
            <button 
              onClick={onClose}
              className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1.5"
      >
        {logs.length === 0 && (
          <div className="text-slate-500 italic text-center mt-8">No logs recorded yet...</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className="flex gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <span className="text-slate-500 shrink-0">
              [{new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
            </span>
            <span className={`font-bold uppercase w-16 shrink-0 ${getLevelColor(log.level)}`}>
              {log.level}
            </span>
            <span className="text-slate-300 break-words flex-1">
              {log.message}
              {log.details && (
                <span className="block mt-1 ml-4 text-slate-500 whitespace-pre-wrap border-l-2 border-slate-700 pl-2">
                  {typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : log.details}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LogViewer;
