from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from kblib import bridge, bridgeauth, hookfast, reach
from kblib.util import KbError

from .helpers import FakeApp, KbTestCase, make_project

KEY = bytes(range(32))
PNG = b"\x89PNG\r\n\x1a\nframe"


class Hmac(KbTestCase):
    def test_hmac_matches_rfc_4231(self) -> None:
        cases = [
            (b"\x0b" * 20, b"Hi There", "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
            (b"Jefe", b"what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
            (b"\xaa" * 20, b"\xdd" * 50, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"),
            (bytes(range(1, 26)), b"\xcd" * 50, "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"),
            (b"\xaa" * 131, b"Test Using Larger Than Block-Size Key - Hash Key First",
             "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"),
            (b"\xaa" * 131, b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be "
             b"hashed before being used by the HMAC algorithm.", "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"),
        ]
        for key, data, expected in cases:
            self.assertEqual(bridgeauth.mac(key, data), expected)

    def test_kb_and_the_app_sign_the_same_bytes_alike(self) -> None:
        # bridge_auth.rs `kb_and_the_app_sign_the_same_bytes_alike` holds the same file.
        signed = bridgeauth.sign_text(KEY, '{"version": 2, "id": "0001-1-a", "at": 1.5}')
        self.assertEqual(signed, '{"version": 2, "id": "0001-1-a", "at": 1.5,"auth":{"v":1,'
                                 '"mac":"13279f23bf504534f17a4b126c112e026939b973bdca4e6c503495cca35dca7d"}}')
        self.assertEqual(bridgeauth.check_mac(KEY, signed.encode())["at"], 1.5)

    def test_a_mac_covers_every_byte(self) -> None:
        signed = bridgeauth.sign_payload(KEY, {"id": "a", "at": 1, "auth": "planted"}).encode()
        self.assertEqual(bridgeauth.check_mac(KEY, signed)["id"], "a")
        for bad in (signed.replace(b'"at": 1', b'"at": 2'), signed.replace(b"{", b"{ ", 1), b'{"id": "a"}', b"{",
                    signed.replace(b'"v":1', b'"v":2')):
            with self.assertRaises(KbError) as e:
                bridgeauth.check_mac(KEY, bad)
            self.assertEqual(e.exception.kind, "bad-signature")
        with self.assertRaises(KbError):
            bridgeauth.check_mac(bytes(32), signed)


class SignedBridge(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.responses = self.bridge / "responses"

    def frame(self, req: Dict[str, Any]) -> Dict[str, Any]:
        self.responses.mkdir(parents=True, exist_ok=True)
        png = self.responses / f"{req['id']}.png"
        png.write_bytes(PNG)
        return {"ok": True, "path": str(png), "paths": [str(png)], "project": req["project"], "surface": "render-window",
                "frames": [{"scene": "02-hero", "at": 0.5, "tMs": 500, "path": str(png), "index": 1}]}

    def test_a_signing_app_gets_signed_requests_and_kb_checks_its_answer_and_frames(self) -> None:
        with FakeApp(self.bridge, self.frame, key=KEY) as app:
            proc = self.kb(["capture", "--scene", "1", "--at", "0.5"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual((len(app.requests), app.refused), (1, []))
        self.assertIsInstance(app.requests[0]["deadlineAtMs"], int)
        captured = list((self.root / ".kb" / "captures").rglob("*.png"))
        self.assertTrue(captured and all(p.read_bytes() == PNG for p in captured))
        self.assertNotIn('"auth"', proc.stdout)

    def test_a_tampered_or_unsigned_answer_is_refused(self) -> None:
        def tamper(path: Path) -> None:
            path.write_text(path.read_text().replace('"surface": "render-window"', '"surface": "editor"'))

        def unsign(path: Path) -> None:
            body = json.loads(path.read_text())
            body.pop("auth")
            path.write_text(json.dumps(body))

        for change in (tamper, unsign):
            with FakeApp(self.bridge, self.frame, key=KEY, tamper=change):
                proc = self.kb(["capture", "--scene", "1"], cwd=self.root)
            self.assertExit(proc, 2)
            self.assertIn("kb refused the app's answer", proc.stderr)

    def test_a_swapped_frame_is_refused(self) -> None:
        def swap(path: Path) -> None:
            (self.responses / f"{path.name.split('.')[0]}.png").write_bytes(b"\x89PNG\r\n\x1a\nother")

        with FakeApp(self.bridge, self.frame, key=KEY, tamper=swap):
            proc = self.kb(["capture", "--scene", "1"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("is not the frame the app wrote", proc.stderr)
        self.assertFalse(list((self.root / ".kb").rglob("*.png")) if (self.root / ".kb").exists() else [])

    def test_a_heartbeat_without_auth_cant_switch_signing_off_while_its_key_is_there(self) -> None:
        def unsign(path: Path) -> None:
            body = json.loads(path.read_text())
            body.pop("auth")
            path.write_text(json.dumps(body))

        with FakeApp(self.bridge, self.frame, key=KEY, tamper=unsign, auth=None) as app:
            proc = self.kb(["capture", "--scene", "1"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertEqual(app.refused, [], "the request was still signed")

    def test_an_older_app_gets_unsigned_requests_as_before(self) -> None:
        with FakeApp(self.bridge, self.frame) as app:
            proc = self.kb(["capture", "--scene", "1"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertNotIn("auth", app.requests[0])

    def test_a_key_that_is_not_private_is_never_used(self) -> None:
        with FakeApp(self.bridge, self.frame, key=KEY) as app:
            os.chmod(self.bridge / "keys" / f"{app.pid}.key", 0o644)
            proc = self.kb(["capture", "--scene", "1"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("not a private key file", proc.stderr)
        self.assertEqual(app.requests, [])

    def test_the_agent_never_reaches_the_keys(self) -> None:
        keys = self.bridge / "keys"
        keys.mkdir(parents=True)
        (keys / "1.key").write_text("00" * 32)
        with self.assertRaises(KbError):
            reach.guard_read_at(self.root, str(keys / "1.key"))
        with self.assertRaises(KbError):
            reach.guard_write(_Project(self.root), str(keys / "out.png"))
        for command in ('cat ~/Kookaburra\\ Cut/_bridge/keys/1.key', 'cat "$HOME/Kookaburra Cut/_bridge/"k"eys"/*',
                        "xxd _bridge//./keys/1.key", "cp _bridge/k*/1.key /tmp"):
            self.assertTrue(hookfast.names_bridge_keys(command), command)
        for command in ("./kb capture --scene 1", "ls ~/Kookaburra\\ Cut/_bridge/responses"):
            self.assertFalse(hookfast.names_bridge_keys(command), command)
        payload = {"cwd": str(self.root), "tool_name": "Bash", "tool_input": {"command": f"cat {keys}/1.key"}}
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root)
        try:
            code, out, _ = hookfast.bash_pre(payload)
        finally:
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")


class _Project:
    def __init__(self, root: Path) -> None:
        self.root = root
