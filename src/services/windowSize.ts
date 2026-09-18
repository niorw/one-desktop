// Persist and restore the main window size across sessions.
// Mirrors the project's existing localStorage-backed UI state (sidebar.width / collapsed).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";

const STORAGE_KEY = "window.size.v1";
const MIN_W = 800;
const MIN_H = 500;
const MAX = 4096;

interface SavedSize {
  w: number;
  h: number;
  maximized: boolean;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(v)));

/** Apply the last saved size (or maximized state) when the app starts. */
export async function restoreWindowSize(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    let saved: SavedSize;
    try {
      saved = JSON.parse(raw) as SavedSize;
    } catch {
      return;
    }

    if (saved.maximized) {
      await win.maximize();
      return;
    }

    await win.setSize(
      new PhysicalSize(
        clamp(saved.w, MIN_W, MAX),
        clamp(saved.h, MIN_H, MAX)
      )
    );
  } catch (err) {
    // Non-Tauri env (plain vite dev) or runtime error — fail silently.
    console.warn("[windowSize] restore failed:", err);
  }
}

/** Listen for resize and debounce-persist the outer size / maximized state. */
export async function trackWindowSize(): Promise<void> {
  try {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;

    await win.onResized(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          if (await win.isMaximized()) {
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({ maximized: true, w: 0, h: 0 })
            );
            return;
          }
          const size = await win.outerSize();
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              maximized: false,
              w: size.width,
              h: size.height,
            })
          );
        } catch (err) {
          console.warn("[windowSize] track write failed:", err);
        }
      }, 500);
    });
  } catch (err) {
    console.warn("[windowSize] track failed:", err);
  }
}
