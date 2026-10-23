// Foreground window and user idle time for heartbeat samples (spec 17 section 3),
// through koffi on Windows; other systems report nothing until they get their own.
import { basename } from 'node:path';

export interface Foreground {
  hwnd: number;
  pid: number;
  app: string;
  title: string;
}

interface Win32 {
  foreground(): Foreground | null;
  idleMs(): number;
}

async function loadWin32(): Promise<Win32 | null> {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = (await import('koffi')).default;
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const LASTINPUTINFO = koffi.struct('A_LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
    const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
    const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16 *buf, int max)');
    const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)');
    const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ A_LASTINPUTINFO *info)');
    const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
    const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr h)');
    const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr h, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)');
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const exeNames = new Map<number, string>();

    const exeName = (pid: number): string => {
      const cached = exeNames.get(pid);
      if (cached !== undefined) return cached;
      let name = '';
      const h = Number(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
      if (h) {
        const buf = new Uint16Array(1024);
        const size = [buf.length];
        if (QueryFullProcessImageNameW(h, 0, buf, size)) name = basename(String.fromCharCode(...buf.subarray(0, size[0]))).replace(/\.exe$/i, '');
        CloseHandle(h);
      }
      exeNames.set(pid, name);
      return name;
    };

    return {
      foreground() {
        const hwnd = Number(GetForegroundWindow());
        if (!hwnd) return null;
        const buf = new Uint16Array(512);
        const n = GetWindowTextW(hwnd, buf, buf.length);
        const pid = [0];
        GetWindowThreadProcessId(hwnd, pid);
        return { hwnd, pid: pid[0], app: exeName(pid[0]), title: String.fromCharCode(...buf.subarray(0, n)) };
      },
      idleMs() {
        const info = { cbSize: 8, dwTime: 0 };
        if (!GetLastInputInfo(info)) return 0;
        return (Number(GetTickCount()) - info.dwTime) >>> 0;
      },
    };
  } catch {
    return null;
  }
}

let win32: Promise<Win32 | null> | null = null;

export async function foregroundWindow(): Promise<Foreground | null> {
  win32 ??= loadWin32();
  return (await win32)?.foreground() ?? null;
}

export async function userIdleMs(): Promise<number> {
  win32 ??= loadWin32();
  return (await win32)?.idleMs() ?? 0;
}
