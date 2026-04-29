import ejs from 'ejs';
import { layoutSource, templates } from '../emails/_compiled.js';
import { euDate, euDateTime } from './dates.js';

const layoutFn = ejs.compile(layoutSource);
const renderCache = new Map();

const STYLES = Object.freeze({
  tagline:
    "color:#A8B0B8;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 14px;",
  h1:
    "margin:0 0 16px;color:#FFFFFF;font-family:'Satoshi','General Sans',system-ui,-apple-system,sans-serif;font-size:24px;font-weight:700;letter-spacing:-0.01em;line-height:1.2;",
  lead:
    'margin:0 0 16px;color:#F6F3EE;font-size:16px;line-height:1.55;',
  body:
    'margin:0 0 16px;color:#F6F3EE;font-size:15px;line-height:1.6;',
  note:
    'margin:0;color:#A8B0B8;font-size:13px;line-height:1.6;',
  divider:
    'border:0;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;',
  ctaWrap:
    'margin:8px 0 24px;',
  ctaCell:
    'background:#2F5D50;border-radius:8px;',
  ctaLink:
    "display:inline-block;padding:12px 22px;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.02em;font-family:'General Sans',system-ui,-apple-system,sans-serif;",
  metaTable:
    'width:100%;margin:0 0 24px;border-collapse:collapse;',
  metaLabel:
    "padding:6px 12px 6px 0;color:#A8B0B8;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;vertical-align:top;width:130px;",
  metaValue:
    'padding:6px 0;color:#FFFFFF;font-size:14px;line-height:1.5;vertical-align:top;word-break:break-word;',
  link: 'color:#C4A97A;text-decoration:none;',
});

const HELPERS = Object.freeze({ S: STYLES, euDate, euDateTime });

function getRender(slug, locale) {
  const slugEntry = templates[slug];
  if (!slugEntry) {
    throw new Error(`Unknown email template: ${slug}`);
  }
  const useLocale = slugEntry[locale] ? locale : 'en';
  const t = slugEntry[useLocale];
  if (!t) {
    throw new Error(`Email template ${slug} has no en/ fallback`);
  }
  const cacheKey = `${useLocale}/${slug}`;
  if (!renderCache.has(cacheKey)) {
    renderCache.set(cacheKey, {
      subject: t.subject,
      bodyFn: ejs.compile(t.source),
    });
  }
  return renderCache.get(cacheKey);
}

export function renderTemplate(slug, locale, locals = {}) {
  const useLocale = locale ?? 'en';
  const r = getRender(slug, useLocale);
  const merged = { ...HELPERS, ...locals };
  const body = r.bodyFn(merged);
  const html = layoutFn({
    ...merged,
    body,
    subject: r.subject,
    locale: useLocale,
  });
  return { subject: r.subject, body: html };
}

export function listTemplates() {
  return Object.keys(templates).sort();
}
