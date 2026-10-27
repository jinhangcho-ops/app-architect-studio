// @vitest-environment happy-dom
// 설정의 "설계 메모": 장 추가·고치기·순서·지우기·마크다운 붙여 넣기
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { NotesSection } from './NotesPanel';
import { useStore } from './store';

const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const notes = () => useStore.getState().project.notes;

it('장을 더해 적고, 순서를 바꾸고, 지우고, 붙여 넣은 문서를 장으로 나눔', () => {
  const ex = examples.find((e) => e.name === 'phase1.json')!;
  useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name), past: [], future: [] });
  const el = document.createElement('div');
  const root = createRoot(el);
  const render = () => flushSync(() => root.render(<NotesSection />));
  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  const click = (text: string) => flushSync(() => ([...el.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text) as HTMLButtonElement).click());
  render();

  click('+ 장 추가'); click('+ 장 추가');
  setValue(q<HTMLInputElement>('input[aria-label="1장 제목"]'), '개요'); render();
  setValue(q<HTMLTextAreaElement>('textarea[aria-label="1장 본문"]'), '| a | b |\n|---|---|\n| 1 | 2 |'); render();
  setValue(q<HTMLInputElement>('input[aria-label="2장 제목"]'), '범위'); render();
  expect(notes().map((n) => n.title)).toEqual(['개요', '범위']);

  click('2장 위로');
  expect(notes().map((n) => n.title)).toEqual(['범위', '개요']);
  // 미리보기: 표로 그림
  flushSync(() => ([...el.querySelectorAll('.note-edit')][1].querySelector('button:nth-of-type(3)') as HTMLButtonElement).click());
  expect(el.querySelector('.note-preview table.note-table')).not.toBeNull();

  click('1장 지우기');
  expect(notes().map((n) => n.title)).toEqual(['개요']);

  setValue(q<HTMLTextAreaElement>('textarea[aria-label="붙여 넣을 마크다운"]'), '## 2. 범위\n- 사진\n## 3. 구조\n글'); render();
  click('지금 장 뒤에 붙이기');
  expect(notes().map((n) => n.title)).toEqual(['개요', '범위', '구조']);
  setValue(q<HTMLTextAreaElement>('textarea[aria-label="붙여 넣을 마크다운"]'), '## 새 장\n본문'); render();
  click('지금 장을 모두 바꾸기');
  expect(notes()).toEqual([{ title: '새 장', body: '본문' }]);
  root.unmount();
});
