
import React from 'react';
import { ViewState, HistoryItem } from '../types';
import { LayoutDashboard, PlusCircle, Bookmark, Settings, BookOpen, Clock, CalendarClock } from 'lucide-react';

interface SidebarProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
  stats?: {
    analyzedCount: number;
    weeklyGoal: number;
  };
  history?: HistoryItem[];
  onLoadReport?: (filename: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentView, setView, stats, history = [], onLoadReport }) => {
  const menuItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Overview' },
    { id: 'import', icon: PlusCircle, label: 'Add Alerts' },
    { id: 'scheduled-reports', icon: CalendarClock, label: 'Daily Reports' },
    { id: 'keywords', icon: Bookmark, label: 'My Keywords' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  const percentage = stats ? Math.min(100, Math.round((stats.analyzedCount / stats.weeklyGoal) * 100)) : 0;

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col shrink-0">
      <div className="p-6 flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-900/50">
          <BookOpen className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight leading-none">ScholarPulse</h2>
          <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Academic Assistant</span>
        </div>
      </div>

      <nav className="px-4 py-2 space-y-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id as ViewState)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                isActive 
                  ? 'bg-blue-600 text-white shadow-md' 
                  : 'hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-slate-500'}`} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {history && history.length > 0 && (
        <div className="px-4 py-4 flex-1 overflow-hidden flex flex-col">
          <p className="px-4 text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <Clock className="w-3 h-3" />
            History
          </p>
          <div className="flex-1 overflow-y-auto space-y-1 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            {history.map((item) => (
              <button
                key={item.filename}
                onClick={() => onLoadReport?.(item.filename)}
                className="w-full text-left px-4 py-2 rounded-lg text-xs hover:bg-slate-800 hover:text-white transition-colors text-slate-400 group"
              >
                <div className="font-medium group-hover:text-blue-400 transition-colors">
                  {item.date.split(' ')[0]}
                </div>
                <div className="text-[10px] opacity-60">
                  {item.date.split(' ').slice(1).join(' ')}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {stats && (
        <div className="p-6 mt-auto shrink-0">
          <div className="p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
            <p className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Session Progress</p>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-white font-medium">{stats.analyzedCount} Papers Analyzed</span>
            </div>
            <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden">
              <div 
                className="bg-blue-500 h-full transition-all duration-500" 
                style={{ width: `${percentage}%` }}
              />
            </div>
            <p className="text-[10px] text-slate-500 mt-2 text-right">Goal: {stats.weeklyGoal}</p>
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
