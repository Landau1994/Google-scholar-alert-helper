
import React from 'react';
import { ViewState } from '../types';
import { LayoutDashboard, PlusCircle, Bookmark, Settings, BookOpen } from 'lucide-react';

interface SidebarProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ currentView, setView }) => {
  const menuItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Overview' },
    { id: 'import', icon: PlusCircle, label: 'Add Alerts' },
    { id: 'keywords', icon: Bookmark, label: 'My Keywords' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

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

      <nav className="flex-1 px-4 py-6 space-y-1">
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

      <div className="p-6 mt-auto">
        <div className="p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
          <p className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Weekly Progress</p>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-white font-medium">12 Papers Analyzed</span>
          </div>
          <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden">
            <div className="bg-blue-500 h-full w-[65%]" />
          </div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
