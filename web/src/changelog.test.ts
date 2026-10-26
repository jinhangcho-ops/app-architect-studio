import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('CHANGELOG.md · 릴리스 워크플로', () => {
  const log = read('CHANGELOG.md');
  const sections = log.split(/^## /m).slice(1);

  it('모든 ## v 절이 정확히 추가 · 개선 · 삭제 순서의 세 칸을 갖고, 칸마다 한 줄 이상', () => {
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) {
      const [head, ...body] = s.split('\n');
      expect(head, '절 제목').toMatch(/^v\d+\.\d+\.\d+$/);
      expect(body.filter((l) => l.startsWith('#')), head).toEqual(['### 추가', '### 개선', '### 삭제']);
      for (const part of body.join('\n').split(/^### .*$/m).slice(1)) expect(part.trim(), `${head}의 빈 칸`).toMatch(/^- /);
    }
  });

  it('지금 package.json 버전의 절이 있음 (태그를 올리면 이 절이 릴리스 노트가 됨)', () => {
    const v = JSON.parse(read('package.json')).version;
    expect(log).toContain(`\n## v${v}\n`);
  });

  it('워크플로가 CHANGELOG에서 이 태그의 절을 뽑아 RELEASE_NOTES.md로 올리고, --generate-notes는 쓰지 않음', () => {
    const wf = read('.github/workflows/release.yml');
    expect(wf).toContain(`awk -v head="## $TAG" '$0 == head {on = 1; next} /^## v/ {on = 0} on' CHANGELOG.md`);
    expect(wf).toContain("CHANGELOG.md에 '## $TAG' 절이 없습니다");
    expect(wf).toContain('RELEASE_NOTES.md');
    expect(wf).not.toContain('--generate-notes');
    expect(wf).not.toMatch(/runs-on: .*-latest/);
    expect(wf).toContain('persist-credentials: false');
  });
});
