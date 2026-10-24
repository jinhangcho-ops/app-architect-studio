// 세부 구성의 왼편 기능 목록: 이 블록에 쓸 수 있는 것을 판정과 함께 보여 주고, 끌어서 다이어그램에 놓으면 더한다.
// 다이어그램의 블록을 여기로 끌어 오면 뺀다. 판정이 "안 됨"인 항목은 이유만 보여 주고 끌 수 없다.
import type { DragEvent, ReactNode } from 'react';
import type { Analysis } from '../../engine/analyze';
import { judgeItem } from '../../engine/judge';
import { VERDICT_NAMES, type Verdict } from '../../engine/model';
import { nodeStorageProfile, selectedFeatures, type CatalogItem, type WireItem } from '../../engine/schema';
import { catalog } from './data';
import { dropRemove, type Drag } from './edit';
import { useStore } from './store';

const MIME = 'application/x-aas-drag';
/** 끄는 동안 놓을 수 있는 곳을 강조한다 (body[data-drag]: add = 그림, ui = 화면 틀, remove = 왼편 목록) */
export const markDrag = (kind?: 'add' | 'ui' | 'remove') => { if (kind) document.body.dataset.drag = kind; else delete document.body.dataset.drag; };
if (typeof document !== 'undefined') for (const ev of ['dragend', 'drop']) document.addEventListener(ev, () => markDrag());
export const startDrag = (e: DragEvent, d: Drag) => {
  e.dataTransfer.setData(MIME, JSON.stringify(d));
  e.dataTransfer.effectAllowed = 'copyMove';
  markDrag(d.kind === 'remove' ? 'remove' : d.kind === 'ui' ? 'ui' : 'add');
};
export const isOurDrag = (e: DragEvent) => e.dataTransfer.types.includes(MIME);
export const readDrag = (e: DragEvent): Drag | undefined => {
  try { return JSON.parse(e.dataTransfer.getData(MIME)); } catch { return undefined; }
};
/** 끌던 것을 왼편 목록 위에서 놓았는지 (React Flow 블록·와이어프레임 상자처럼 직접 끄는 것용) */
export const overPalette = (e: { clientX: number; clientY: number } | TouchEvent) => {
  const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
  return !!pt && document.elementsFromPoint(pt.clientX, pt.clientY).some((el) => el.classList.contains('palette'));
};

export const WIRE_NAMES: Record<WireItem['kind'], string> = {
  header: '상단 헤더', nav: '네비게이션', sidebar: '사이드바', main: '본문 영역', form: '입력 폼', table: '표', list: '목록', card: '카드',
  modal: '모달', footer: '하단 푸터', text: '글', image: '이미지', button: '버튼', input: '입력칸', select: '선택창', tabs: '탭',
  rect: '사각형', ellipse: '원', line: '선', arrow: '화살표', icon: '아이콘', avatar: '프로필 사진', checkbox: '체크박스', radio: '라디오', toggle: '토글',
};
const WIRE_GROUPS: [string, WireItem['kind'][]][] = [
  ['영역', ['header', 'nav', 'sidebar', 'main', 'form', 'table', 'list', 'card', 'modal', 'footer']],
  ['컨트롤', ['text', 'image', 'button', 'input', 'select', 'tabs', 'checkbox', 'radio', 'toggle']],
  ['도형', ['rect', 'ellipse', 'line', 'arrow', 'icon', 'avatar']],
];

function Chip({ drag, children, verdict, note, on }: { drag?: Drag; children: ReactNode; verdict?: Verdict; note?: string; on?: string }) {
  return (
    <div className={`pchip ${drag ? '' : 'off'} ${verdict ? `v-${verdict}` : ''}`} draggable={!!drag} onDragStart={drag && ((e) => startDrag(e, drag))} title={note}>
      <span className="pchip-name">{children}</span>
      {on ? <span className="pchip-on">{on}</span> : verdict && <span className="pchip-v">{VERDICT_NAMES[verdict].split(' ')[0]}</span>}
    </div>
  );
}

export function Palette({ nodeId, analysis }: { nodeId: string; analysis?: Analysis }) {
  const { project: p, edit, focusTab } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const s = analysis?.scenarios[nodeId];
  const judged = (it: CatalogItem) => (s ? judgeItem(it, n, s) : undefined);
  const items = (role: '주' | '보조') => catalog.items.filter((i) => i.role === role && i.attaches_to.includes(n.layer)).map((it) => {
    const j = judged(it);
    const used = it.id === n.primary || n.extras.includes(it.id);
    return (
      <Chip key={it.id} verdict={j?.verdict} on={used ? '사용 중' : undefined} note={[it.summary, ...(j?.reasons ?? [])].filter(Boolean).join('\n')}
        drag={used || j?.verdict === 'fail' ? undefined : { kind: 'item', id: it.id }}>{it.name}</Chip>
    );
  });
  const sp = nodeStorageProfile(n, catalog.byId);
  const onFeat = new Set(sp ? selectedFeatures(sp, n).map((f) => f.id) : []);

  return (
    <div className="palette" onDragOver={(e) => isOurDrag(e) && e.preventDefault()} onDrop={(e) => {
      const d = readDrag(e);
      if (d?.kind === 'remove') { e.preventDefault(); edit((x) => dropRemove(x, nodeId, d)); }
    }}>
      <h3>쓸 수 있는 기능</h3>
      <p className="muted phint">끌어서 오른쪽 그림에 놓으면 더해져요. 그림의 블록을 여기로 끌어 오면 빠져요.</p>
      {focusTab === 'wireframe' ? WIRE_GROUPS.map(([g, kinds]) => (
        <section key={g}><h4>{g}</h4>{kinds.map((k) => <Chip key={k} drag={{ kind: 'ui', ui: k }}>{WIRE_NAMES[k]}</Chip>)}</section>
      )) : focusTab === 'tables' ? <>
        <section><h4>구성 요소</h4>
          <Chip drag={{ kind: 'table' }}>테이블</Chip>
          <Chip drag={p.nodes.some((x) => x.tables.length) ? { kind: 'action' } : undefined} note="테이블이 하나 이상 있어야 행동을 만들 수 있어요">행동 (쓰기)</Chip>
        </section>
        {sp ? Object.entries(sp.groups).map(([g, def]) => (
          <section key={g}><h4>{def.label}{def.one ? ' (하나만)' : ''}</h4>
            {sp.features.filter((f) => f.group === g).map((f) => (
              <Chip key={f.id} on={onFeat.has(f.id) ? '켜짐' : f.recommended ? '권장' : undefined} note={f.note}
                drag={onFeat.has(f.id) ? undefined : { kind: 'feature', id: f.id }}>{f.label}</Chip>
            ))}
          </section>
        )) : <p className="muted phint">주 항목에 저장 프로필이 없어 고를 저장 기능이 없어요.</p>}
      </> : <>
        <section><h4>주 항목 (놓으면 교체)</h4>{items('주')}</section>
        <section><h4>보조 항목 (놓으면 추가)</h4>{items('보조')}</section>
      </>}
    </div>
  );
}
