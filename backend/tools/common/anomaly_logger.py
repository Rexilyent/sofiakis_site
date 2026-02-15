import json
from pathlib import Path
from datetime import datetime

class AnomalyLogger:

    def __init__(self, release_id, strict=False):
        self.release_id = release_id
        self.strict = strict
        self.issues = []
        self.log_path = Path("logs")
        self.log_path.mkdir(exist_ok=True)

        self.file = self.log_path / f"{release_id}_anomalies.log"

    def record(self, shard_id, issue_code, message):
        entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "release_id": self.release_id,
            "shard_id": shard_id,
            "code": issue_code,
            "message": message,
        }

        self.issues.append(entry)

        with self.file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

        if self.strict:
            raise RuntimeError(
                f"[STRICT] {issue_code}: {message}"
            )

    def summary(self):
        return {
            "total_anomalies": len(self.issues),
            "by_code": self._count_by_code(),
        }

    def _count_by_code(self):
        counts = {}
        for i in self.issues:
            counts[i["code"]] = counts.get(i["code"], 0) + 1
        return counts
