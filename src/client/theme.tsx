import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import sciFiCss from "./theme-scifi.css?inline";
import sciFiRedesignCss from "./theme-scifi-redesign.css?inline";
import workspaceRedesignCss from "./workspace-redesign.css?inline";

export type AppTheme = "macaron" | "scifi";

type ThemeContextValue = {
  setTheme: (theme: AppTheme) => void;
  theme: AppTheme;
  toggleTheme: () => void;
};

export const THEME_STORAGE_KEY = "knowledge.theme.v1";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isAppTheme(value: unknown): value is AppTheme {
  return value === "macaron" || value === "scifi";
}

function readTheme(): AppTheme {
  if (typeof document !== "undefined") {
    const bootstrapped = document.documentElement.dataset.theme;

    if (isAppTheme(bootstrapped)) {
      return bootstrapped;
    }
  }

  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

      if (isAppTheme(stored)) {
        return stored;
      }
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }

  return "macaron";
}

function applyTheme(theme: AppTheme, persist: boolean) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;

  const selector = "style[data-knowledge-scifi-theme]";
  const currentStyle = document.head.querySelector<HTMLStyleElement>(selector);

  if (theme === "scifi") {
    const style = currentStyle ?? document.createElement("style");

    style.dataset.knowledgeScifiTheme = "";
    style.textContent = `${sciFiCss}\n${workspaceRedesignCss}\n${sciFiRedesignCss}`;
    document.head.append(style);
  } else {
    currentStyle?.remove();
  }

  if (persist && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The in-memory selection still works when persistence is unavailable.
    }
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(readTheme);

  useLayoutEffect(() => {
    applyTheme(theme, false);
  }, [theme]);

  const setTheme = useCallback((nextTheme: AppTheme) => {
    applyTheme(nextTheme, true);
    setThemeState(nextTheme);
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme(theme === "macaron" ? "scifi" : "macaron");
  }, [setTheme, theme]);
  const value = useMemo(
    () => ({ setTheme, theme, toggleTheme }),
    [setTheme, theme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}

export function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const targetLabel = theme === "macaron" ? "科幻" : "马卡龙";

  return (
    <button
      aria-label={`切换到${targetLabel}主题`}
      className="theme-toggle-button"
      data-active-theme={theme}
      onClick={toggleTheme}
      title={`切换到${targetLabel}主题`}
      type="button"
    >
      <span aria-hidden="true" className="theme-toggle-glyph" />
    </button>
  );
}
