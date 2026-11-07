// The page's language and direction, set before anything renders. `?lang=fa` turns the studio right-to-left in
// Persian (kept for this browser), `?lang=en` turns it back. The words stay English for now: this is the RTL check
// (PIP-JOURNEY §3.7) without setting `dir` by hand, and digits follow it through Intl ("۳۰"). Imported first by
// main.tsx, so format.ts and human.ts read the language when they load.
const KEY = "pap.lang";
const RTL = new Set(["fa", "ar"]);

function wanted(): string {
  const q = new URLSearchParams(location.search).get("lang");
  try {
    if (q === "en") localStorage.removeItem(KEY);
    else if (q && RTL.has(q)) localStorage.setItem(KEY, q);
    return localStorage.getItem(KEY) ?? "en";
  } catch {
    return q && RTL.has(q) ? q : "en";
  }
}

if (typeof document !== "undefined") {
  const lang = wanted();
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
}

/** the page's digits for each language whose words aren't written yet */
const DIGITS: Record<string, string> = { fa: "arabext", ar: "arab" };
/** the locale numbers, times and dates are written in: under `?lang=fa` the words stay English and the digits are
 * the page's ("$۰.۴۲ of $۶", "۱۴ minutes ago"); else the browser's locale */
export function numberLocale(): string {
  const page = typeof document !== "undefined" ? document.documentElement.lang : "";
  if (DIGITS[page]) return `en-u-nu-${DIGITS[page]}`;
  return typeof navigator !== "undefined" ? navigator.language : "en";
}
