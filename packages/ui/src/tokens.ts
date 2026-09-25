/**
 * NEXUS design tokens — the single source consumed by both the Next.js web app
 * (admin + user surfaces) and the Chrome MV3 Side Panel Companion, so the two
 * surfaces cannot visually drift.
 *
 * Provenance legend:
 *   SPEC      — value stated verbatim in Nexus_CRM_Master_Spec_v1.json
 *   FIGMA     — value measured from the finalized .fig containers
 *   ASSUMPTION— smallest reversible choice where neither source pins the value.
 *               Per the master prompt these are recorded, never silent.
 */

export type TokenProvenance = 'SPEC' | 'FIGMA' | 'ASSUMPTION';

export interface Token<T> {
  readonly value: T;
  readonly provenance: TokenProvenance;
  readonly note?: string;
}

const t = <T,>(value: T, provenance: TokenProvenance, note?: string): Token<T> =>
  note === undefined ? { value, provenance } : { value, provenance, note };

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export const surfaces = {
  /** `.fig` meta.json client_meta.background_color = 0.8980392 -> #E5E5E5 */
  canvas: t('#E5E5E5', 'FIGMA', 'fig meta.json client_meta.background_color'),
  /** App shell sits on an off-white surface, lighter than the canvas. */
  app: t('#F7F8FA', 'SPEC', 'spec: light/off-white surfaces'),
  card: t('#FFFFFF', 'SPEC', 'clear cards'),
  /** Sidebar uses cool gray structure. */
  sidebar: t('#FBFBFC', 'SPEC', 'spec: cool gray structure'),
  sidebarActive: t('#EEF1F5', 'ASSUMPTION', 'active nav row fill'),
  tableHeader: t('#F4F6F8', 'ASSUMPTION', 'compact table header fill'),
  tableRowHover: t('#F8FAFB', 'ASSUMPTION', 'row hover fill'),
  overlay: t('rgba(16, 21, 28, 0.42)', 'ASSUMPTION', 'modal scrim'),
  inset: t('#F1F3F6', 'ASSUMPTION', 'inset / read-only field fill'),
} as const;

/* ------------------------------------------------------------------ */
/* Borders & structure                                                 */
/* ------------------------------------------------------------------ */

export const borders = {
  /** spec: "1px cool gray" */
  width: t('1px', 'SPEC', 'spec layout_notes.borders'),
  color: t('#DDE1E7', 'SPEC', 'cool gray 1px borders'),
  colorStrong: t('#C6CCD5', 'ASSUMPTION', 'emphasis border (focus-adjacent, dividers)'),
  divider: t('#E8EBEF', 'ASSUMPTION', 'hairline divider inside cards'),
} as const;

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export const text = {
  primary: t('#141A21', 'SPEC', 'near-black primary text'),
  secondary: t('#4A5461', 'ASSUMPTION', 'supporting copy'),
  muted: t('#6B7684', 'ASSUMPTION', 'metadata / table secondary cells'),
  placeholder: t('#9AA4B1', 'ASSUMPTION', 'input placeholder'),
  inverse: t('#FFFFFF', 'SPEC', 'primary button text is white'),
  link: t('#1F5FD0', 'ASSUMPTION', 'inline link'),
} as const;

/* ------------------------------------------------------------------ */
/* Primary action                                                      */
/* ------------------------------------------------------------------ */

export const action = {
  /** spec: "near-black/navy background with white text" */
  primaryBg: t('#101A2B', 'SPEC', 'layout_notes.primary_button'),
  primaryBgHover: t('#1B2942', 'ASSUMPTION', 'hover state for primary button'),
  primaryBgActive: t('#0A1220', 'ASSUMPTION', 'pressed state for primary button'),
  primaryText: t('#FFFFFF', 'SPEC', 'layout_notes.primary_button'),
  secondaryBg: t('#FFFFFF', 'ASSUMPTION', 'secondary button surface'),
  secondaryBorder: t('#C6CCD5', 'ASSUMPTION', 'secondary button border'),
  ghostHover: t('#EEF1F5', 'ASSUMPTION', 'ghost button hover'),
  disabledBg: t('#E3E7EC', 'ASSUMPTION', 'disabled control fill'),
  disabledText: t('#98A2AE', 'ASSUMPTION', 'disabled control text'),
} as const;

/* ------------------------------------------------------------------ */
/* Status accents (spec layout_notes.status_accents)                   */
/* ------------------------------------------------------------------ */

export interface Accent {
  readonly fill: Token<string>;
  readonly fg: Token<string>;
  readonly border: Token<string>;
}

const accent = (fill: string, fg: string, border: string, note: string): Accent => ({
  fill: t(fill, 'ASSUMPTION', `${note} fill`),
  fg: t(fg, 'ASSUMPTION', `${note} foreground`),
  border: t(border, 'ASSUMPTION', `${note} border`),
});

export const accents = {
  /** new / connection / profile */
  cyan: accent('#E2F5FA', '#0B5F73', '#9FDDEB', 'cyan: new/connection/profile'),
  /** ready / sent / replied / active */
  green: accent('#E4F5EA', '#186B3A', '#A9DDBE', 'green: ready/sent/replied/active'),
  /** follow-up / due / cooldown */
  amber: accent('#FDF2DF', '#8A5A08', '#F0D19A', 'amber: follow-up/due/cooldown'),
  /** overdue / DNC / destructive */
  red: accent('#FCE9E9', '#9B1C1C', '#F0B4B4', 'red: overdue/DNC/destructive'),
  /** business / ICP / configuration context */
  indigo: accent('#EAEBFB', '#33399B', '#BFC2F2', 'indigo: business/ICP/config context'),
  /** neutral chip */
  neutral: accent('#EFF1F4', '#4A5461', '#DDE1E7', 'neutral chip'),
} as const;

export type AccentName = keyof typeof accents;

/* ------------------------------------------------------------------ */
/* Radii (spec: 9-14px controls/cards; larger only for login shells)    */
/* ------------------------------------------------------------------ */

export const radii = {
  sm: t('6px', 'ASSUMPTION', 'small inner elements (pills inside cards)'),
  control: t('9px', 'SPEC', 'lower bound of layout_notes.radius_range_px'),
  card: t('12px', 'SPEC', 'mid of layout_notes.radius_range_px'),
  panel: t('14px', 'SPEC', 'upper bound of layout_notes.radius_range_px'),
  loginShell: t('20px', 'SPEC', 'larger only for login shells'),
  pill: t('999px', 'ASSUMPTION', 'status pills'),
} as const;

/* ------------------------------------------------------------------ */
/* Spacing — "generous but compact operational spacing"                */
/* ------------------------------------------------------------------ */

export const space = {
  xxs: t('2px', 'ASSUMPTION', 'hairline gap'),
  xs: t('4px', 'ASSUMPTION', 'chip inner gap'),
  sm: t('8px', 'ASSUMPTION', 'tight stack'),
  md: t('12px', 'ASSUMPTION', 'control padding'),
  lg: t('16px', 'ASSUMPTION', 'card padding'),
  xl: t('20px', 'ASSUMPTION', 'section gap'),
  xxl: t('28px', 'ASSUMPTION', 'page block gap'),
  shell: t('32px', 'ASSUMPTION', 'page outer gutter'),
} as const;

/* ------------------------------------------------------------------ */
/* Typography — Inter                                                  */
/* ------------------------------------------------------------------ */

export const typography = {
  family: t(
    "'Inter', 'Inter var', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    'SPEC',
    'spec visual_direction: Inter',
  ),
  mono: t("'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", 'ASSUMPTION', 'raw payload/JSON display'),
  size: {
    micro: t('10px', 'ASSUMPTION', 'micro labels, overline'),
    xs: t('11px', 'ASSUMPTION', 'table meta, caption'),
    sm: t('12px', 'ASSUMPTION', 'dense table cell, chip'),
    base: t('13px', 'ASSUMPTION', 'default control/body in dense operational UI'),
    md: t('14px', 'ASSUMPTION', 'body copy'),
    lg: t('16px', 'ASSUMPTION', 'card title'),
    xl: t('20px', 'ASSUMPTION', 'page section title'),
    xxl: t('26px', 'ASSUMPTION', 'page title'),
    display: t('34px', 'ASSUMPTION', 'login wordmark / hero'),
  },
  weight: {
    regular: t(400, 'ASSUMPTION', 'body'),
    medium: t(500, 'ASSUMPTION', 'controls, table headers'),
    semibold: t(600, 'ASSUMPTION', 'titles, emphasis'),
  },
  leading: {
    tight: t('1.25', 'ASSUMPTION', 'titles'),
    normal: t('1.45', 'ASSUMPTION', 'body'),
    relaxed: t('1.6', 'ASSUMPTION', 'message body preview'),
  },
  tracking: {
    overline: t('0.06em', 'ASSUMPTION', 'uppercase overline labels'),
  },
} as const;

/* ------------------------------------------------------------------ */
/* Elevation — thin borders, restrained shadows                        */
/* ------------------------------------------------------------------ */

export const elevation = {
  none: t('none', 'SPEC', 'spec: thin borders rather than heavy shadows'),
  card: t('0 1px 2px rgba(16, 21, 28, 0.04)', 'ASSUMPTION', 'card rest'),
  raised: t('0 2px 8px rgba(16, 21, 28, 0.08)', 'ASSUMPTION', 'popover / dropdown'),
  modal: t('0 18px 48px rgba(16, 21, 28, 0.18)', 'ASSUMPTION', 'modal shell'),
} as const;

/* ------------------------------------------------------------------ */
/* Reference surfaces                                                  */
/* ------------------------------------------------------------------ */

export const layout = {
  desktopWidth: t(1440, 'SPEC', 'design_system.desktop_reference.width'),
  desktopHeight: t(980, 'SPEC', 'design_system.desktop_reference.height'),
  companionWidth: t(420, 'SPEC', 'design_system.companion_reference.width'),
  companionHeight: t(820, 'SPEC', 'design_system.companion_reference.height'),
  userSidebarWidth: t(220, 'SPEC', 'layout_notes.user_sidebar_width_approx'),
  adminSidebarWidth: t(238, 'SPEC', 'layout_notes.admin_sidebar_width_approx'),
  companionMinWidth: t(360, 'ASSUMPTION', 'side panel can be narrowed; spec optimises for 420px'),
  focusRingWidth: t('2px', 'ASSUMPTION', 'keyboard focus ring'),
} as const;

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

export const motion = {
  fast: t('110ms', 'ASSUMPTION', 'hover/press'),
  base: t('170ms', 'ASSUMPTION', 'enter/leave'),
  ease: t('cubic-bezier(0.2, 0.8, 0.2, 1)', 'ASSUMPTION', 'standard easing'),
} as const;

/* ------------------------------------------------------------------ */
/* Flattened CSS custom properties                                     */
/* ------------------------------------------------------------------ */

/** `unprovenanced` flattening used to emit the CSS variable block. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string, token: Token<string | number>): void => {
    out[name] = String(token.value);
  };

  put('--nx-canvas', surfaces.canvas);
  put('--nx-surface-app', surfaces.app);
  put('--nx-surface-card', surfaces.card);
  put('--nx-surface-sidebar', surfaces.sidebar);
  put('--nx-surface-sidebar-active', surfaces.sidebarActive);
  put('--nx-surface-table-header', surfaces.tableHeader);
  put('--nx-surface-table-hover', surfaces.tableRowHover);
  put('--nx-surface-overlay', surfaces.overlay);
  put('--nx-surface-inset', surfaces.inset);

  put('--nx-border-width', borders.width);
  put('--nx-border-color', borders.color);
  put('--nx-border-color-strong', borders.colorStrong);
  put('--nx-border-divider', borders.divider);

  for (const [k, v] of Object.entries(text)) put(`--nx-text-${kebab(k)}`, v);

  put('--nx-action-primary-bg', action.primaryBg);
  put('--nx-action-primary-bg-hover', action.primaryBgHover);
  put('--nx-action-primary-bg-active', action.primaryBgActive);
  put('--nx-action-primary-text', action.primaryText);
  put('--nx-action-secondary-bg', action.secondaryBg);
  put('--nx-action-secondary-border', action.secondaryBorder);
  put('--nx-action-ghost-hover', action.ghostHover);
  put('--nx-action-disabled-bg', action.disabledBg);
  put('--nx-action-disabled-text', action.disabledText);

  for (const [name, a] of Object.entries(accents)) {
    put(`--nx-accent-${name}-fill`, a.fill);
    put(`--nx-accent-${name}-fg`, a.fg);
    put(`--nx-accent-${name}-border`, a.border);
  }

  for (const [k, v] of Object.entries(radii)) put(`--nx-radius-${kebab(k)}`, v);
  for (const [k, v] of Object.entries(space)) put(`--nx-space-${kebab(k)}`, v);

  put('--nx-font-family', typography.family);
  put('--nx-font-mono', typography.mono);
  for (const [k, v] of Object.entries(typography.size)) put(`--nx-font-size-${kebab(k)}`, v);
  for (const [k, v] of Object.entries(typography.weight)) put(`--nx-font-weight-${kebab(k)}`, v);
  for (const [k, v] of Object.entries(typography.leading)) put(`--nx-leading-${kebab(k)}`, v);

  put('--nx-shadow-none', elevation.none);
  put('--nx-shadow-card', elevation.card);
  put('--nx-shadow-raised', elevation.raised);
  put('--nx-shadow-modal', elevation.modal);

  put('--nx-desktop-width', layout.desktopWidth);
  put('--nx-desktop-height', layout.desktopHeight);
  put('--nx-companion-width', layout.companionWidth);
  put('--nx-companion-height', layout.companionHeight);
  put('--nx-user-sidebar-width', layout.userSidebarWidth);
  put('--nx-admin-sidebar-width', layout.adminSidebarWidth);
  put('--nx-focus-ring-width', layout.focusRingWidth);

  put('--nx-motion-fast', motion.fast);
  put('--nx-motion-base', motion.base);
  put('--nx-motion-ease', motion.ease);

  return out;
}

function kebab(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export const tokens = {
  surfaces,
  borders,
  text,
  action,
  accents,
  radii,
  space,
  typography,
  elevation,
  layout,
  motion,
} as const;
