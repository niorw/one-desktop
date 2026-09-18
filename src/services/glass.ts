// Glass effect controller (UI Designer task: make frosted glass adjustable, not hardcoded).
// All glass tokens are driven by CSS custom properties on <html>, set at runtime
// from a persisted per-user level. Components reference var(--glass-*) only — never
// literal rgba — so the intensity is tunable from Settings → 个性化 without touching CSS.
import * as tauri from "./tauri";

export type GlassLevel = "off" | "subtle" | "medium" | "strong";

export const GLASS_LEVELS: GlassLevel[] = ["off", "subtle", "medium", "strong"];

export const DEFAULT_GLASS_LEVEL: GlassLevel = "medium";

const GLASS_KEY = "glass_effect";

// Per-level values for every glass token (light + dark + chrome + content + blur + shadow).
// "off" disables blur (var = none) and uses a near-opaque surface so the UI reads solid.
type GlassVars = Record<string, string>;

const GLASS_VARS: Record<GlassLevel, GlassVars> = {
  off: {
    "--glass-surface": "rgba(255,255,255,0.96)",
    "--glass-surface-dark": "rgba(28,28,30,0.96)",
    "--glass-border": "rgba(0,0,0,0.08)",
    "--glass-border-dark": "rgba(255,255,255,0.10)",
    "--glass-shadow": "0 1px 3px rgba(0,0,0,0.06)",
    "--glass-shadow-dark": "0 1px 3px rgba(0,0,0,0.4)",
    "--glass-blur": "none",
    "--glass-blur-sm": "none",
    "--glass-bg": "rgba(245,245,247,0.96)",
    "--glass-bg-dark": "rgba(28,28,30,0.96)",
  },
  subtle: {
    "--glass-surface": "rgba(255,255,255,0.55)",
    "--glass-surface-dark": "rgba(42,42,46,0.5)",
    "--glass-border": "rgba(255,255,255,0.4)",
    "--glass-border-dark": "rgba(255,255,255,0.10)",
    "--glass-shadow": "0 4px 16px rgba(0,0,0,0.06)",
    "--glass-shadow-dark": "0 4px 16px rgba(0,0,0,0.45)",
    "--glass-blur": "saturate(150%) blur(16px)",
    "--glass-blur-sm": "saturate(140%) blur(10px)",
    "--glass-bg": "rgba(245,245,247,0.5)",
    "--glass-bg-dark": "rgba(28,28,30,0.5)",
  },
  medium: {
    "--glass-surface": "rgba(255,255,255,0.72)",
    "--glass-surface-dark": "rgba(42,42,46,0.68)",
    "--glass-border": "rgba(255,255,255,0.55)",
    "--glass-border-dark": "rgba(255,255,255,0.12)",
    "--glass-shadow": "0 8px 30px rgba(0,0,0,0.08)",
    "--glass-shadow-dark": "0 8px 30px rgba(0,0,0,0.5)",
    "--glass-blur": "saturate(180%) blur(40px)",
    "--glass-blur-sm": "saturate(160%) blur(20px)",
    "--glass-bg": "rgba(245,245,247,0.62)",
    "--glass-bg-dark": "rgba(28,28,30,0.62)",
  },
  strong: {
    "--glass-surface": "rgba(255,255,255,0.45)",
    "--glass-surface-dark": "rgba(42,42,46,0.42)",
    "--glass-border": "rgba(255,255,255,0.6)",
    "--glass-border-dark": "rgba(255,255,255,0.15)",
    "--glass-shadow": "0 10px 40px rgba(0,0,0,0.10)",
    "--glass-shadow-dark": "0 10px 40px rgba(0,0,0,0.55)",
    "--glass-blur": "saturate(200%) blur(60px)",
    "--glass-blur-sm": "saturate(180%) blur(30px)",
    "--glass-bg": "rgba(245,245,247,0.42)",
    "--glass-bg-dark": "rgba(28,28,30,0.42)",
  },
};

// Apply a glass level by writing the CSS variables onto <html>.
// Inline style wins over the :root defaults, so the persisted choice always takes effect.
export function applyGlassEffect(level: GlassLevel): void {
  const vars = GLASS_VARS[level] ?? GLASS_VARS[DEFAULT_GLASS_LEVEL];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  root.setAttribute("data-glass", level);
}

export async function loadGlassLevel(): Promise<GlassLevel> {
  try {
    const raw = await tauri.getSetting(GLASS_KEY);
    if ((GLASS_LEVELS as string[]).includes(raw)) return raw as GlassLevel;
  } catch {
    /* non-fatal: fall back to default */
  }
  return DEFAULT_GLASS_LEVEL;
}

export async function saveGlassLevel(level: GlassLevel): Promise<void> {
  try {
    await tauri.setSetting(GLASS_KEY, level);
  } catch {
    /* non-fatal */
  }
}
