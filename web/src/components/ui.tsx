import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle, RefreshCw, Inbox } from 'lucide-react';
import { STATUS_LABEL, STATUS_TONE, type Tone } from '../format';
import { ApiError } from '../api';

// ───────── data hook with loading / error / reload ─────────
/** Last good response per screen (in memory only). Cleared whenever the signed-in person changes. */
const dataCache = new Map<string, unknown>();
export const clearDataCache = () => dataCache.clear();

/**
 * Load data for a screen. With a `cacheKey`, the last response is shown immediately while a fresh
 * copy loads in the background — so screens open instantly on slow mobile networks, and stay
 * readable if the refresh fails.
 */
export function useData<T>(fetcher: () => Promise<T>, deps: unknown[] = [], cacheKey?: string) {
  const cached = cacheKey && dataCache.has(cacheKey) ? (dataCache.get(cacheKey) as T) : null;
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: cached, error: null, loading: cached === null });
  const alive = useRef(true);
  const load = useCallback(async (silent = false) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcher();
      if (cacheKey) dataCache.set(cacheKey, data);
      if (alive.current) setState({ data, error: null, loading: false });
      return data;
    } catch (e: any) {
      if (alive.current) setState((s) => ({ data: silent ? s.data : null, error: e, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { alive.current = true; load(cached !== null); return () => { alive.current = false; }; }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load, setData: (d: T) => { if (cacheKey) dataCache.set(cacheKey, d); setState((s) => ({ ...s, data: d })); } };
}

/** Standard wrapper: loading → error (with retry) → content. */
export function Loadable<T>({ q, children, skeleton }: { q: { data: T | null; error: ApiError | null; loading: boolean; reload: (silent?: boolean) => any }; children: (d: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.loading && !q.data) return <>{skeleton ?? <SkeletonBlock />}</>;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  return (
    <>
      {q.error && q.data && <div className="stale-note" role="status">Showing the last saved details. <button type="button" onClick={() => q.reload(true)}>Refresh</button></div>}
      {children(q.data as T)}
    </>
  );
}

export function SkeletonBlock({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton-wrap" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}

// ───────── buttons ─────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'teal' | 'ghost' | 'outline' | 'danger' | 'link'; loading?: boolean; block?: boolean; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode };
export function Button({ variant = 'teal', loading, block, size = 'md', icon, children, className = '', disabled, ...rest }: BtnProps) {
  return (
    <button {...rest} disabled={disabled || loading} className={`btn btn-${variant} btn-${size} ${block ? 'btn-block' : ''} ${className}`}>
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

// ───────── surfaces ─────────
export const Card = ({ children, className = '', title, action, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; pad?: boolean }) => (
  <section className={`card ${pad ? '' : 'card-flush'} ${className}`}>
    {(title || action) && <header className="card-head"><h3>{title}</h3>{action}</header>}
    {children}
  </section>
);

export function Badge({ status, label, tone }: { status?: string; label?: string; tone?: Tone }) {
  const t = tone ?? (status ? STATUS_TONE[status] : 'neutral') ?? 'neutral';
  return <span className={`badge badge-${t}`}><i aria-hidden />{label ?? (status ? STATUS_LABEL[status] ?? status : '')}</span>;
}

export function ProgressBar({ value, tone = 'teal', label }: { value: number; tone?: 'teal' | 'yellow' | 'terra'; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return <div className={`progress progress-${tone}`} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div style={{ width: `${v}%` }} /></div>;
}

export function Spinner({ label }: { label?: string }) {
  return <div className="spinner-row" role="status"><Loader2 className="spin" size={20} />{label && <span>{label}</span>}</div>;
}
export const FullPageSpinner = () => <div className="full-center"><Spinner label="Loading QuickLoan…" /></div>;

export function EmptyState({ title, text, action, icon }: { title: string; text?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Inbox size={22} />}</div>
      <h4>{title}</h4>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty empty-error" role="alert">
      <div className="empty-icon"><AlertTriangle size={22} /></div>
      <h4>Something went wrong</h4>
      <p>{message}</p>
      {onRetry && <Button variant="outline" size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'good' | 'warn' | 'bad'; children?: ReactNode; title?: ReactNode }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : Info;
  return <div className={`alert alert-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}><Icon size={18} /><div>{title && <strong>{title}</strong>}{children && <div>{children}</div>}</div></div>;
}

// ───────── forms ─────────
export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <small className="field-msg err">{error}</small> : hint ? <small className="field-msg">{hint}</small> : null}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ''}`} />;
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span /></span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

// ───────── modal ─────────
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <header><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ───────── toasts (feedback for completed server actions) ─────────
type ToastT = { id: number; tone: 'good' | 'bad' | 'info'; text: string };
const ToastCtx = createContext<(tone: ToastT['tone'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const push = useCallback((tone: ToastT['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.tone === 'good' ? <CheckCircle2 size={16} /> : t.tone === 'bad' ? <XCircle size={16} /> : <Info size={16} />}{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} className={value === i.value ? 'active' : ''} onClick={() => onChange(i.value)}>
          {i.label}{i.count !== undefined && <span className="tab-count">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
