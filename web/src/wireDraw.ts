// 와이어프레임 한 장을 캔버스에 그린다. PNG 저장과 설계서 그림이 같이 쓴다 (화면의 CSS·SVG 모양과 같은 색·선).
import type { Deploy, Screen, WireItem } from '../../engine/schema';
import { desktop } from './desktop';

export type Frame = { w: number; h: number; name: string };
export const DEVICES: Record<NonNullable<Screen['device']>, Frame> = {
  desktop: { w: 1280, h: 800, name: '데스크톱 1280×800' },
  tablet: { w: 820, h: 1180, name: '태블릿 세로 820×1180' },
  tablet_land: { w: 1180, h: 820, name: '태블릿 가로 1180×820' },
  mobile: { w: 390, h: 844, name: '모바일 390×844' },
};
export const DEVICE_NAMES: Record<NonNullable<Screen['device']>, string> = { desktop: '데스크톱', tablet: '태블릿 세로', tablet_land: '태블릿 가로', mobile: '모바일' };

/** 기기를 정하지 않은 화면: 구동 방식이 모바일이면 모바일, 나머지는 데스크톱 */
export const deviceOf = (screen: Pick<Screen, 'device'>, mode: Deploy['mode']) => screen.device ?? (mode === 'mobile' ? 'mobile' : 'desktop');
export const screenFrame = (screen: Pick<Screen, 'device'>, mode: Deploy['mode']) => DEVICES[deviceOf(screen, mode)];

/** 상자 색: 채우기·선 */
export const COLORS: Record<NonNullable<WireItem['color']>, { fill: string; stroke: string; name: string }> = {
  gray: { fill: '#e3e7ee', stroke: '#6b7584', name: '회색' },
  blue: { fill: '#dbe7ff', stroke: '#2b5fd9', name: '파랑' },
  green: { fill: '#d8f3ea', stroke: '#1f9d75', name: '초록' },
  amber: { fill: '#fff0d1', stroke: '#c98400', name: '노랑' },
  red: { fill: '#ffe1e1', stroke: '#d13b3b', name: '빨강' },
  dark: { fill: '#3b4452', stroke: '#1d2433', name: '진한 회색' },
};

/** 그리기에 쓰는 캔버스 함수만 (테스트에서 기록용 가짜로 바꿔 끼운다) */
export type Ctx = Pick<CanvasRenderingContext2D, 'fillRect' | 'strokeRect' | 'fillText' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'closePath' | 'arc' | 'ellipse' | 'setLineDash' | 'save' | 'restore' | 'rect' | 'clip' | 'scale'>
  & { fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textBaseline: CanvasTextBaseline; textAlign: CanvasTextAlign };

const REGION = new Set<WireItem['kind']>(['sidebar', 'main', 'form', 'list', 'card', 'table']);
const BAR = new Set<WireItem['kind']>(['header', 'nav', 'footer']);
/** 상자 대신 모양으로 그리는 것 (상자 테두리를 긋지 않는다) */
export const SHAPES = new Set<WireItem['kind']>(['ellipse', 'line', 'arrow', 'icon', 'avatar', 'checkbox', 'radio', 'toggle']);

/** 틀이 바뀌어(웹 → 모바일) 밖으로 나간 상자는 틀 안으로 당겨 보여 준다 */
export function fitItem(it: WireItem, frame: { w: number; h: number }): WireItem {
  const w = Math.min(it.w, frame.w), h = Math.min(it.h, frame.h);
  return { ...it, w, h, x: Math.max(0, Math.min(it.x, frame.w - w)), y: Math.max(0, Math.min(it.y, frame.h - h)) };
}

/** 큰 상자(영역)부터 그려 작은 상자(컨트롤)가 위에 오게 한다 */
export const drawOrder = (items: WireItem[]) => [...items].sort((a, b) => b.w * b.h - a.w * a.h);

/** 선·화살표 방향: 넓으면 가로, 높으면 세로. 시작·끝 점 */
export const lineEnds = (it: Pick<WireItem, 'x' | 'y' | 'w' | 'h'>) => (it.w >= it.h
  ? { x1: it.x + 2, y1: it.y + it.h / 2, x2: it.x + it.w - 2, y2: it.y + it.h / 2 }
  : { x1: it.x + it.w / 2, y1: it.y + 2, x2: it.x + it.w / 2, y2: it.y + it.h - 2 });

/** 다른 기기용으로 복사: 자리·크기를 틀의 가로·세로 비율대로 옮긴다 (배치가 그대로라 겹치지 않는다).
 *  작은 기기에서 컨트롤이 너무 작아지지 않게 너비 72px·높이 28px(원래가 더 작으면 원래)까지는 둔다 */
export function toDevice(screen: Screen, from: Frame, to: Frame, device: NonNullable<Screen['device']>, name: string): Screen {
  const sx = to.w / from.w, sy = to.h / from.h;
  const items = screen.items.map((it) => {
    // 원·프로필 사진·아이콘은 모양이 찌그러지지 않게 가로세로를 같은 비율로
    const round = it.kind === 'ellipse' || it.kind === 'avatar' || it.kind === 'icon';
    const kx = round ? Math.min(sx, sy) : sx, ky = round ? Math.min(sx, sy) : sy;
    return fitItem({
      ...it,
      x: Math.round(it.x * sx), y: Math.round(it.y * sy),
      w: Math.max(Math.round(it.w * kx), Math.min(it.w, round ? 24 : 72)), h: Math.max(Math.round(it.h * ky), Math.min(it.h, round ? 24 : 28)),
    }, to);
  });
  return { name, device, items };
}

export function drawScreen(c: Ctx, screen: Screen, frame: { w: number; h: number }, k = 1) {
  c.save();
  c.scale(k, k);
  c.fillStyle = '#f4f6f9';
  c.fillRect(0, 0, frame.w, frame.h);
  for (const it of drawOrder(screen.items.map((i) => fitItem(i, frame)))) {
    const { x, y, w, h, kind } = it;
    const col = it.color ? COLORS[it.color] : undefined;
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.lineWidth = 1.5;
    if (SHAPES.has(kind)) drawShape(c, it, col);
    else {
      c.setLineDash(REGION.has(kind) && kind !== 'table' ? [6, 4] : []);
      c.fillStyle = col?.fill ?? (kind === 'button' ? '#3b4452' : BAR.has(kind) ? '#e3e7ee' : kind === 'image' ? '#eef1f5' : '#ffffff');
      c.fillRect(x, y, w, h);
      c.strokeStyle = col?.stroke ?? (kind === 'button' ? '#3b4452' : '#9aa4b2');
      if (kind !== 'text') c.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
      c.setLineDash([]);
      c.strokeStyle = '#c9d0da';
      c.lineWidth = 1;
      const rows = kind === 'table' ? 24 : kind === 'list' ? 36 : 0;
      for (let yy = y + rows; rows && yy < y + h; yy += rows) { c.beginPath(); c.moveTo(x, yy); c.lineTo(x + w, yy); c.stroke(); }
      if (kind === 'image') { c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y + h); c.moveTo(x + w, y); c.lineTo(x, y + h); c.stroke(); }
      if (kind === 'tabs') { c.fillStyle = '#3b4452'; c.fillRect(x, y + h - 2, w / 4, 2); }
    }
    drawLabel(c, it, col);
    c.restore();
  }
  c.restore();
}

function drawShape(c: Ctx, it: WireItem, col?: { fill: string; stroke: string }) {
  const { x, y, w, h, kind } = it;
  const stroke = col?.stroke ?? '#6b7584';
  c.strokeStyle = stroke;
  c.fillStyle = col?.fill ?? '#ffffff';
  if (kind === 'ellipse') {
    c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  } else if (kind === 'line' || kind === 'arrow') {
    const { x1, y1, x2, y2 } = lineEnds(it);
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    if (kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), s = 10;
      c.fillStyle = stroke;
      c.beginPath(); c.moveTo(x2, y2);
      c.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45));
      c.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45));
      c.closePath(); c.fill();
    }
  } else if (kind === 'icon') {
    // 별 모양 자리표시
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2 - 2;
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r, a = -Math.PI / 2 + (i * Math.PI) / 5;
      if (i) c.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); else c.moveTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
    }
    c.closePath(); c.fillStyle = col?.fill ?? '#e3e7ee'; c.fill(); c.stroke();
  } else if (kind === 'avatar') {
    const r = Math.min(w, h) / 2 - 1;
    c.beginPath(); c.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); c.fillStyle = col?.fill ?? '#e3e7ee'; c.fill(); c.stroke();
  } else {
    // 체크박스·라디오·토글: 왼쪽에 작은 표시, 오른쪽에 글
    const s = Math.min(16, h - 4), cy = y + h / 2;
    if (kind === 'checkbox') c.strokeRect(x + 2, cy - s / 2, s, s);
    if (kind === 'radio') { c.beginPath(); c.arc(x + 2 + s / 2, cy, s / 2, 0, Math.PI * 2); c.stroke(); }
    if (kind === 'toggle') {
      c.fillStyle = col?.stroke ?? '#2b5fd9';
      c.beginPath(); c.arc(x + 2 + s / 2, cy, s / 2, Math.PI / 2, Math.PI * 1.5); c.arc(x + 2 + s * 1.5, cy, s / 2, -Math.PI / 2, Math.PI / 2); c.closePath(); c.fill();
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(x + 2 + s * 1.5, cy, s / 2 - 2, 0, Math.PI * 2); c.fill();
    }
  }
}

/** 글을 그리지 않는 도형 (화면 편집기와 PNG가 같이 씀) */
export const NO_LABEL = new Set<WireItem['kind']>(['line', 'arrow', 'icon']);

/** 글 자리: 영역·막대는 왼쪽 위, 표시가 있는 컨트롤(체크박스 등)은 표시 오른쪽, 나머지는 가운데 줄 */
function drawLabel(c: Ctx, it: WireItem, col?: { fill: string; stroke: string }) {
  const { x, y, w, h, kind } = it;
  if (!it.label || NO_LABEL.has(kind)) return;
  c.font = '12px "Pretendard", "Malgun Gothic", sans-serif';
  const top = REGION.has(kind) || BAR.has(kind);
  const mid = y + h / 2 - (it.api && h >= 28 ? 6 : 0);
  const mark = kind === 'checkbox' || kind === 'radio' ? Math.min(16, h - 4) + 8 : kind === 'toggle' ? Math.min(16, h - 4) * 2 + 8 : 0;
  const center = kind === 'button' || kind === 'image' || kind === 'modal' || kind === 'ellipse' || kind === 'avatar' || kind === 'rect';
  c.textBaseline = top ? 'top' : 'middle';
  c.textAlign = center ? 'center' : 'left';
  const dark = it.color === 'dark' || (!it.color && kind === 'button');
  c.fillStyle = dark ? '#ffffff' : kind === 'input' || kind === 'select' ? '#8a94a3' : col?.stroke ?? '#3b4452';
  const label = kind === 'avatar' ? it.label.slice(0, 1) : it.label;
  c.fillText(label, center ? x + w / 2 : x + (mark || 8), top ? y + 4 : mid);
  if (kind === 'select') { c.textAlign = 'right'; c.fillText('▾', x + w - 8, mid); }
  if (it.api) {
    c.font = '9px "Pretendard", "Malgun Gothic", sans-serif';
    c.textAlign = 'right';
    c.textBaseline = 'bottom';
    c.fillStyle = dark ? '#c9d6ff' : '#2b5fd9';
    c.fillText(`${it.api.method} ${it.api.path}`, x + w - 4, y + h - 2);
  }
}

/** 한 장을 그린 캔버스. scale 2 = 선명한 PNG */
export function screenCanvas(screen: Screen, frame: { w: number; h: number }, scale = 2): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = frame.w * scale;
  cv.height = frame.h * scale;
  drawScreen(cv.getContext('2d')!, screen, frame, scale);
  return cv;
}

/** 화면들을 PNG로 저장 (화면마다 자기 기기 크기). 데스크톱 앱은 저장 창(여러 장이면 폴더 한 번), 브라우저는 내려받기. 저장한 장 수(취소면 0) */
export async function savePngs(list: { screen: Screen; name: string }[], mode: Deploy['mode']): Promise<number> {
  const urls = list.map(({ screen, name }) => ({ name, url: screenCanvas(screen, screenFrame(screen, mode)).toDataURL('image/png') }));
  if (desktop) return (await desktop.savePngs(urls.map(({ name, url }) => ({ name, base64: url.slice(url.indexOf(',') + 1) }))))?.length ?? 0;
  for (const { name, url } of urls) Object.assign(document.createElement('a'), { href: url, download: `${name}.png` }).click();
  return urls.length;
}
