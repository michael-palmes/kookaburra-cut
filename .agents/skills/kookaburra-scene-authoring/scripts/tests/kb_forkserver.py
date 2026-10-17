"""A fork server for kb's tests: kb.py's start-up runs once, then every request forks a fresh kb process.

Each child takes the request's stdin/stdout/stderr, cwd, environment and argv, runs kb's main() and exits through the
interpreter, as `python3 -I -B kb.py ARGS` would, minus the interpreter start-up. helpers.ForkServer is the client.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
from typing import Any, Callable, Dict, List, Optional

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB = os.path.join(SCRIPTS, "kb.py")

# The same start-up as kb.py.
sys.dont_write_bytecode = True
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != SCRIPTS] + [SCRIPTS]


def send(sock: socket.socket, obj: Dict[str, Any]) -> None:
    data = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack(">I", len(data)) + data)


def recv_exact(sock: socket.socket, n: int) -> Optional[bytes]:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def recv(sock: socket.socket) -> Optional[Dict[str, Any]]:
    head = recv_exact(sock, 4)
    body = recv_exact(sock, struct.unpack(">I", head)[0]) if head else None
    return json.loads(body.decode("utf-8")) if body is not None else None


def become(fds: List[int], req: Dict[str, Any]) -> None:
    for target, fd in enumerate(fds):
        os.dup2(fd, target)
    for fd in set(fds):
        if fd > 2:
            os.close(fd)
    os.chdir(req["cwd"])
    os.environ.clear()
    os.environ.update(req["env"])
    sys.argv = [KB] + list(req["argv"])


def serve(sock: socket.socket, main: Callable[[], int]) -> None:
    while True:
        try:
            marker, fds, _flags, _addr = socket.recv_fds(sock, 1, 3)
        except OSError:
            return
        req = recv(sock) if marker else None
        if req is None or len(fds) != 3:
            return
        pid = os.fork()
        if pid == 0:
            sock.close()
            become(fds, req)
            sys.exit(main())
        for fd in fds:
            os.close(fd)
        send(sock, {"pid": pid})
        _, status = os.waitpid(pid, 0)
        send(sock, {"returncode": os.waitstatus_to_exitcode(status)})


if __name__ == "__main__":
    control = socket.socket(fileno=int(sys.argv[1]))
    try:
        from kblib.cli import main
    except Exception as e:
        send(control, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(2)
    send(control, {"ok": True})
    serve(control, main)
