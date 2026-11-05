"""Generate the Assets and single-file Worker initializer from worker.d1.sql."""
from pathlib import Path
import hashlib
import json
import re
import sqlite3
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Check generated files without changing them")
args = parser.parse_args()

root = Path(__file__).resolve().parent.parent
sql = (root / "worker.d1.sql").read_text()
statements = []
pending = ""
for line in sql.splitlines():
    if line.lstrip().startswith("--"):
        continue
    pending += line + "\n"
    if sqlite3.complete_statement(pending):
        statement = " ".join(pending.split())
        # D1 already enforces foreign keys; PRAGMA is unnecessary inside a batch.
        if not statement.upper().startswith("PRAGMA FOREIGN_KEYS"):
            statements.append(statement)
        pending = ""
if pending.strip():
    raise ValueError("Incomplete SQL statement")

payload = {
    "schema_version": 1,
    "source_sha256": hashlib.sha256(sql.encode()).hexdigest(),
    "statements": statements,
}
serialized = json.dumps(payload, ensure_ascii=False, indent=2)
assets = root / "assets"

worker_path = root / "worker.js"
worker = worker_path.read_text()
block = "// BEGIN GENERATED D1 INITIALIZATION\nconst D1_INITIALIZATION = " + serialized + ";\n// END GENERATED D1 INITIALIZATION"
pattern = r"// BEGIN GENERATED D1 INITIALIZATION\n.*?// END GENERATED D1 INITIALIZATION"
if re.search(pattern, worker, re.S):
    worker = re.sub(pattern, lambda _: block, worker, count=1, flags=re.S)
else:
    anchor = "const D1_SCHEMA_VERSION = 1;\n"
    if anchor not in worker:
        raise ValueError("Worker schema version anchor missing")
    worker = worker.replace(anchor, anchor + block + "\n", 1)
if args.check:
    if not (assets / "d1-init.json").exists() or (assets / "d1-init.json").read_text() != serialized + "\n" or worker_path.read_text() != worker:
        parser.exit(1, "D1 initializer is outdated; run npm run build:d1\n")
    print(f"Verified {len(statements)} complete SQL statements for /init")
else:
    assets.mkdir(exist_ok=True)
    (assets / "d1-init.json").write_text(serialized + "\n")
    worker_path.write_text(worker)
    print(f"Generated {len(statements)} complete SQL statements for /init")
