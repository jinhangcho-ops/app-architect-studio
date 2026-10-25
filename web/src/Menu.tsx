// 단추를 누르면 열리는 메뉴 (파일·노드 추가). 바깥을 누르거나 Esc, 항목을 고르면 닫힌다.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Menu({ label, children, right, icon }: { label: ReactNode; children: (close: () => void) => ReactNode; right?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    // 열리면 첫 항목으로 (키보드로 바로 고를 수 있게)
    box.current?.querySelector<HTMLElement>('[role=menu] button')?.focus();
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}{label}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {open && <div className={`menu${right ? ' right' : ''}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}
