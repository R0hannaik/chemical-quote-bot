/**
 * Reply templates. Each is plain WhatsApp text with {variables}.
 * A line whose variables render empty is dropped, so a quote without a quantity has no "Requirement" line.
 */
export const DEFAULT_TEMPLATES = {
  quote_header: '*{business_name}*',
  quote_multi_title: '📋 *Quotation for {item_count} items*',
  quote_item: [
    '📦 *Product:* {product_name}',
    '🏷️ *Brand:* {brand}',
    '💰 *Rate:* {rate_details}',
    '📦 *Packaging:* {packaging}',
    '📍 *Location:* {location}',
    '✅ *Status:* {status}',
    '📝 *Requirement:* {requirement}',
    'ℹ️ _{note}_',
  ].join('\n'),
  quote_footer: [
    '━━━━━━━━━━━━━━━━━━━━━━',
    '_Rates subject to day-to-day market changes. For booking confirmation or orders, please connect directly._',
    '*{business_name}* | 📞 {contact_phone}',
  ].join('\n'),
  booking: [
    '*{business_name}*',
    '🤝 *Booking request noted*',
    '📦 *Product:* {product_name}',
    '📝 *Requirement:* {requirement}',
    'Final booking and price need confirmation from our team. *{contact_name}* will contact you directly.',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '*{business_name}* | 📞 {contact_phone}',
  ].join('\n'),
} as const;

export type TemplateMode = keyof typeof DEFAULT_TEMPLATES;
export const TEMPLATE_MODES = Object.keys(DEFAULT_TEMPLATES) as TemplateMode[];

export const TEMPLATE_VARIABLES = ['business_name', 'contact_name', 'contact_phone', 'item_count', 'product_name', 'brand',
  'rate_details', 'packaging', 'location', 'status', 'requirement', 'note'];

/** Fills {variables}; drops any line where a variable is empty. Unknown variables are left as typed. */
export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  const lines: string[] = [];
  for (const line of template.split('\n')) {
    let empty = false;
    const out = line.replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (!(name in vars)) return whole;
      const v = vars[name];
      if (v === null || v === undefined || String(v).trim() === '') { empty = true; return ''; }
      return String(v);
    });
    if (!empty) lines.push(out);
  }
  return lines.join('\n');
}
