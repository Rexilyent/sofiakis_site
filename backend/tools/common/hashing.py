# ----------------------------------------------------------------------------
# Hashing utilities for datasets and releases.
# ----------------------------------------------------------------------------

import hashlib
import json
from pathlib import Path

READ_CHUNK = 1024 * 1024


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(READ_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def dataset_checksum(checksums: dict) -> str:
    return hashlib.sha256(
        json.dumps(checksums, sort_keys=True).encode()
    ).hexdigest()
