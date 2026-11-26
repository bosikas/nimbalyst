import React from 'react';

const radius = 12;
const circumference = 2 * Math.PI * radius;

export function UsageRing({ percent, strokeColor }: { percent: number | null; strokeColor: string }) {
  const fill = Math.min(100, Math.max(0, percent ?? 0));
  return <>
    <svg width="32" height="32" viewBox="0 0 32 32" className="transform -rotate-90" aria-hidden="true">
      <circle cx="16" cy="16" r={radius} fill="none" className="stroke-nim-tertiary" strokeWidth="3" />
      <circle cx="16" cy="16" r={radius} fill="none" className={strokeColor} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill / 100)}
        style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
    </svg>
    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
      {percent === null ? '--' : `${Math.round(percent)}%`}
    </span>
  </>;
}
