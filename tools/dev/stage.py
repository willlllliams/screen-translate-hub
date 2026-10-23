"""A controllable test window for continuous mode on a real desktop.

Shows an English article; commands written to the control file change it:
    scroll N            scroll N lines (negative scrolls up)
    replace I TEXT      replace paragraph I (0-based) with TEXT
    focus               bring the window to the foreground
    move X Y            move the window
    quit

    python tools/dev/stage.py [x y w h] [--light]
    echo scroll 3 > %TEMP%\\sth-stage.cmd
"""

import os
import sys
import tkinter as tk
from pathlib import Path

CONTROL = Path(os.environ.get("TEMP", ".")) / "sth-stage.cmd"

PARAGRAPHS = [
    "Getting started",
    "This guide walks you through installing the tool, connecting it to your account and running your first job.",
    "Before you begin, make sure that your computer meets the minimum requirements and that you have a stable network connection.",
    "Installation",
    "Download the installer from the releases page and run it. The installer asks where to put the program files and whether to create a desktop shortcut.",
    "When the installation finishes, start the program from the start menu. The first start takes a little longer because the program prepares its local cache.",
    "Signing in",
    "Open the settings page and choose the account section. Enter the address of your server and press the connect button.",
    "If the server uses a self-signed certificate, the program shows its fingerprint. Compare it with the one your administrator gave you before you accept it.",
    "Running a job",
    "Select the files you want to process, pick a profile and press start. Progress is shown in the status bar at the bottom of the window.",
    "You can pause a running job at any time. Paused jobs keep their place in the queue and continue where they stopped.",
    "Troubleshooting",
    "Most problems come from an outdated configuration. Reset the configuration from the help menu and sign in again.",
    "If the program still does not start, collect the log files from the data folder and send them to the support team.",
    "Keyboard shortcuts",
    "Press F5 to refresh the file list, Ctrl+P to pause the current job and Ctrl+Q to quit the program.",
    "Release history",
    "Version two adds parallel jobs, a new profile editor and faster start-up on large folders.",
    "Version one was the first public release.",
]


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    light = "--light" in sys.argv
    x, y, w, h = (int(v) for v in args[:4]) if len(args) >= 4 else (575, 40, 785, 640)
    root = tk.Tk()
    root.title("sth-stage")
    root.geometry(f"{w}x{h}+{x}+{y}")
    bg, fg = ("#ffffff", "#1f1f1f") if light else ("#272727", "#f0f0f0")
    text = tk.Text(root, wrap="word", bg=bg, fg=fg, font=("Segoe UI", 12), padx=16, pady=12, borderwidth=0, spacing3=14)
    text.pack(fill="both", expand=True)
    paragraphs = list(PARAGRAPHS)

    def render() -> None:
        top = text.yview()[0]
        text.configure(state="normal")
        text.delete("1.0", "end")
        for p in paragraphs:
            text.insert("end", p + "\n", ("h",) if len(p) < 25 else ())
        text.tag_configure("h", font=("Segoe UI Semibold", 15))
        text.configure(state="disabled")
        text.yview_moveto(top)

    def poll() -> None:
        try:
            if CONTROL.exists():
                cmds = CONTROL.read_text(encoding="utf-8-sig").splitlines()
                CONTROL.unlink()
                for cmd in cmds:
                    parts = cmd.strip().split(" ", 2)
                    if parts[0] == "scroll":
                        text.yview_scroll(int(parts[1]), "units")
                    elif parts[0] == "replace":
                        paragraphs[int(parts[1])] = parts[2]
                        render()
                    elif parts[0] == "focus":
                        root.attributes("-topmost", True)
                        root.focus_force()
                        root.after(300, lambda: root.attributes("-topmost", False))
                    elif parts[0] == "move":
                        root.geometry(f"+{int(parts[1])}+{int(parts[2].split()[0])}")
                    elif parts[0] == "quit":
                        root.destroy()
                        return
        except Exception as e:  # keep the stage alive on a bad command
            print("stage:", e, file=sys.stderr)
        root.after(200, poll)

    render()
    # started from a scheduled task the window opens behind others; raise it once
    root.attributes("-topmost", True)
    root.after(800, lambda: root.attributes("-topmost", False))
    root.after(200, poll)
    root.mainloop()


if __name__ == "__main__":
    main()
