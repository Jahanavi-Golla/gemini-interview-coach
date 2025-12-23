
import React from 'react';
import { FeedbackMessage, Sentiment } from '../types';

interface FeedbackListProps {
  feedbacks: FeedbackMessage[];
}

const FeedbackList: React.FC<FeedbackListProps> = ({ feedbacks }) => {
  const sortedFeedbacks = [...feedbacks].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="flex flex-col space-y-4 max-h-full overflow-y-auto pr-2 custom-scrollbar">
      {sortedFeedbacks.length === 0 ? (
        <div className="text-center py-10 text-slate-500 italic">
          Coach tips will appear here in real-time...
        </div>
      ) : (
        sortedFeedbacks.map((fb) => (
          <div 
            key={fb.id} 
            className={`p-4 rounded-xl border-l-4 transition-all animate-slide-in ${
              fb.sentiment === Sentiment.POSITIVE ? 'bg-emerald-950/20 border-emerald-500 text-emerald-200' :
              fb.sentiment === Sentiment.IMPROVEMENT ? 'bg-amber-950/20 border-amber-500 text-amber-200' :
              'bg-slate-800/50 border-slate-500 text-slate-200'
            }`}
          >
            <div className="flex justify-between items-start mb-1">
              <span className="text-xs font-bold uppercase tracking-wider opacity-70">{fb.category}</span>
              <span className="text-[10px] opacity-50">{new Date(fb.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
            <p className="text-sm font-medium leading-relaxed">{fb.message}</p>
          </div>
        ))
      )}
    </div>
  );
};

export default FeedbackList;
