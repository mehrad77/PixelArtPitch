// Numbers, money, durations and timecode, through Intl so digits follow the locale.
import { numberLocale } from "./locale.ts";

const LOCALE = numberLocale();
export const FPS = 30;

const usdFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdSmall = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 3 });
const num = new Intl.NumberFormat(LOCALE);
const num1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

export const usd = (v: number) => (Math.abs(v) < 0.1 && v !== 0 ? usdSmall.format(v) : usdFmt.format(v));
export const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${usd(Math.abs(v))}`;
export const n = (v: number) => num.format(v);
export const n1 = (v: number) => num1.format(v);
export const secs = (v: number) => `${num1.format(v)} s`;

/** "4 min", "1 h 5 min", "40 s" */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${num.format(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${num.format(m)} min`;
  const h = Math.floor(m / 60);
  return `${num.format(h)} h ${num.format(m % 60)} min`;
}
export const signedDuration = (sec: number) => `${sec >= 0 ? "+" : "−"}${duration(Math.abs(sec))}`;

/** mm:ss:ff at 30 fps (frames, not hundredths) */
export function timecode(t: number): string {
  const total = Math.max(0, Math.round(t * FPS));
  const f = total % FPS;
  const s = Math.floor(total / FPS) % 60;
  const m = Math.floor(total / FPS / 60);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(m)}:${p(s)}:${p(f)}`;
}

export function bytes(b: number): string {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${num1.format(v)} ${u[i]}`;
}

const dtf = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
const tf = new Intl.DateTimeFormat(LOCALE, { timeStyle: "short" });
export const dateTime = (iso: string) => dtf.format(new Date(iso));
export const clock = (d: Date) => tf.format(d);

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
export function ago(iso: string): string {
  const d = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(d);
  if (a < 60) return rtf.format(Math.round(d), "second");
  if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
