import React from 'react';
import { GripVertical } from 'lucide-react';
import { DragPoint } from '../hooks/useLongPressDrag';

interface DragGhostProps {
  point: DragPoint;
  label: string;
  detail?: string;
}

/**
 * Follows the finger during a long-press drag. Must stay `pointer-events-none`
 * so `document.elementFromPoint` sees the drop target underneath it.
 */
export const DragGhost: React.FC<DragGhostProps> = ({ point, label, detail }) => (
  <div
    className="fixed z-[80] pointer-events-none -translate-x-1/2 -translate-y-1/2"
    style={{ left: point.x, top: point.y }}
  >
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-500/90 text-slate-950 shadow-xl shadow-sky-950/40 max-w-[70vw]">
      <GripVertical className="w-4 h-4 shrink-0 opacity-70" />
      <div className="min-w-0">
        <div className="text-xs font-semibold truncate">{label}</div>
        {detail && <div className="text-[10px] opacity-80 truncate">{detail}</div>}
      </div>
    </div>
  </div>
);
