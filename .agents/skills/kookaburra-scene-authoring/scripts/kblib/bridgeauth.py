"""Bridge signing, the mirror of the app's `bridge_auth.rs` (docs/agent-kit.md, "Signing")."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional

from .util import EXIT_ENV, KbError, bridge_dir

AUTH_VERSION = 1
ZERO_MAC = "0" * 64
TAIL = '"}}'
MAC_RE = re.compile(r"^[0-9a-f]{64}$")
KEY_RE = re.compile(r"^[0-9a-f]{64}$")


def mac(key: bytes, data: bytes) -> str:
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def sign_text(key: bytes, object_text: str, extra: Optional[str] = None) -> str:
    """Append `"auth":{"v":1,<extra>,"mac":"<zeros>"}` to a JSON object's text, then fill the mac in (as the app does)."""
    body = object_text.rstrip()
    if not body.endswith("}"):
        raise ValueError("only a JSON object can be signed")
    body = body[:-1].rstrip()
    sep = "" if body.strip() == "{" else ","
    more = f"{extra}," if extra else ""
    signed = f'{body}{sep}"auth":{{"v":{AUTH_VERSION},{more}"mac":"{ZERO_MAC}{TAIL}'
    data = signed.encode("utf-8")
    digest = mac(key, data).encode("ascii")
    at = len(data) - len(TAIL) - 64
    return (data[:at] + digest + data[at + 64:]).decode("utf-8")


def sign_payload(key: bytes, payload: Dict[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "auth"}
    return sign_text(key, json.dumps(body, ensure_ascii=False))


def bad(reason: str) -> KbError:
    return KbError(
        f"kb refused the app's answer: {reason}. Something other than Kookaburra Cut may have written it",
        EXIT_ENV,
        kind="bad-signature",
        hint="rerun once; if it happens again, ask the person to restart Kookaburra Cut and check what else runs on this Mac",
    )


def check_mac(key: bytes, data: bytes) -> Dict[str, Any]:
    """The answer, parsed, when its mac is right under `key`; raises `bad-signature` otherwise."""
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise bad("it is not JSON") from None
    if not isinstance(value, dict):
        raise bad("it is not a JSON object")
    auth = value.get("auth")
    if not isinstance(auth, dict):
        raise bad("it is unsigned")
    if auth.get("v") != AUTH_VERSION or isinstance(auth.get("v"), bool):
        raise bad("its signature version is unknown")
    digits = auth.get("mac")
    if not isinstance(digits, str) or not MAC_RE.match(digits):
        raise bad("its signature is malformed")
    needle = digits.encode("ascii")
    if data.count(needle) != 1:
        raise bad("its signature appears more than once")
    at = data.index(needle)
    zeroed = data[:at] + ZERO_MAC.encode("ascii") + data[at + 64:]
    if not hmac.compare_digest(mac(key, zeroed), digits):
        raise bad("its signature is wrong")
    return value


def _strings(value: Any, out: List[str]) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, list):
        for v in value:
            _strings(v, out)
    elif isinstance(value, dict):
        for v in value.values():
            _strings(v, out)


def file_sha256(path: str) -> Optional[str]:
    """The file's SHA-256, never through a link; None when it is not a readable regular file."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return h.hexdigest()
            h.update(chunk)
    finally:
        os.close(fd)


def named_pngs(resp: Dict[str, Any], responses: Path) -> List[str]:
    """Every string in the answer naming a `.png` directly inside the bridge's responses folder (the app's rule)."""
    from .bridge import same_dir

    found: List[str] = []
    _strings({k: v for k, v in resp.items() if k != "auth"}, found)
    return [s for s in found if s.endswith(".png") and same_dir(os.path.dirname(s), responses)]


# Each verified frame's signed SHA-256 by its path, so a copy kb makes later is checked too.
SIGNED_PNGS: Dict[str, str] = {}


def check_pngs(resp: Dict[str, Any], responses: Path) -> None:
    """Each PNG the answer names must match the SHA-256 the app signed for it."""
    files = resp["auth"].get("files")
    files = files if isinstance(files, dict) else {}
    for path in named_pngs(resp, responses):
        signed = files.get(os.path.basename(path))
        if not isinstance(signed, str) or not hmac.compare_digest(file_sha256(path) or "", signed):
            raise bad(f"{os.path.basename(path)} is not the frame the app wrote")
        SIGNED_PNGS[path] = signed


def copy_matches(original: str, copy: Path) -> bool:
    """A copy kb made of a signed frame still holds the bytes the app signed; True for a frame that was never signed."""
    signed = SIGNED_PNGS.get(original)
    return signed is None or hmac.compare_digest(file_sha256(str(copy)) or "", signed)


def verify_answer(data: bytes, key: bytes) -> Dict[str, Any]:
    resp = check_mac(key, data)
    check_pngs(resp, bridge_dir() / "responses")
    return resp


def read_key(pid: int) -> bytes:
    """The serving instance's key: a 0600 regular file of 64 hex digits owned by this user, never read through a link."""
    path = bridge_dir() / "keys" / f"{pid}.key"
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        raise KbError(f"kb couldn't read Kookaburra Cut's bridge key ({e.strerror or e}), so it sent nothing", EXIT_ENV,
                      kind="bad-signature", hint="ask the person to restart Kookaburra Cut, then rerun") from None
    try:
        st = os.fstat(fd)
        text = os.read(fd, 256).decode("ascii", "replace").strip()
    finally:
        os.close(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or not KEY_RE.match(text):
        raise KbError("Kookaburra Cut's bridge key is not a private key file this user owns, so kb sent nothing", EXIT_ENV,
                      kind="bad-signature", hint="ask the person to restart Kookaburra Cut, then rerun")
    return bytes.fromhex(text)


def read_answer(path: Path, key: Optional[bytes]) -> Optional[Dict[str, Any]]:
    """An answer file, verified when the instance signs; None while it is missing or half written."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if key is None:
        try:
            value = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None
        return value if isinstance(value, dict) else None
    return verify_answer(data, key)
