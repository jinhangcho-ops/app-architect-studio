// 와이어프레임 한 장을 캔버스에 그린다. PNG 저장과 설계서 그림이 같이 쓴다 (화면의 CSS 모양과 같은 색·선).
import type { Deploy, Screen, WireItem } from '../../engine/schema';

export const frameOf = (mode: Deploy['mode']) => (mode === 'mobile' ? { w: 390, h: 844, name: '모바일 390×844' } : { w: 1280, h: 800, name: '데스크톱 1280×800' });

/** 그리기에 쓰는 캔버스 함수만 (테스트에서 기록용 가짜로 바꿔 끼운다) */
export type Ctx = Pick<CanvasRenderingContext2D, 'fillRect' | 'strokeRect' | 'fillText' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'setLineDash' | 'save' | 'restore' | 'rect' | 'clip' | 'scale'>
  & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textBaseline: CanvasTextBaseline; textAlign: CanvasTextAlign };

const REGION = new Set<WireItem['kind']>(['sidebar', 'main', 'form', 'list', 'card', 'table']);
const BAR = new Set<WireItem['kind']>(['header', 'nav', 'footer']);

/** 틀이 바뀌어(웹 → 모바일) 밖으로 나간 상자는 틀 안으로 당겨 보여 준다 */
export function fitItem(it: WireItem, frame: { w: number; h: number }): WireItem {
  const w = Math.min(it.w, frame.w), h = Math.min(it.h, frame.h);
  return { ...it, w, h, x: Math.max(0, Math.min(it.x, frame.w - w)), y: Math.max(0, Math.min(it.y, frame.h - h)) };
}

/** 큰 상자(영역)부터 그려 작은 상자(컨트롤)가 위에 오게 한다 */
export const drawOrder = (items: WireItem[]) => [...items].sort((a, b) => b.w * b.h - a.w * a.h);

export function drawScreen(c: Ctx, screen: Screen, frame: { w: number; h: number }, k = 1) {
  c.save();
  c.scale(k, k);
  c.fillStyle = '#f4f6f9';
  c.fillRect(0, 0, frame.w, frame.h);
  for (const it of drawOrder(screen.items.map((i) => fitItem(i, frame)))) {
    const { x, y, w, h, kind } = it;
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.setLineDash(REGION.has(kind) && kind !== 'table' ? [6, 4] : []);
    c.fillStyle = kind === 'button' ? '#3b4452' : BAR.has(kind) ? '#e3e7ee' : kind === 'image' ? '#eef1f5' : '#ffffff';
    c.fillRect(x, y, w, h);
    c.strokeStyle = kind === 'button' ? '#3b4452' : '#9aa4b2';
    c.lineWidth = 1.5;
    if (kind !== 'text') c.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    c.setLineDash([]);
    c.strokeStyle = '#c9d0da';
    c.lineWidth = 1;
    const rows = kind === 'table' ? 24 : kind === 'list' ? 36 : 0;
    for (let yy = y + rows; rows && yy < y + h; yy += rows) { c.beginPath(); c.moveTo(x, yy); c.lineTo(x + w, yy); c.stroke(); }
    if (kind === 'image') { c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y + h); c.moveTo(x + w, y); c.lineTo(x, y + h); c.stroke(); }
    if (kind === 'tabs') { c.fillStyle = '#3b4452'; c.fillRect(x, y + h - 2, w / 4, 2); }
    c.font = '12px "Pretendard", "Malgun Gothic", sans-serif';
    c.textBaseline = REGION.has(kind) ? 'top' : 'middle';
    const center = kind === 'button' || kind === 'image' || kind === 'modal';
    c.textAlign = center ? 'center' : 'left';
    c.fillStyle = kind === 'button' ? '#ffffff' : kind === 'input' || kind === 'select' ? '#8a94a3' : '#3b4452';
    const label = it.api ? `${it.label}  ·  ${it.api.method} ${it.api.path}` : it.label;
    c.fillText(label, center ? x + w / 2 : x + 8, REGION.has(kind) ? y + 6 : y + h / 2);
    if (kind === 'select') { c.textAlign = 'right'; c.fillText('▾', x + w - 8, y + h / 2); }
    c.restore();
  }
  c.restore();
}

/** 한 장을 그린 캔버스. scale 2 = 선명한 PNG */
export function screenCanvas(screen: Screen, frame: { w: number; h: number }, scale = 2): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = frame.w * scale;
  cv.height = frame.h * scale;
  drawScreen(cv.getContext('2d')!, screen, frame, scale);
  return cv;
}

export function downloadPng(screen: Screen, frame: { w: number; h: number }, fileBase: string) {
  screenCanvas(screen, frame).toBlob((blob) => {
    if (!blob) return;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${fileBase}.png` });
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}
