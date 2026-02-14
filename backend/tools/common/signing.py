# ==================================================
# Cryptographic Signing Utilities (Ed25519)
#     - Supports key generation, signing, and verification
#     - Deterministic JSON canonicalization and hashing
#     - Hex-encoded signatures for easy storage/transmission
# ==================================================

# ↓ This Bitch needs to stay at the very top..... It annoys me seeing a from before an import, idk why
from __future__ import annotations

import json
import hashlib
from typing import Dict, Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature


# ==================================================
# Canonicalization + Hashing
# ==================================================

def canonical_json(data: Dict[str, Any]) -> bytes:
    """
    Deterministic JSON serialization.
    """
    return json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_digest(data: Dict[str, Any]) -> str:
    """
    Deterministic SHA256 digest of structured data.
    """
    return hashlib.sha256(
        canonical_json(data)
    ).hexdigest()


# ==================================================
# Key Management
# ==================================================

def generate_keypair() -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key


def export_private_key(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def export_public_key(public_key: Ed25519PublicKey) -> bytes:
    return public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def load_private_key(pem_bytes: bytes) -> Ed25519PrivateKey:
    return serialization.load_pem_private_key(
        pem_bytes,
        password=None,
    )


def load_public_key(pem_bytes: bytes) -> Ed25519PublicKey:
    return serialization.load_pem_public_key(
        pem_bytes
    )


# ==================================================
# Signing
# ==================================================

def sign_bytes(
    private_key: Ed25519PrivateKey,
    payload: bytes
) -> bytes:
    return private_key.sign(payload)


def sign_dict(
    private_key: Ed25519PrivateKey,
    data: Dict[str, Any]
) -> str:
    """
    Signs canonicalized JSON.
    Returns hex-encoded signature.
    """
    payload = canonical_json(data)
    signature = private_key.sign(payload)
    return signature.hex()


# ==================================================
# Verification
# ==================================================

def verify_bytes(
    public_key: Ed25519PublicKey,
    payload: bytes,
    signature: bytes,
) -> bool:
    try:
        public_key.verify(signature, payload)
        return True
    except InvalidSignature:
        return False


def verify_dict(
    public_key: Ed25519PublicKey,
    data: Dict[str, Any],
    signature_hex: str,
) -> bool:
    payload = canonical_json(data)
    signature = bytes.fromhex(signature_hex)

    try:
        public_key.verify(signature, payload)
        return True
    except InvalidSignature:
        return False


# ==================================================
# Manifest Signing Helpers
# ==================================================

def sign_manifest(
    manifest: Dict[str, Any],
    private_key: Ed25519PrivateKey
) -> Dict[str, Any]:
    """
    Adds signature metadata to manifest.
    Does NOT modify original dict.
    """

    manifest_copy = dict(manifest)

    signature = sign_dict(private_key, manifest_copy)

    manifest_copy["_signature"] = {
        "algorithm": "ed25519",
        "signature": signature,
    }

    return manifest_copy


def verify_manifest_signature(
    manifest: Dict[str, Any],
    public_key: Ed25519PublicKey
) -> bool:

    sig_block = manifest.get("_signature")
    if not sig_block:
        return False

    if sig_block.get("algorithm") != "ed25519":
        return False

    signature = sig_block.get("signature")
    if not signature:
        return False

    unsigned_manifest = dict(manifest)
    unsigned_manifest.pop("_signature", None)

    return verify_dict(
        public_key,
        unsigned_manifest,
        signature,
    )
