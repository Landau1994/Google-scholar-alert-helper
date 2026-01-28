
import React, { useState } from 'react';
import { Keyword } from '../types';
import { Plus, X, Hash, Info } from 'lucide-react';

interface KeywordManagerProps {
  keywords: Keyword[];
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
  penaltyKeywords: Keyword[];
  onAddPenalty: (text: string) => void;
  onRemovePenalty: (id: string) => void;
}

const KeywordManager: React.FC<KeywordManagerProps> = ({ 
  keywords, onAdd, onRemove,
  penaltyKeywords, onAddPenalty, onRemovePenalty
}) => {
  const [newKeyword, setNewKeyword] = useState('');
  const [newPenalty, setNewPenalty] = useState('');

  const handleAdd = () => {
    if (newKeyword.trim()) {
      onAdd(newKeyword.trim());
      setNewKeyword('');
    }
  };

  const handleAddPenalty = () => {
    if (newPenalty.trim()) {
      onAddPenalty(newPenalty.trim());
      setNewPenalty('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  const handlePenaltyKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAddPenalty();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Research Interests</h2>
        <p className="text-slate-500 text-sm mb-8">
          Define the keywords you care about. We use these to filter your alerts and generate targeted summaries.
        </p>

        <div className="flex gap-2 mb-8">
          <div className="relative flex-1">
            <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Add research topic..." 
              className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyPress={handleKeyPress}
            />
          </div>
          <button 
            onClick={handleAdd}
            disabled={!newKeyword.trim()}
            className="px-6 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            Add
          </button>
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Current Keywords ({keywords.length})</h3>
          <div className="flex flex-wrap gap-3">
            {keywords.map((kw) => (
              <div 
                key={kw.id} 
                className={`${kw.color} px-4 py-2 rounded-xl flex items-center gap-2 font-semibold text-sm animate-in zoom-in duration-300 shadow-sm`}
              >
                {kw.text}
                <button 
                  onClick={() => onRemove(kw.id)}
                  className="p-1 hover:bg-black/5 rounded-full transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Penalty Words</h2>
        <p className="text-slate-500 text-sm mb-8">
          Define words that reduce an article's relevance. Useful for filtering out common but unrelated topics.
        </p>

        <div className="flex gap-2 mb-8">
          <div className="relative flex-1">
            <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Add penalty word (e.g., 'clinical trial')..." 
              className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none transition-all"
              value={newPenalty}
              onChange={(e) => setNewPenalty(e.target.value)}
              onKeyPress={handlePenaltyKeyPress}
            />
          </div>
          <button 
            onClick={handleAddPenalty}
            disabled={!newPenalty.trim()}
            className="px-6 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            Add
          </button>
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Current Penalties ({penaltyKeywords.length})</h3>
          <div className="flex flex-wrap gap-3">
            {penaltyKeywords.map((kw) => (
              <div 
                key={kw.id} 
                className={`${kw.color} px-4 py-2 rounded-xl flex items-center gap-2 font-semibold text-sm animate-in zoom-in duration-300 shadow-sm`}
              >
                {kw.text}
                <button 
                  onClick={() => onRemovePenalty(kw.id)}
                  className="p-1 hover:bg-black/5 rounded-full transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6 bg-amber-50 rounded-2xl border border-amber-100 flex gap-4 items-start">
        <div className="p-2 bg-amber-100 text-amber-600 rounded-lg">
          <Info className="w-5 h-5" />
        </div>
        <div>
          <h4 className="font-bold text-amber-900 text-sm mb-1">Pro Tip</h4>
          <p className="text-amber-800/70 text-xs leading-relaxed">
            Specific phrases like "Self-supervised Learning in Vision" yield better results than broad terms like "AI".
          </p>
        </div>
      </div>
    </div>
  );
};

export default KeywordManager;
