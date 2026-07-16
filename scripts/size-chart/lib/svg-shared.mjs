// Shared brand tokens + the XML-escape helper for the size-chart renderer, used by both the main
// layout (render-svg.mjs) and the garment silhouette library (garments.mjs). Brand tokens are the
// resolved values of the storefront's signature "Sapphire Shadow" scheme (deep navy background,
// sapphire accent, Inter type). See snippets/theme-styles-variables.liquid.

export const BG = '#071e3f';        // deep navy background
export const PANEL = '#0c2c56';     // slightly lighter navy for the header band shadow / stripes
export const STRIPE = '#0a2748';    // striped data row
export const ACCENT = '#007dd5';    // sapphire
export const ACCENT_LT = '#3aa0e6'; // lighter sapphire (wordmark, badges)
export const WHITE = '#ffffff';
export const BODY = '#c9d8ea';      // muted light-blue body text
export const FONT = 'Inter';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
