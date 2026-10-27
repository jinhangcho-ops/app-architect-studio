import { describe, expect, it } from 'vitest';
import { chapterTitle, parseInline, parseNote, splitChapters } from './notes';

// 사용자가 붙여 준 거래명세서 설계서의 한 부분 (표·목록·코드·중첩 목록·인용 없는 굵게)
const doc = [
  '**목적**: 음식점에서 거래명세서를 입력하면 매입 데이터로 저장한다.',
  '',
  '### 기술 스택',
  '',
  '| 영역 | 선택 |',
  '| --- | --- |',
  '| 앱 | React + TypeScript (Vite, `vite-plugin-pwa`) |',
  '| OCR | Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`) |',
  '',
  '1. 단어를 y좌표 기준으로 묶어 줄(row) 구성',
  '2. 헤더 행 탐지: 키워드 사전으로 열 이름 식별',
  '    - 품명 = 품목 / 품목명',
  '    - 수량 = 수량 / 중량',
  '3. 합계/소계 행 제거',
  '',
  '```sql',
  'create table vendors (',
  '  id uuid primary key,',
  '',
  '  name text not null  -- | 와 ** 는 그대로',
  ');',
  '```',
  '이어지는 문단',
].join('\n');

describe('설계 메모: 가벼운 마크다운 읽기', () => {
  it('붙여 준 설계서: 문단·소제목·표·번호 목록(중첩)·코드 블록으로 나뉨', () => {
    const b = parseNote(doc);
    expect(b.map((x) => x.kind)).toEqual(['paragraph', 'heading', 'table', 'list', 'code', 'paragraph']);
    expect(b[1]).toEqual({ kind: 'heading', level: 3, text: '기술 스택' });
    expect(b[2]).toEqual({ kind: 'table', head: ['영역', '선택'], rows: [['앱', 'React + TypeScript (Vite, `vite-plugin-pwa`)'], ['OCR', 'Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`)']] });
    expect(b[3]).toEqual({ kind: 'list', items: [
      { text: '단어를 y좌표 기준으로 묶어 줄(row) 구성', depth: 0, ordered: true, num: '1.' },
      { text: '헤더 행 탐지: 키워드 사전으로 열 이름 식별', depth: 0, ordered: true, num: '2.' },
      { text: '품명 = 품목 / 품목명', depth: 1, ordered: false },
      { text: '수량 = 수량 / 중량', depth: 1, ordered: false },
      { text: '합계/소계 행 제거', depth: 0, ordered: true, num: '3.' },
    ] });
    // 코드 안의 빈 줄·| ·** 는 그대로
    expect(b[4]).toEqual({ kind: 'code', lang: 'sql', text: 'create table vendors (\n  id uuid primary key,\n\n  name text not null  -- | 와 ** 는 그대로\n);' });
  });

  it('깨진 입력도 글이 사라지지 않음: 닫히지 않은 코드, 칸 수가 다른 표, 머리 없는 표', () => {
    expect(parseNote('앞\n```\n코드 끝 없음\n둘째 줄')).toEqual([{ kind: 'paragraph', text: '앞' }, { kind: 'code', lang: '', text: '코드 끝 없음\n둘째 줄' }]);
    expect(parseNote('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')).toEqual([{ kind: 'table', head: ['a', 'b'], rows: [['1', ''], ['1', '2 | 3']] }]);
    expect(parseNote('| x \\| y | z |\n| 1 | 2 |')).toEqual([{ kind: 'table', head: [], rows: [['x | y', 'z'], ['1', '2']] }]);
  });

  it('인용·가로줄·이어지는 목록 줄·HTML은 글자 그대로', () => {
    expect(parseNote('> 주의: 서비스 키\n> 노출 금지\n\n---\n- 첫째\n  이어짐\n- 둘째\n<script>alert(1)</script>')).toEqual([
      { kind: 'quote', text: '주의: 서비스 키\n노출 금지' },
      { kind: 'rule' },
      { kind: 'list', items: [{ text: '첫째\n이어짐', depth: 0, ordered: false }, { text: '둘째', depth: 0, ordered: false }] },
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
    ]);
  });

  it('글 안: **굵게**, `코드`, 코드 안의 ** 와 짝 없는 기호는 그대로', () => {
    expect(parseInline('**PWA는** `service key` 노출 금지')).toEqual([
      { kind: 'bold', text: 'PWA는' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'service key' }, { kind: 'text', text: ' 노출 금지' },
    ]);
    expect(parseInline('`a**b**` 와 **열린 채')).toEqual([{ kind: 'code', text: 'a**b**' }, { kind: 'text', text: ' 와 **열린 채' }]);
  });
});

describe('마크다운 문서 → 장 나누기', () => {
  it('## 제목마다 장, 코드 블록 안의 ##는 그대로, # 제목 아래 글은 그 제목의 장', () => {
    const doc = ['# 거래명세서 설계서', '', '머리 글', '', '## 1. 개요', '', '**목적**: 자동 입력', '', '## 2. 범위', '- 사진 촬영', '```', '## 코드 속 제목', '```', '', ''].join('\n');
    expect(splitChapters(doc)).toEqual([
      { title: '거래명세서 설계서', body: '머리 글' },
      { title: '1. 개요', body: '**목적**: 자동 입력' },
      { title: '2. 범위', body: '- 사진 촬영\n```\n## 코드 속 제목\n```' },
    ]);
  });
  it('장 제목 앞의 번호는 뗌 (설계서가 번호를 매김), 숫자로 시작하는 낱말은 그대로', () => {
    expect(['1. 개요', '5.3 표 복원', '2) 범위', '7 SQL', '2024 로드맵', '2024년 계획', '3D 보기', '  '].map(chapterTitle)).toEqual(['개요', '표 복원', '범위', '7 SQL', '2024 로드맵', '2024년 계획', '3D 보기', '(제목 없음)']);
  });
  it('머리 글이 없으면 그 장은 없고, ## 가 없으면 한 장', () => {
    expect(splitChapters('# 제목만\n\n## A\n가')).toEqual([{ title: 'A', body: '가' }]);
    expect(splitChapters('그냥 글\n  - 들여 쓴 목록')).toEqual([{ title: '머리말', body: '그냥 글\n  - 들여 쓴 목록' }]);
  });
});

describe('리뷰: 설계 메모 기능', () => {
  it('언어 뒤에 글이 붙은 울타리, ```` 울타리도 닫히고, 뒤 글·장이 살아 있음', () => {
    expect(parseNote('```ts title="a.ts"\nconst a = 1;\n```\n뒤 글')).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = 1;' }, { kind: 'paragraph', text: '뒤 글' }]);
    expect(parseNote('````md\n```\n안\n```\n````\n밖')).toEqual([{ kind: 'code', lang: 'md', text: '```\n안\n```' }, { kind: 'paragraph', text: '밖' }]);
    expect(splitChapters('## 1. 개요\n```ts title="a.ts"\nx\n```\n## 2. 범위\n본문\n## 3. 보안\n끝').map((c) => c.title)).toEqual(['1. 개요', '2. 범위', '3. 보안']);
  });
  it('제목 끝 # 는 앞에 공백이 있을 때만 뗌 (C#)', () => {
    expect(parseNote('## 언어: C#\n### 마무리 ##')).toEqual([{ kind: 'heading', level: 2, text: '언어: C#' }, { kind: 'heading', level: 3, text: '마무리' }]);
    expect(splitChapters('## F#\n글')[0].title).toBe('F#');
  });
  it('번호는 적은 그대로: 빈 줄로 나뉜 목록, 날짜 줄', () => {
    const nums = (s: string) => parseNote(s).flatMap((b) => (b.kind === 'list' ? b.items.map((x) => x.num) : []));
    expect(nums('1. 설치\n\n2. 실행\n\n3) 확인')).toEqual(['1.', '2.', '3)']);
    expect(nums('2024. 3. 15. 회의에서 결정')).toEqual(['2024.']);
  });
});
