import { Check } from 'lucide-react';

export function Brand({ sub = 'by Wakandi' }: { sub?: string }) {
  return (
    <span className="brand">
      <span className="brand-mark"><Check size={20} strokeWidth={3.2} /></span>
      <span>QuickLoan<small>{sub}</small></span>
    </span>
  );
}
