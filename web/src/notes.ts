// 설계 메모 본문(가벼운 마크다운) → 블록. 그리는 쪽은 React 요소만 만들어, 메모에 적은 HTML은 글자로만 보인다.
// 받는 것: # 제목(1~6), - * 목록, 1. 번호 목록(들여쓰기 = 한 단계 안쪽), | 표 |(둘째 줄 |---|면 머리), ``` 코드 ```, > 인용, --- 가로줄, 빈 줄 = 문단 끝.
// 글 안: **굵게**, `코드`. 링크·이미지·HTML은 받지 않는다(글자 그대로).

export type Span = { kind: 'text' | 'bold' | 'code'; text: string };
export type ListItem = { text: string; depth: number; ordered: boolean };
export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'rule' };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isRow = (l: string) => /^\s*\|/.test(l);

/** 표 한 줄 → 칸들. 앞뒤 | 를 떼고, \| 는 칸 안의 글자 | */
const cells = (l: string) => {
  const s = l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

export function parseNote(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ kind: 'paragraph', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = FENCE.exec(l);
    if (fence) {
      // 닫는 줄이 없으면 끝까지 코드로 (뒤 글이 사라지지 않게)
      flush();
      const text: string[] = [];
      for (i++; i < lines.length && !(lines[i].trim().startsWith(fence[1]) && FENCE.test(lines[i])); i++) text.push(lines[i]);
      out.push({ kind: 'code', lang: fence[2], text: text.join('\n') });
      continue;
    }
    if (!l.trim()) { flush(); continue; }
    const h = HEADING.exec(l);
    if (h) { flush(); out.push({ kind: 'heading', level: h[1].length, text: h[2] }); continue; }
    if (RULE.test(l) && !para.length) { out.push({ kind: 'rule' }); continue; }
    if (isRow(l)) {
      flush();
      const rows: string[][] = [];
      let head: string[] = [];
      for (; i < lines.length && isRow(lines[i]); i++) {
        if (SEPARATOR.test(lines[i])) { if (rows.length === 1 && !head.length) head = rows.pop()!; continue; }
        rows.push(cells(lines[i]));
      }
      i--;
      // 칸 수를 머리(없으면 가장 긴 줄)에 맞춘다: 모자라면 빈 칸, 넘치면 마지막 칸에 붙인다
      const n = head.length || Math.max(...rows.map((r) => r.length));
      out.push({ kind: 'table', head, rows: rows.map((r) => (r.length > n ? [...r.slice(0, n - 1), r.slice(n - 1).join(' | ')] : [...r, ...Array(n - r.length).fill('')])) });
      continue;
    }
    const item = ITEM.exec(l);
    if (item) {
      flush();
      const items: ListItem[] = [];
      // 들여쓰기가 앞보다 깊으면 한 단계 안쪽 (2칸이든 4칸이든), 얕아지면 그 깊이까지 돌아온다. 3단계까지
      const indents: number[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (m) {
          const indent = m[1].replace(/\t/g, '    ').length;
          while (indents.length && indent < indents[indents.length - 1]) indents.pop();
          if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
          items.push({ text: m[3], depth: Math.min(3, indents.length - 1), ordered: /\d/.test(m[2]) });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // 들여 쓴 이어지는 줄은 앞 항목에 붙인다
          items[items.length - 1].text += `\n${lines[i].trim()}`;
        } else break;
      }
      i--;
      out.push({ kind: 'list', items });
      continue;
    }
    if (/^\s*>/.test(l)) {
      flush();
      const text: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) text.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push({ kind: 'quote', text: text.join('\n') });
      continue;
    }
    para.push(l);
  }
  flush();
  return out;
}

/** 글 한 덩이 → 보통 글·굵게·코드. `코드` 안의 ** 는 굵게로 보지 않는다. 짝이 없는 ** · ` 는 글자 그대로 */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  const push = (kind: Span['kind'], s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += s;
    else out.push({ kind, text: s });
  };
  const re = /`([^`\n]+)`|\*\*(.+?)\*\*/g;
  let at = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    push('text', text.slice(at, m.index));
    if (m[1] !== undefined) push('code', m[1]);
    else push('bold', m[2]);
    at = m.index + m[0].length;
  }
  push('text', text.slice(at));
  return out;
}

export { chapterTitle } from '../../engine/schema';

/** 마크다운 문서 한 덩이 → 장 목록. `## 제목` 줄마다 새 장 (코드 블록 안의 ##는 제외).
 *  첫 ## 앞의 글은 맨 앞 `# 제목`을 장 제목으로(없으면 "머리말") 한 장이 된다. 앞뒤 빈 줄은 뗀다 */
export function splitChapters(doc: string): { title: string; body: string }[] {
  const lines = doc.replace(/\r\n?/g, '\n').split('\n');
  const out: { title: string; lines: string[] }[] = [{ title: '', lines: [] }];
  let fence: string | undefined;
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (f) fence = fence === undefined ? f[1] : l.trim().startsWith(fence) ? undefined : fence;
    const h = fence === undefined && !f ? /^\s{0,3}##\s+(.*?)\s*#*\s*$/.exec(l) : null;
    if (h) out.push({ title: h[1], lines: [] });
    else out[out.length - 1].lines.push(l);
  }
  const trim = (ls: string[]) => ls.join('\n').replace(/^\s*\n/, '').trimEnd();
  const [head, ...rest] = out;
  const top = /^\s{0,3}#\s+(.*?)\s*#*\s*$/.exec(head.lines.find((l) => l.trim()) ?? '');
  const headBody = trim(top ? head.lines.slice(head.lines.findIndex((l) => l.trim()) + 1) : head.lines);
  return [
    ...(headBody.trim() ? [{ title: top?.[1] ?? '머리말', body: headBody }] : []),
    ...rest.map((c) => ({ title: c.title.replace(/^\d+(\.\d+)*[.)]?\s+/, ''), body: trim(c.lines) })),
  ];
}
