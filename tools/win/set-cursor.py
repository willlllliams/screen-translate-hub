"""Move the mouse pointer (desktop-session testing of window_under_cursor).

    tools/win/run-in-desktop.ps1 -Command ".venv\\Scripts\\python.exe tools\\win\\set-cursor.py 1000 450"
"""

import ctypes
import ctypes.wintypes
import sys

user32 = ctypes.windll.user32
x, y = int(sys.argv[1]), int(sys.argv[2])
ok = user32.SetCursorPos(x, y)
pt = ctypes.wintypes.POINT()
user32.GetCursorPos(ctypes.byref(pt))
print("SetCursorPos", bool(ok), "error", ctypes.GetLastError(), "now", pt.x, pt.y)
