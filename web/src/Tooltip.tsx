// 페이지 안 툴팁. 브라우저의 title 툴팁은 운영체제가 따로 띄우는 창이라 화면 공유(창 공유)에 안 나온다.
// 마우스가 title이 있는 요소에 오면 title을 data-tip으로 옮겨 기본 툴팁을 막고, 같은 글을 앱 안에 그린다. 앱에 한 번만 둔다.
import { useEffect, useState } from 'react';

const DELAY_MS = 350;

export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; up: boolean }>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let el: Element | null = null;
    const hide = () => { clearTimeout(timer); el = null; setTip(undefined); };
    const over = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest('[title], [data-tip]') : null;
      if (t === el) return;
      hide();
      if (!t) return;
      // title은 React가 값을 바꿀 때 다시 넣으므로, 올 때마다 옮긴다
      const title = t.getAttribute('title');
      if (title) { t.setAttribute('data-tip', title); t.removeAttribute('title'); }
      const text = t.getAttribute('data-tip');
      if (!text) return;
      el = t;
      timer = setTimeout(() => {
        const r = t.getBoundingClientRect();
        const up = r.bottom + 160 > window.innerHeight;
        setTip({ text, x: Math.min(r.left, window.innerWidth - 360), y: up ? r.top - 6 : r.bottom + 6, up });
      }, DELAY_MS);
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      clearTimeout(timer);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className="tooltip" role="tooltip" style={{ left: Math.max(8, tip.x), ...(tip.up ? { bottom: window.innerHeight - tip.y } : { top: tip.y }) }}>
      {tip.text}
    </div>
  );
}
