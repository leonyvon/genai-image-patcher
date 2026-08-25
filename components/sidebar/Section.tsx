import React from 'react';

export const Section: React.FC<{
  title: string;
  children: React.ReactNode;
  isOpen?: boolean;
  onToggle?: () => void;
  onHelp?: () => void;
}> = ({ title, children, isOpen, onToggle, onHelp }) => {
  return (
    <div className="border border-skin-border rounded-xl bg-skin-surface shadow-sm transition-all hover:shadow-md mb-3">
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 bg-skin-fill/30 hover:bg-skin-fill transition-colors text-left ${isOpen ? 'rounded-t-xl' : 'rounded-xl'}`}
      >
        <span className="text-xs font-bold text-skin-muted uppercase tracking-wider">{title}</span>
        <div className="flex items-center gap-1">
          {onHelp && (
            <button
              type="button"
              aria-label="Help"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onHelp(); }}
              className="w-5 h-5 rounded-full border border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary flex items-center justify-center text-[10px] transition-colors"
            >
              ?
            </button>
          )}
          <svg
            className={`w-4 h-4 text-skin-muted transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {isOpen && (
        <div className="p-4 border-t border-skin-border space-y-4 bg-skin-surface rounded-b-xl">
          {children}
        </div>
      )}
    </div>
  );
};
