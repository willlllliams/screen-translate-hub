"""Grab one frame of the primary display with Windows.Graphics.Capture (sees layered and DirectComposition windows).
Usage: python tools/win/wgc-grab.py out.png  (run inside the desktop session)"""
import sys
import threading

import numpy as np
from PIL import Image
from windows_capture import WindowsCapture

got = {}
ev = threading.Event()
cap = WindowsCapture(cursor_capture=False, draw_border=False, monitor_index=1)


@cap.event
def on_frame_arrived(frame, control):
    got["buf"] = np.array(frame.frame_buffer, copy=True)
    control.stop()
    ev.set()


@cap.event
def on_closed():
    ev.set()


cap.start_free_threaded()
ev.wait(10)
Image.fromarray(got["buf"][:, :, [2, 1, 0]]).save(sys.argv[1])
print("saved", sys.argv[1])
