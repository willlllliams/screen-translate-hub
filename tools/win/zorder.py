"""Print the visible top-level windows in z-order (top first), for overlay debugging.

    tools/win/run-in-desktop.ps1 -Command ".venv\\Scripts\\python.exe tools\\win\\zorder.py 15"
"""

import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 15
rows = []


@ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
def visit(hwnd, _):
    if user32.IsWindowVisible(hwnd):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        ex = user32.GetWindowLongPtrW(hwnd, -20)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        rows.append(f"{hwnd:>10} {'T' if ex & 8 else ' '} {r.left},{r.top} {r.right - r.left}x{r.bottom - r.top} [{cls.value}] {buf.value}")
    return len(rows) < limit


user32.EnumWindows(visit, 0)
print("\n".join(rows))
