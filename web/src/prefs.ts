import { useSyncExternalStore } from 'react';

/** Things a member chooses once on this phone: the language. */
export type Lang = 'en' | 'sw';
export const LANGS: [Lang, string][] = [['en', 'English'], ['sw', 'Kiswahili']];

type Prefs = { lang: Lang };

// Storage can be unavailable (private window, blocked site data): the app still works without it.
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not saved */ } };

let state: Prefs = { lang: read('ql.lang') === 'sw' ? 'sw' : 'en' };
const subs = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = state.lang;

function set(patch: Partial<Prefs>) {
  state = { ...state, ...patch };
  write('ql.lang', state.lang);
  document.documentElement.lang = state.lang;
  subs.forEach((f) => f());
}

export const prefs = () => state;
export const setLang = (lang: Lang) => set({ lang });

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Re-renders the caller (and so everything under it) when a preference changes. */
export const usePrefs = () => useSyncExternalStore(subscribe, prefs);
