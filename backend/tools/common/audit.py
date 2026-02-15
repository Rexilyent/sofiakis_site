# ==================================================
# Audit Utilities
# ==================================================

import json
import socket
import platform
from datetime import datetime, UTC
from dataclasses import dataclass, asdict, field
from typing import Dict, Any, Optional

# Optional signing integration (lazy import safe)
try:
    from common.signing import sha256_digest
except ImportError:
    sha256_digest = None


# ==================================================
# Base Audit Model
# ==================================================

@dataclass
class AuditBase:
    event_type: str
    created_at: str = field(default_factory=lambda:
        datetime.now(UTC).isoformat().replace("+00:00", "Z")
    )
    hostname: Optional[str] = None
    platform: Optional[str] = None
    python_version: Optional[str] = None

    def enrich_environment(self):
        self.hostname = socket.gethostname()
        self.platform = platform.platform()
        self.python_version = platform.python_version()

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_dict(),
            sort_keys=True,
            separators=(",", ":")
        )

    def digest(self) -> Optional[str]:
        if sha256_digest:
            return sha256_digest(self.to_dict())
        return None


# ==================================================
# Upload Audit Record
# ==================================================

@dataclass
class UploadAuditRecord(AuditBase):
    release_id: str = ""
    cycle: int = 0
    candidate_shards: int = 0
    committee_shards: int = 0
    checksum_sha256: str = ""
    uploader_version: str = ""
    manifest_signature: Optional[str] = None
    anomaly_summary: Optional[str] = None


def build_upload_audit(
    release_id: str,
    cycle: int,
    candidate_shards: int,
    committee_shards: int,
    checksum_sha256: str,
    uploader_version: str,
    manifest_signature: Optional[str] = None,
    anomaly_summary: Optional[Dict[str, Any]] = None,
    include_environment: bool = True,
) -> UploadAuditRecord:

    record = UploadAuditRecord(
        event_type="upload",
        release_id=release_id,
        cycle=cycle,
        candidate_shards=candidate_shards,
        committee_shards=committee_shards,
        checksum_sha256=checksum_sha256,
        uploader_version=uploader_version,
        manifest_signature=manifest_signature,
        anomaly_summary=(
            json.dumps(anomaly_summary, separators=(",", ":"))
            if anomaly_summary else None
				)
    )

    if include_environment:
        record.enrich_environment()

    return record


# ==================================================
# Verification Audit Record
# ==================================================

@dataclass
class VerificationAuditRecord(AuditBase):
    release_id: str = ""
    cycle: int = 0
    dataset_sha256: str = ""
    deep_verified: bool = False


def build_verification_audit(
    release_id: str,
    cycle: int,
    dataset_sha256: str,
    deep_verified: bool,
    include_environment: bool = True,
) -> VerificationAuditRecord:

    record = VerificationAuditRecord(
        event_type="verification",
        release_id=release_id,
        cycle=cycle,
        dataset_sha256=dataset_sha256,
        deep_verified=deep_verified,
    )

    if include_environment:
        record.enrich_environment()

    return record


# ==================================================
# SQL Generator
# ==================================================

def build_insert_sql(
    record: AuditBase,
    table_name: str,
    conflict_clause: str = "ON CONFLICT DO NOTHING"
) -> str:
    """
    Generic SQL insert builder for any audit record.
    """

    def esc(v):
        if v is None:
            return "NULL"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        return "'" + str(v).replace("'", "''") + "'"

    fields = record.to_dict()

    columns = []
    values = []

    for k, v in fields.items():
        columns.append(k)
        values.append(esc(v))

    return f"""
    INSERT INTO {table_name}
    ({', '.join(columns)})
    VALUES ({', '.join(values)})
    {conflict_clause};
    """


# ==================================================
# JSON Export
# ==================================================

def export_audit_json(
    record: AuditBase,
    path
):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            record.to_dict(),
            f,
            indent=2,
            sort_keys=True
        )


# ==================================================
# Optional Signing Integration
# ==================================================

def sign_audit_record(
    record: AuditBase,
    private_key
) -> Dict[str, Any]:
    """
    Returns signed payload structure.
    Requires signing.py to be installed.
    """

    from common.signing import sign_dict

    payload = record.to_dict()
    signature = sign_dict(private_key, payload)

    return {
        "payload": payload,
        "signature": signature,
        "algorithm": "ed25519",
    }


def verify_signed_audit(
    signed_payload: Dict[str, Any],
    public_key
) -> bool:
    from common.signing import verify_dict

    payload = signed_payload["payload"]
    signature = signed_payload["signature"]

    return verify_dict(public_key, payload, signature)


# ==================================================
# Upload Idempotency Helpers
# ==================================================

def build_upload_exists_query(
    release_id: str,
    table_name: str = "upload_audit"
) -> str:
    """
    Returns SQL that checks if a release_id already exists
    in the upload_audit table.
    """

    def esc(v):
        return "'" + str(v).replace("'", "''") + "'"

    return f"""
    SELECT COUNT(*) AS upload_count
    FROM {table_name}
    WHERE release_id = {esc(release_id)};
    """


def build_upload_exists_sql(
    release_id: str,
    table_name: str = "upload_audit"
) -> str:
    """
    Returns SQL that raises error if release already uploaded.
    Uses SQLite-compatible conditional logic.
    """

    def esc(v):
        return "'" + str(v).replace("'", "''") + "'"

    return f"""
    SELECT
        CASE
            WHEN EXISTS (
                SELECT 1 FROM {table_name}
                WHERE release_id = {esc(release_id)}
            )
            THEN RAISE(ABORT, 'Release already uploaded')
        END;
    """
