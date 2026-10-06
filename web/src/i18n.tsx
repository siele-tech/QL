import { Fragment, type ReactNode } from 'react';
import { prefs } from './prefs';
import { sw } from './sw';

/**
 * The English sentence is the key. A language that has no entry for it falls back to English, so a
 * missing translation is never a blank. Values go in as {a}, {b}, … so word order can differ.
 */
const DICT: Record<string, Record<string, string>> = { sw };

export function t(en: string, vars?: Record<string, string | number>) {
  let out = DICT[prefs().lang]?.[en] ?? en;
  if (vars) for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

/** Turns the <b>…</b> inside a translated sentence into real bold text. */
export function rich(s: string): ReactNode {
  return s.split(/(<b>.*?<\/b>)/).map((part, i) => (part.startsWith('<b>') ? <b key={i}>{part.slice(3, -4)}</b> : <Fragment key={i}>{part}</Fragment>));
}

/** A number of days, the way each language says it: "9 days", "siku 9". */
export const days = (n: number) => (prefs().lang === 'sw' ? `siku ${n}` : `${n} day${n === 1 ? '' : 's'}`);

/** Locale for dates, so month names come out in the member's language. */
export const dateLocale = () => (prefs().lang === 'sw' ? 'sw-KE' : 'en-GB');
