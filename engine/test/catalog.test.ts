import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../io';
import { judgeNode } from '../judge';
import { computedScenarios } from '../load';
import { Project } from '../schema';

const dir = fileURLToPath(new URL('../../data/catalog', import.meta.url));
const catalog = loadCatalog(dir);

/** 구동 방식만 정한 노드 하나로 판정한다 (트래픽 없이 deploy 변수만 들어감). */
const judge = (mode: string, layer: string, primary: string, extra: object = {}) => {
  const p = Project.parse({ name: 'p', deploy: { mode, ...extra }, nodes: [{ id: 'n', name: 'n', layer, primary }] });
  return judgeNode(p.nodes[0], catalog.byId, computedScenarios(p, undefined).get('n')).items[0];
};

describe('계층별 카탈로그 (l1~l6)', () => {
  it('계층 파일의 모든 항목에 한 줄 설명과 http 출처가 있음', () => {
    for (const f of readdirSync(dir).filter((x) => /^l\d-.*\.json$/.test(x))) {
      for (const it of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))) {
        expect(it.summary, `${f}:${it.id}`).toBeTruthy();
        expect(it.sources.some((s: string) => s.startsWith('https://')), `${f}:${it.id}`).toBe(true);
      }
    }
  });

  it('6계층이 모두 채워져 있음', () => {
    const layers = new Set(catalog.items.flatMap((i) => i.attaches_to));
    for (const l of ['ui', 'gateway', 'backend', 'cache', 'queue', 'batch', 'db', 'analytics']) expect(layers.has(l as never), l).toBe(true);
  });
});

describe('구동 방식에 따라 판정이 바뀜', () => {
  it('Electron: 로컬 exe면 됨, 웹이면 안 됨', () => {
    expect(judge('local_exe', 'ui', 'react_next').verdict).toBe('ok');
    const p = (mode: string) => Project.parse({ name: 'p', deploy: { mode }, nodes: [{ id: 'n', name: 'n', layer: 'ui', primary: 'react_next', extras: ['electron'] }] });
    const verdictOf = (mode: string) => judgeNode(p(mode).nodes[0], catalog.byId, computedScenarios(p(mode), undefined).get('n')).items[1].verdict;
    expect(verdictOf('local_exe')).toBe('ok');
    expect(verdictOf('web')).toBe('fail');
  });

  it('React Native를 웹 구동 방식에 고르면 안 됨, 대안은 Flutter·PWA', () => {
    const j = judge('web', 'ui', 'react_native');
    expect(j.verdict).toBe('fail');
    expect(j.alternatives.map((a) => a.id)).toEqual(['flutter', 'pwa']);
  });

  it('오프라인 로컬 exe에서 관리형 DB(DynamoDB)는 안 되고, libSQL은 됨', () => {
    expect(judge('local_exe', 'db', 'dynamodb', { offline_required: true }).verdict).toBe('fail');
    expect(judge('local_exe', 'db', 'libsql_turso', { offline_required: true }).verdict).toBe('ok');
  });

  it('Ingress NGINX는 항상 안 됨(유지보수 종료), 웹에서는 Envoy Gateway가 대안', () => {
    const j = judge('web', 'gateway', 'ingress_nginx');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('2026년 3월');
    expect(j.alternatives.map((a) => a.id)).toEqual(['envoy_gateway', 'traefik']);
  });
});
