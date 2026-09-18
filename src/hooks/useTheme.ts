// Theme hook (design-system-v2.md §5/§6)
// Manual light/dark only — no system-follow. Persists to Tauri setting
// with a localStorage fallback. Applies a 200ms transition on toggle.
import { useCallback, useEffect, useState } from "react";
import * as tauri from "../services/tauri";

export type Theme = "light" | "dark";
const THEME_KEY = "agent.theme";

function readInitial(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* ignore */
  }
  return "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitial);

  // Load persisted preference from Tauri (fallback to localStorage already applied)
  useEffect(() => {
    tauri
      .getSetting("theme")
      .then((t) => {
        if (t === "dark" || t === "light") setThemeState(t as Theme);
      })
      .catch(() => {});
  }, []);

  // Apply to <html>
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback(
    (next: Theme) => {
      // Enable transition only for the duration of the switch (200ms)
      const root = document.documentElement;
      root.setAttribute("data-theme-transition", "");
      setThemeState(next);
      try {
        void tauri.setSetting("theme", next);
      } catch {
        /* non-fatal */
      }
      window.setTimeout(() => root.removeAttribute("data-theme-transition"), 220);
    },
    []
  );

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, setTheme, toggleTheme };
}
