// 페이지 안에 그리는 드롭다운. 기본 <select>의 펼친 목록은 운영체제가 따로 띄우는 창이라 화면 공유(창 공유)에 안 나온다.
// <select>를 그대로 바꿔 끼울 수 있게 <option> 자식과 onChange(e.target.value) 모양을 그대로 받는다.
import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Opt = { value: string; label: ReactNode; disabled?: boolean };
type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };

const optionsOf = (children: ReactNode): Opt[] =>
  Children.toArray(children).flatMap((c) => {
    if (!isValidElement(c) || c.type !== 'option') return [];
    const p = (c as ReactElement<OptionProps>).props;
    return [{ value: String(p.value ?? (typeof p.children === 'string' ? p.children : '')), label: p.children, disabled: p.disabled }];
  });

export function Select({ value, onChange, children, disabled, className, ...rest }: {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  title?: string;
}) {
  const opts = optionsOf(children);
  const current = opts.find((o) => o.value === String(value ?? '')) ?? opts[0];
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; up: boolean }>();

  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    const up = r.bottom + 280 > window.innerHeight && r.top > 280;
    setBox({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up });
    setAt(Math.max(0, opts.indexOf(current)));
    setOpen(true);
  };
  const pick = (o?: Opt) => {
    setOpen(false);
    if (o && !o.disabled && o.value !== String(value ?? '')) onChange?.({ target: { value: o.value } });
    btn.current?.focus();
  };
  // 바깥을 누르거나 스크롤하면 닫는다 (목록이 버튼에서 떨어져 떠 있지 않게)
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!(e.target instanceof Node) || !document.querySelector('.select-list')?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  return (
    <>
      <button
        ref={btn} type="button" className={`select ${className ?? ''}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} {...rest}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(); return; }
          if (!open) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(opts.length - 1, i + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(opts[at]); }
        }}
      >
        <span className="select-label">{current?.label}</span><span className="select-caret" aria-hidden>▾</span>
      </button>
      {open && box && createPortal(
        <div className="select-list" role="listbox"
          style={{ left: box.left, minWidth: box.width, ...(box.up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.top + 4 }) }}>
          {opts.map((o, i) => (
            <div key={o.value + i} role="option" aria-selected={o === current} aria-disabled={o.disabled}
              className={`${i === at ? 'at' : ''} ${o === current ? 'on' : ''} ${o.disabled ? 'off' : ''}`}
              onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              {o.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
