export type AppearanceMode = "light" | "dark";

// This is the only switch between the two supported appearances.
const settings: { mode: AppearanceMode } = { mode: "light" };

// Canonical Solarized palette.
const solarized = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
} as const;

function withAlpha(color: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return `${color}${alpha}`;
}

function createColors(mode: AppearanceMode) {
  const roles = mode === "dark"
    ? {
        canvas: solarized.base03,
        panel: solarized.base02,
        raised: solarized.base03,
        text: solarized.base0,
        strongText: solarized.base1,
        secondaryText: solarized.base00,
        faintText: solarized.base01,
        border: solarized.base01,
        shadow: solarized.base03,
      }
    : {
        canvas: solarized.base3,
        panel: solarized.base2,
        raised: solarized.base3,
        text: solarized.base00,
        strongText: solarized.base01,
        secondaryText: solarized.base0,
        faintText: solarized.base1,
        border: solarized.base1,
        shadow: solarized.base03,
      };

  return {
    // Window chrome and passive surfaces.
    shell: {
      appBackground: roles.canvas,
      topbarBackground: roles.canvas,
      panelBackground: roles.panel,
      hoverBackground: withAlpha(solarized.blue, mode === "dark" ? 0.10 : 0.08),
      selectedBackground: withAlpha(solarized.blue, mode === "dark" ? 0.18 : 0.14),
      border: withAlpha(roles.border, mode === "dark" ? 0.68 : 0.58),
      subtleBorder: withAlpha(roles.border, mode === "dark" ? 0.44 : 0.38),
      selectedOutline: withAlpha(roles.strongText, 0.08),
      toastBackground: roles.panel,
      toastShadow: withAlpha(roles.shadow, mode === "dark" ? 0.72 : 0.28),
      scrollbarThumb: withAlpha(roles.secondaryText, 0.42),
    },

    // General text hierarchy. Context-specific colors live in their own groups below.
    text: {
      primary: roles.text,
      strong: roles.strongText,
      secondary: roles.secondaryText,
      faint: roles.faintText,
    },

    // Buttons, inputs, focus states, and the Review Loop mark.
    controls: {
      markBorder: solarized.blue,
      markText: solarized.blue,
      markBackground: withAlpha(solarized.blue, 0.12),
      primaryBorder: solarized.blue,
      primaryBackground: solarized.blue,
      primaryHoverBackground: solarized.cyan,
      primaryText: solarized.base3,
      activeBorder: solarized.blue,
      activeBackground: withAlpha(solarized.blue, 0.12),
      activeText: solarized.blue,
      inputBackground: roles.raised,
      focusBorder: solarized.blue,
      focusRing: withAlpha(solarized.blue, 0.10),
    },

    // File rows, state letters, review badges, and recent-change indicators.
    files: {
      rowText: roles.text,
      activeRowText: roles.strongText,
      modified: solarized.blue,
      added: solarized.green,
      deleted: solarized.red,
      reviewed: solarized.green,
      recentDot: solarized.blue,
      recentGlow: withAlpha(solarized.blue, 0.50),
      commentBadgeBorder: solarized.blue,
      commentBadgeBackground: withAlpha(solarized.blue, 0.12),
      commentBadgeText: solarized.blue,
    },

    // Review notes and inline-comment affordances.
    comments: {
      bodyText: roles.text,
      locationText: solarized.blue,
      highlightBackground: withAlpha(solarized.blue, 0.09),
      marker: solarized.blue,
      inlineBackground: roles.panel,
      inlineBorder: solarized.blue,
      inputBackground: roles.canvas,
      addButtonBackground: solarized.blue,
      addButtonText: solarized.base3,
    },

    // Empty/success state.
    state: {
      successBorder: solarized.green,
      successBackground: withAlpha(solarized.green, 0.09),
      successText: solarized.green,
    },

    // Monaco editor chrome and diff visualization.
    editor: {
      background: roles.canvas,
      foreground: roles.text,
      gutterBackground: roles.canvas,
      lineNumber: roles.faintText,
      activeLineNumber: roles.secondaryText,
      selectionBackground: withAlpha(solarized.blue, 0.26),
      lineHighlightBackground: roles.panel,
      insertedTextBackground: withAlpha(solarized.green, 0.24),
      removedTextBackground: withAlpha(solarized.red, 0.22),
      insertedLineBackground: withAlpha(solarized.green, 0.12),
      removedLineBackground: withAlpha(solarized.red, 0.11),
      diagonalFill: roles.panel,
      scrollbarSlider: withAlpha(roles.secondaryText, 0.34),
      scrollbarSliderHover: withAlpha(roles.secondaryText, 0.54),
      overviewRulerBorder: "transparent",
    },

    // Monaco syntax tokens. These are separate from UI/status colors on purpose.
    syntax: {
      foreground: roles.text,
      comment: roles.faintText,
      keyword: solarized.violet,
      string: solarized.green,
      number: solarized.orange,
      type: solarized.yellow,
      function: solarized.blue,
      variable: solarized.red,
      operator: solarized.cyan,
      punctuation: roles.text,
    },
  };
}

export const appearance = {
  mode: settings.mode,
  typography: {
    uiFontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    codeFontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSizes: {
      micro: "8px",
      tiny: "9px",
      small: "10px",
      control: "11px",
      label: "12px",
      base: "13px",
      heading: "14px",
      icon: "18px",
    },
    lineHeights: {
      icon: "18px",
      body: "1.45",
      commentInput: "1.4",
    },
    editorFontSize: 13,
    editorLineHeight: 19,
  },
  colors: createColors(settings.mode),
} as const;

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function applyAppearance(root: HTMLElement = document.documentElement): void {
  root.style.colorScheme = appearance.mode;

  const typographyVariables = {
    "--font-family-ui": appearance.typography.uiFontFamily,
    "--font-family-code": appearance.typography.codeFontFamily,
    ...Object.fromEntries(
      Object.entries(appearance.typography.fontSizes).map(([name, value]) => [`--font-size-${kebabCase(name)}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(appearance.typography.lineHeights).map(([name, value]) => [`--line-height-${kebabCase(name)}`, value]),
    ),
  };

  for (const [name, value] of Object.entries(typographyVariables)) root.style.setProperty(name, value);
  for (const [group, tokens] of Object.entries(appearance.colors)) {
    for (const [name, value] of Object.entries(tokens)) {
      root.style.setProperty(`--color-${group}-${kebabCase(name)}`, value);
    }
  }
}
