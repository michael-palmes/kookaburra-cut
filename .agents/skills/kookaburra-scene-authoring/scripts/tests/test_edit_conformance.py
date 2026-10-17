from __future__ import annotations

import json
import re
import unittest
from typing import Any, List

from kblib.video import editmath as em
from kblib.video.editops import OpError, apply_op

from .helpers import FIXTURES

VECTORS = FIXTURES / "edit-vectors.json"


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def same(a: Any, b: Any, path: str = "") -> List[str]:
    """Structural equality as JSON sees it (1 == 1.0), but a bool never equals a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return [] if type(a) is type(b) and a == b else [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return [] if a == b else [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, dict) and isinstance(b, dict):
        out: List[str] = []
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'got' if k in a else 'want'}")
            else:
                out.extend(same(a[k], b[k], f"{path}.{k}"))
        return out
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} != {len(b)}"]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(same(x, y, f"{path}[{i}]"))
        return out
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


def plain(value: Any) -> Any:
    return json.loads(json.dumps(value))


@unittest.skipUnless(VECTORS.is_file(), "fixtures/edit-vectors.json is missing (pnpm agent:vectors writes it)")
class EditConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_constants(self) -> None:
        for name, value in self.vectors.get("constants", {}).items():
            self.assertEqual(getattr(em, name), value, name)

    def test_every_editmath_and_editmasks_function(self) -> None:
        problems: List[str] = []
        for i, v in enumerate(self.vectors["fns"]):
            fn = getattr(em, snake(v["fn"]), None)
            if fn is None:
                problems.append(f"fns[{i}] {v['fn']}: no editmath.{snake(v['fn'])}")
                continue
            got = plain(fn(*json.loads(json.dumps(v["args"]))))
            if v["fn"] == "outputToSource" and isinstance(got, dict):
                got.pop("clip", None)
            diff = same(got, v["out"])
            if diff:
                problems.append(f"fns[{i}] {v['fn']}{json.dumps(v['args'])[:160]}: {'; '.join(diff[:3])}")
        self.assertEqual(problems, [], "\n".join(problems[:20]))

    def test_every_op_sequence(self) -> None:
        problems: List[str] = []
        for v in self.vectors["ops"]:
            doc = json.loads(json.dumps(v["doc"]))
            for j, step in enumerate(v["steps"]):
                before = json.dumps(doc, sort_keys=True)
                try:
                    res = apply_op(doc, json.loads(json.dumps(step["op"])))
                except OpError as e:
                    if step["ok"]:
                        problems.append(f"{v['id']} step {j} {step['op'].get('op')}: failed with {e.code} ({e.message})")
                    elif e.code != step.get("code"):
                        problems.append(f"{v['id']} step {j} {step['op'].get('op')}: code {e.code} != {step.get('code')}")
                    continue
                finally:
                    if json.dumps(doc, sort_keys=True) != before:
                        problems.append(f"{v['id']} step {j}: the op mutated its input")
                if not step["ok"]:
                    problems.append(f"{v['id']} step {j} {step['op'].get('op')}: succeeded, expected {step.get('code')}")
                    continue
                doc = plain(res.doc)
            diff = same(doc, v["final"])
            if diff:
                problems.append(f"{v['id']} final: {'; '.join(diff[:4])}")
        self.assertEqual(problems, [], "\n".join(problems[:25]))


if __name__ == "__main__":
    unittest.main()
