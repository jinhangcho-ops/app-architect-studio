#!/usr/bin/env python3
"""11.3 파이썬 코드 역공학: 폴더의 .py 파일을 ast로 읽어 모듈·import 관계·라이브러리 매칭·개인정보 후보를 JSON으로 낸다.

사용법:
    python tools/analyze_py.py <폴더> > code.json      # 화면의 "코드 분석 불러오기"로 연다
    python tools/analyze_py.py --self-test

v2 analyze_python_file의 핵심(상시/지연 import 판별)만 옮겼다. 한국어 설명 문장 생성은 하지 않는다.
"""
import ast
import json
import os
import re
import sys
import tempfile

# 라이브러리 → 카탈로그 항목 id (data/catalog). 없는 것은 매칭하지 않는다
LIBRARY_ITEM = {
    "sqlite3": "sqlite", "psycopg": "postgresql", "psycopg2": "postgresql", "asyncpg": "postgresql",
    "pymysql": "mysql", "MySQLdb": "mysql", "mysql": "mysql", "pymongo": "mongodb", "motor": "mongodb",
    "redis": "valkey", "valkey": "valkey", "pymemcache": "memcached",
    "kafka": "kafka", "confluent_kafka": "kafka", "aiokafka": "kafka", "pika": "rabbitmq", "nats": "nats_jetstream",
    "fastapi": "fastapi", "grpc": "grpc", "temporalio": "temporal", "duckdb": "duckdb",
    "clickhouse_connect": "clickhouse", "snowflake": "snowflake", "pyiceberg": "iceberg",
}
# 개인정보 후보: 식별자·문자열에 이런 단어가 있으면 후보로만 표시하고 사람이 확정한다
PRIVACY_HINT = re.compile(r"(email|e_mail|phone|mobile|address|birth|resident|ssn|jumin|passport|name_kor|real_name)", re.I)


def module_id(root: str, path: str) -> str:
    rel = os.path.relpath(path, root)
    return rel[:-3].replace(os.sep, ".").removesuffix(".__init__")


def analyze_file(root: str, path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=path)
    eager, lazy, hints = [], [], set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            # 파일 맨 위(모듈 본문 바로 아래)에 있으면 상시, 함수·클래스 안이면 지연 로드
            (eager if node in tree.body else lazy).extend(n for n in names if n)
        elif isinstance(node, ast.Name) and PRIVACY_HINT.search(node.id):
            hints.add(node.id)
        elif isinstance(node, ast.Attribute) and PRIVACY_HINT.search(node.attr):
            hints.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and PRIVACY_HINT.fullmatch(node.value):
            hints.add(node.value)
    name = module_id(root, path)
    lowered = name.lower()
    layer = "batch" if re.search(r"(worker|batch|job|cron|consumer)", lowered) else "backend"
    return {"id": name, "file": os.path.relpath(path, root), "layer": layer,
            "eager": sorted(set(eager)), "lazy": sorted(set(lazy)), "privacy_hints": sorted(hints)}


def analyze_folder(root: str) -> dict:
    modules = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith((".", "__pycache__", "venv", ".venv", "node_modules"))]
        for fn in sorted(filenames):
            if fn.endswith(".py"):
                modules.append(analyze_file(root, os.path.join(dirpath, fn)))
    ids = {m["id"] for m in modules}
    edges, matches = [], []
    for m in modules:
        for imp in m["eager"] + m["lazy"]:
            # 같은 폴더 안의 모듈을 부르면 연결선, 아니면 바깥 라이브러리로 본다
            # 패키지(services)와 그 안의 모듈(services.order_worker)이 둘 다 맞으면 더 구체적인 쪽(긴 이름)
            target = max((i for i in ids if imp == i or imp.startswith(i + ".")), key=len, default=None)
            if target and target != m["id"]:
                edges.append({"from": m["id"], "to": target})
                continue
            top = imp.split(".")[0]
            if top in LIBRARY_ITEM:
                matches.append({"module": m["id"], "library": top, "item": LIBRARY_ITEM[top], "eager": imp in m["eager"]})
    uniq = lambda xs: [dict(t) for t in {tuple(sorted(x.items())) for x in xs}]
    return {"source": os.path.abspath(root), "modules": modules,
            "edges": sorted(uniq(edges), key=lambda e: (e["from"], e["to"])),
            "matches": sorted(uniq(matches), key=lambda x: (x["module"], x["library"]))}


def self_test() -> None:
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "services"))
        open(os.path.join(d, "services", "__init__.py"), "w").close()
        with open(os.path.join(d, "main.py"), "w", encoding="utf-8") as f:
            f.write("import redis\nfrom services.order_worker import run\n")
        with open(os.path.join(d, "services", "order_worker.py"), "w", encoding="utf-8") as f:
            f.write("def run():\n    import sqlite3\n    user_email = 'a@b.c'\n")
        r = analyze_folder(d)
        ids = {m["id"]: m for m in r["modules"]}
        assert set(ids) == {"main", "services", "services.order_worker"}, ids
        assert ids["services.order_worker"]["layer"] == "batch"
        assert ids["services.order_worker"]["lazy"] == ["sqlite3"]
        assert ids["services.order_worker"]["privacy_hints"] == ["user_email"]
        assert {"from": "main", "to": "services.order_worker"} in r["edges"], r["edges"]
        assert {"module": "main", "library": "redis", "item": "valkey", "eager": True} in r["matches"]
        assert {"module": "services.order_worker", "library": "sqlite3", "item": "sqlite", "eager": False} in r["matches"]
    print("SELF_TEST_OK")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
    elif len(sys.argv) == 2 and os.path.isdir(sys.argv[1]):
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(analyze_folder(sys.argv[1]), ensure_ascii=False, indent=2))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
