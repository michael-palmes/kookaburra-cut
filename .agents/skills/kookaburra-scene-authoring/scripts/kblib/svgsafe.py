"""An SVG from outside is a program, not a picture: AppKit's parser will read a `file://` image straight off the disk into
the raster. So it never sees the file. The source is parsed with expat and rewritten from an allowlist of drawing
elements, with no script, no DOCTYPE and no reference that leaves the document; the rasteriser only ever gets that copy.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from xml.parsers import expat
from xml.sax.saxutils import escape, quoteattr

from .imagefile import Refused

MAX_BYTES = 16 * 1024 ** 2
MAX_EXPANDED = 64 * 1024 ** 2
MAX_ELEMENTS = 200_000
MAX_DEPTH = 256
MAX_ENTITIES = 64
MAX_ENTITY_VALUE = 4096
RASTER_TIMEOUT_S = 120
BATCH = 80
DEFAULT_EDGE = 2048
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"
SEP = " "

ELEMENTS = frozenset("""
    svg g defs symbol use a switch title desc path rect circle ellipse line polyline polygon text tspan textPath
    linearGradient radialGradient stop clipPath mask pattern marker image style filter
    feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap
    feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode
    feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence
""".split())
QUIET_ELEMENTS = frozenset(("metadata", "view"))
TEXT_ELEMENTS = frozenset(("text", "tspan", "textPath", "title", "desc", "style"))
RASTER_DATA = re.compile(r"^\s*data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]*$", re.IGNORECASE)
EXTERNAL_URL = re.compile(r"url\(\s*['\"]?\s*(?!#)", re.IGNORECASE)
LIVE_VALUE = re.compile(r"javascript:|vbscript:|expression\(", re.IGNORECASE)
LIVE_STYLE = re.compile(r"@import|@font-face|@charset|@namespace|image-set\(|-webkit-image-set\(|behavior\s*:|-moz-binding", re.IGNORECASE)
PERCENT = re.compile(r"%\s*$")


class _Stop(Exception):
    pass


class _Sanitiser:
    def __init__(self, name: str) -> None:
        self.name = name
        self.out: List[str] = []
        self.dropped: Dict[str, int] = {}
        self.depth = 0
        self.skip_depth = 0
        self.elements = 0
        self.expanded = 0
        self.entities = 0
        self.saw_root = False
        self.stack: List[str] = []
        self.style_at: Optional[int] = None

    def refuse(self, why: str) -> Refused:
        return Refused("unreadable", f"{self.name} is not a safe SVG: {why}", "export it again as a plain SVG, or as a PNG")

    def drop(self, what: str) -> None:
        self.dropped[what] = self.dropped.get(what, 0) + 1

    def count(self, n: int) -> None:
        self.expanded += n
        if self.expanded > MAX_EXPANDED:
            raise self.refuse("it expands past the size an SVG may be")

    def entity(self, name: str, is_parameter: int, value: Optional[str], _base: Optional[str], system_id: Optional[str], public_id: Optional[str], notation: Optional[str]) -> None:
        self.entities += 1
        if is_parameter or system_id or public_id or notation or value is None:
            raise self.refuse(f"its DTD reaches outside the file (entity {name})")
        if "&" in value or len(value) > MAX_ENTITY_VALUE or self.entities > MAX_ENTITIES:
            raise self.refuse("its DTD builds nested or oversized entities")

    def start(self, tag: str, attrs: Dict[str, str]) -> None:
        self.elements += 1
        self.depth += 1
        if self.elements > MAX_ELEMENTS or self.depth > MAX_DEPTH:
            raise self.refuse("it is too large or too deeply nested")
        self.count(sum(len(k) + len(v) for k, v in attrs.items()) + len(tag))
        ns, _, local = tag.rpartition(SEP)
        if not self.saw_root:
            self.saw_root = True
            if local != "svg" or ns not in ("", SVG_NS):
                raise self.refuse(f"its root is <{local}>, not <svg>")
        if self.skip_depth:
            self.skip_depth += 1
            return
        if ns not in ("", SVG_NS) or local not in ELEMENTS:
            if ns in ("", SVG_NS) and local not in QUIET_ELEMENTS:
                self.drop(local)
            self.skip_depth = 1
            return
        kept = self.attributes(local, attrs)
        if local == "image" and "xlink:href" not in kept:
            self.drop("image")
            self.skip_depth = 1
            return
        if local == "svg" and not self.stack:
            kept["xmlns"] = SVG_NS
            kept["xmlns:xlink"] = XLINK_NS
            if "viewBox" in kept:
                for side in ("width", "height"):
                    if PERCENT.search(kept.get(side, "")):
                        del kept[side]
        if local == "style":
            self.style_at = len(self.out)
        self.out.append("<" + local + "".join(f" {k}={quoteattr(v)}" for k, v in kept.items()) + ">")
        self.stack.append(local)

    def attributes(self, element: str, attrs: Dict[str, str]) -> Dict[str, str]:
        kept: Dict[str, str] = {}
        for raw, value in attrs.items():
            ns, _, local = raw.rpartition(SEP)
            if ns == XML_NS:
                if local == "space":
                    kept["xml:space"] = value
                else:
                    self.drop(f"xml:{local}")
                continue
            if ns not in ("", SVG_NS, XLINK_NS):
                continue
            if local.lower().startswith("on") or local.lower() in ("src", "base", "style-src"):
                self.drop(f"{local} attribute")
                continue
            if local == "href":
                target = value.strip()
                if target.startswith("#") or (element in ("image", "feImage") and RASTER_DATA.match(target)):
                    kept["xlink:href"] = value
                else:
                    self.drop("external href")
                continue
            if EXTERNAL_URL.search(value) or LIVE_VALUE.search(value) or LIVE_STYLE.search(value):
                self.drop(f"{local} attribute")
                continue
            if ns == "":
                kept[local] = value
        return kept

    def end(self, tag: str) -> None:
        self.depth -= 1
        if self.skip_depth:
            self.skip_depth -= 1
            return
        local = self.stack.pop()
        if local == "style" and self.style_at is not None:
            text = "".join(self.out[self.style_at + 1:])
            if EXTERNAL_URL.search(text) or LIVE_STYLE.search(text) or LIVE_VALUE.search(text):
                del self.out[self.style_at:]
                self.drop("style sheet")
                self.style_at = None
                return
            self.style_at = None
        self.out.append(f"</{local}>")

    def text(self, data: str) -> None:
        self.count(len(data))
        if not self.skip_depth and self.stack and self.stack[-1] in TEXT_ELEMENTS:
            self.out.append(escape(data))


def sanitise(data: bytes, name: str = "the SVG") -> Tuple[bytes, Dict[str, int]]:
    """A copy with nothing live in it, and what was dropped (name to count). Malformed XML, a DTD that reaches out or builds
    entity bombs, and a root that isn't <svg> are refused."""
    if len(data) > MAX_BYTES:
        raise Refused("too-large", f"{name} is {len(data) // 1024 ** 2} MB, over the {MAX_BYTES // 1024 ** 2} MB an SVG may be", "export it again without embedded images")
    sane = _Sanitiser(name)
    parser = expat.ParserCreate(namespace_separator=SEP)
    parser.buffer_text = True
    parser.ordered_attributes = False
    parser.StartElementHandler = sane.start
    parser.EndElementHandler = sane.end
    parser.CharacterDataHandler = sane.text
    parser.EntityDeclHandler = sane.entity

    def external(*_args: object) -> int:
        raise sane.refuse("it reads an external entity")

    parser.ExternalEntityRefHandler = external
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    try:
        parser.Parse(data, True)
    except expat.ExpatError as e:
        raise sane.refuse(f"it isn't well-formed XML ({expat.errors.messages.get(e.code, 'parse error')}, line {e.lineno})") from None
    except (RecursionError, MemoryError):
        raise sane.refuse("it is too large or too deeply nested") from None
    if not sane.saw_root:
        raise sane.refuse("it has no <svg> element")
    return "".join(sane.out).encode("utf-8"), sane.dropped


def dropped_note(name: str, dropped: Dict[str, int]) -> Optional[str]:
    if not dropped:
        return None
    what = ", ".join(sorted(dropped)[:6]) + (" and more" if len(dropped) > 6 else "")
    return f"{name}: left out what could reach outside the file or isn't drawing ({what}); look at the result"


def rasteriser() -> Path:
    """The brand skill's svg2png.js, stamped beside this skill."""
    return Path(__file__).resolve().parents[3] / "kookaburra-brand-packs" / "scripts" / "svg2png.js"


def rasterise(jobs: List[Tuple[Path, Path]], edge: int) -> None:
    """Each (sanitised svg, png) at `edge` px on the long side, in one osascript per batch. A file that didn't rasterise
    simply has no output: the caller checks. Refused (no-decoder) when osascript or the script is missing."""
    script = rasteriser()
    if not script.is_file():
        raise Refused("no-decoder", f"the SVG rasteriser is missing ({script.name} from the kookaburra-brand-packs skill)", "open the project in the app once so it stamps its skills")
    for start in range(0, len(jobs), BATCH):
        batch = jobs[start:start + BATCH]
        argv = ["/usr/bin/osascript", "-l", "JavaScript", str(script), str(edge)]
        for svg, png in batch:
            argv += [str(svg), str(png)]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=RASTER_TIMEOUT_S, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise Refused("unreadable", f"rasterising took longer than {RASTER_TIMEOUT_S} s, so it was stopped", "export the SVG again as a PNG") from None
        except OSError as e:
            raise Refused("no-decoder", f"SVGs rasterise through macOS's osascript, which could not run: {e.strerror}", "run this on the Mac the app is installed on") from None
        if proc.returncode != 0 and not any(png.is_file() for _svg, png in batch):
            tail = proc.stderr.strip().splitlines()[-1][-160:] if proc.stderr.strip() else f"exit {proc.returncode}"
            raise Refused("no-decoder", f"the SVG rasteriser failed: {tail}")
