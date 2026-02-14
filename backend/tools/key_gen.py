# ==================================================
# Key Generation Script (Ed25519) v0.0.1
# ==================================================
# Generates:
#   keys/dev/private.pem
#   keys/dev/public.pem
#   keys/prod/private.pem
#   keys/prod/public.pem
# ==================================================

import argparse
import hashlib
from pathlib import Path

from common.signing import (
    generate_keypair,
    export_private_key,
    export_public_key,
)

BASE_DIR = Path("keys")


# ==================================================
# Helpers
# ==================================================

def write_keypair(env: str, force: bool = False):
    env_dir = BASE_DIR / env
    env_dir.mkdir(parents=True, exist_ok=True)

    priv_path = env_dir / "private.pem"
    pub_path = env_dir / "public.pem"

    if not force and (priv_path.exists() or pub_path.exists()):
        raise RuntimeError(
            f"{env} keys already exist. Use --force to overwrite."
        )

    private_key, public_key = generate_keypair()

    priv_path.write_bytes(export_private_key(private_key))
    pub_path.write_bytes(export_public_key(public_key))

    # fingerprint for sanity checking
    fingerprint = hashlib.sha256(
        export_public_key(public_key)
    ).hexdigest()

    print(f"\n✔ {env.upper()} keys generated")
    print(f"  Private: {priv_path}")
    print(f"  Public:  {pub_path}")
    print(f"  Public Key SHA256: {fingerprint[:16]}...")


# ==================================================
# Entrypoint
# ==================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", choices=["dev", "prod", "both"], default="both")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.env in ("dev", "both"):
        write_keypair("dev", args.force)

    if args.env in ("prod", "both"):
        write_keypair("prod", args.force)

    print("\nAll requested keys generated.")
    print("Goodbye :P")


if __name__ == "__main__":
    main()
