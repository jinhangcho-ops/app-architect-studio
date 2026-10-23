// 사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더]
import { fileURLToPath } from 'node:url';
import { judgeNode, checkRules } from './judge';
import { loadCatalog, loadProject } from './load';
import { VERDICT_NAMES } from './model';

const [projectPath, catalogDir = fileURLToPath(new URL('../data/catalog', import.meta.url))] = process.argv.slice(2);
if (!projectPath) {
  console.error('사용법: npm run judge -- <프로젝트.json> [카탈로그 폴더]');
  process.exit(2);
}

try {
  const catalog = loadCatalog(catalogDir);
  const project = loadProject(projectPath, catalog.items);
  console.log(`# ${project.name}\n`);
  for (const node of project.nodes) {
    for (const j of judgeNode(node, catalog.byId).items) {
      console.log(`${VERDICT_NAMES[j.verdict]}  ${node.name} · ${catalog.byId.get(j.itemId)!.name}`);
      for (const r of j.reasons) console.log(`    ${r}`);
      for (const a of j.alternatives) {
        console.log(`    → 대안 ${VERDICT_NAMES[a.verdict]} ${catalog.byId.get(a.id)!.name}${a.note ? ` (${a.note})` : ''}`);
      }
    }
  }
  const hits = checkRules(project, catalog.rules);
  if (hits.length) console.log('\n## 구조 규칙');
  for (const h of hits) console.log(`❌ ${h.target}\n    ${h.why}\n    → ${h.instead}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
