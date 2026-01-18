
import React from 'react';
import { Paper, DigestSummary, Keyword } from '../types';
// Fixed: Added PlusCircle to the lucide-react imports
import { ExternalLink, Star, FileText, ChevronRight, TrendingUp, Inbox, PlusCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface DashboardProps {
  papers: Paper[];
  summary: DigestSummary | null;
  keywords: Keyword[];
  onGoToImport: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ papers, summary, keywords, onGoToImport }) => {
  if (papers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-md mx-auto">
        <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
          <Inbox className="w-10 h-10 text-slate-300" />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-2">No data yet</h2>
        <p className="text-slate-500 mb-8">
          Import your Google Scholar email content to see AI-powered aggregations and summaries.
        </p>
        <button 
          onClick={onGoToImport}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold shadow-lg shadow-blue-600/20 hover:bg-blue-700 transition-all flex items-center gap-2"
        >
          <PlusCircle className="w-5 h-5" />
          Get Started
        </button>
      </div>
    );
  }

  // Prep chart data
  const chartData = keywords.map(kw => ({
    name: kw.text.length > 15 ? kw.text.substring(0, 12) + '...' : kw.text,
    count: papers.filter(p => p.matchedKeywords.includes(kw.text)).length,
    color: kw.color.includes('blue') ? '#3b82f6' : 
           kw.color.includes('purple') ? '#a855f7' : 
           kw.color.includes('green') ? '#22c55e' : '#f59e0b'
  })).filter(d => d.count > 0);

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      {/* Overview Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-blue-600" />
              Relevance by Keyword
            </h3>
          </div>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="name" axisLine={false} tickLine={false} fontSize={12} />
                <YAxis hide />
                <Tooltip 
                  cursor={{fill: '#f8fafc'}}
                  contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'}}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-blue-600 p-6 rounded-2xl shadow-lg shadow-blue-600/20 text-white flex flex-col">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-200" />
            AI Snapshot
          </h3>
          <p className="text-blue-50 text-sm leading-relaxed mb-4 flex-1 italic">
            "{summary?.overview.substring(0, 200)}..."
          </p>
          <div className="flex flex-wrap gap-2">
            {summary?.keyTrends.slice(0, 3).map((trend, i) => (
              <span key={i} className="px-3 py-1 bg-white/10 rounded-full text-[10px] font-bold uppercase tracking-wider">
                {trend}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Paper List */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xl font-bold text-slate-800">New Alerts</h3>
            <span className="text-sm text-slate-500 font-medium">{papers.length} papers found</span>
          </div>
          
          <div className="space-y-4">
            {papers.map((paper) => (
              <div key={paper.id} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 hover:border-blue-300 transition-all group">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    <h4 className="text-lg font-bold text-slate-900 leading-tight group-hover:text-blue-600 transition-colors">
                      {paper.title}
                    </h4>
                    <p className="text-sm text-slate-500 font-medium mt-1">
                      {paper.authors.join(', ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <div className="flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-600 rounded-lg text-xs font-bold">
                      <Star className="w-3 h-3 fill-amber-600" />
                      {paper.relevanceScore}%
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-slate-600 line-clamp-2 mt-3 mb-4 italic">
                  "{paper.snippet}"
                </p>

                <div className="flex items-center justify-between mt-auto">
                  <div className="flex flex-wrap gap-2">
                    {paper.matchedKeywords.map(kw => {
                      const kwObj = keywords.find(k => k.text === kw);
                      return (
                        <span key={kw} className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${kwObj?.color || 'bg-slate-100'}`}>
                          {kw}
                        </span>
                      );
                    })}
                  </div>
                  {paper.link && (
                    <a
                      href={paper.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
                    >
                      View Paper
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar Summary */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Star className="w-5 h-5 text-amber-500" />
              Top Recommendations
            </h3>
            <ul className="space-y-4">
              {summary?.topRecommendations.map((rec, i) => (
                <li key={i} className="flex gap-3 group cursor-pointer">
                  <div className="shrink-0 w-6 h-6 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center text-xs font-bold">
                    {i+1}
                  </div>
                  <p className="text-sm text-slate-700 leading-snug group-hover:text-blue-600 transition-colors">
                    {rec}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold mb-4">Thematic Distribution</h3>
            <div className="space-y-3">
              {summary?.categorizedPapers.map((cat, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    <span className="text-sm font-medium text-slate-700">{cat.keyword}</span>
                  </div>
                  <span className="text-xs font-bold text-slate-400">{cat.paperIds.length} papers</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;