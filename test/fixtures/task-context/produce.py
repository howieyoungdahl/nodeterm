"""Synthetic canonical D15 producer, never a live ledger or provider call.

Pass the explicitly selected canonical context.py and an existing disposable directory.
The test invokes the producer APIs; no recorded envelope is hand-recreated here.
"""
import json
import sys
import time
from pathlib import Path

script, root = Path(sys.argv[1]), Path(sys.argv[2])
assert root.is_dir() and root.name.startswith("nodeterm-task-")
sys.path.insert(0, str(script.parent))
import context
import ledger

doc = ledger.empty_ledger()
doc["generation"] = int(sys.argv[3]) if len(sys.argv) > 3 else 1
doc["tasks"] = []
for index in range(320):
    doc["tasks"].append({
        "task_id": f"task-{index:03}", "project_id": "project-a",
        "node": f"node-{index:03}", "class": "IDLE", "observed_at": time.time() - 10,
        "stage": "building", "objective": f"Synthetic objective {index}",
        "next_action": {"text": "Verify fixture output", "owner": "director"},
        "blockers": [{"text": "Synthetic dependency", "kind": "dependency", "owner": "director"}],
        "workers": [{"node": f"worker-{index:03}", "state": "BUSY", "blockers": ["Synthetic blocker"]}],
    })
ledger.write_json(root / "ledger.json", doc)
result = context.publish(root / "ledger.json")
assert result["ok"], result
print(json.dumps(result))
