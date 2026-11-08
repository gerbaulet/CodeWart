import hljs from "highlight.js/lib/common";

const cache = new Map<string, string>();
const MAX = 30000;

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Highlight one line of code. Returns HTML (input is escaped by highlight.js). */
export function highlightLine(text: string, lang: string | undefined): string {
  if (!lang || !hljs.getLanguage(lang) || text.length > 1000) return escape(text);
  const key = lang + "\u0000" + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    html = escape(text);
  }
  if (cache.size > MAX) cache.clear();
  cache.set(key, html);
  return html;
}
