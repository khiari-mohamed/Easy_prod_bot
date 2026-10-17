'use client';

import type { FeatureMode, PostStatus } from '@/lib/types';

type Tone = { chip: string; dot: string; label: string };

const STATUS: Record<PostStatus, Tone> = {
  DRAFT: { chip: 'bg-neutral-100 text-neutral-700', dot: 'bg-neutral-400', label: 'Brouillon' },
  PENDING_APPROVAL: { chip: 'bg-amber-50 text-amber-800', dot: 'bg-amber-500', label: 'À valider' },
  APPROVED: { chip: 'bg-sky-50 text-sky-800', dot: 'bg-sky-500', label: 'Programmé' },
  QUEUED: { chip: 'bg-sky-50 text-sky-800', dot: 'bg-sky-500', label: 'En file' },
  PUBLISHING: { chip: 'bg-indigo-50 text-indigo-800', dot: 'bg-indigo-500', label: 'Publication…' },
  PUBLISHED: { chip: 'bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500', label: 'Publié' },
  FAILED: { chip: 'bg-red-50 text-red-800', dot: 'bg-red-500', label: 'Échec' },
  MANUAL_REQUIRED: { chip: 'bg-orange-50 text-orange-800', dot: 'bg-orange-500', label: 'À publier à la main' },
  NEEDS_RECONCILIATION: { chip: 'bg-rose-50 text-rose-800', dot: 'bg-rose-500', label: 'À vérifier' },
  CANCELLED: { chip: 'bg-neutral-100 text-neutral-400 line-through', dot: 'bg-neutral-300', label: 'Annulé' },
};

const FALLBACK: Tone = { chip: 'bg-neutral-100 text-neutral-700', dot: 'bg-neutral-400', label: 'Inconnu' };

export const statusDot = (s: PostStatus) => (STATUS[s] ?? FALLBACK).dot;

export function StatusBadge({ status }: { status: PostStatus }) {
  const t = STATUS[status] ?? { ...FALLBACK, label: String(status) };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${t.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
      {t.label}
    </span>
  );
}

const PLATFORM = {
  INSTAGRAM: { label: 'Instagram', dot: 'bg-gradient-to-br from-fuchsia-500 to-orange-400' },
  FACEBOOK: { label: 'Facebook', dot: 'bg-blue-600' },
  TIKTOK: { label: 'TikTok', dot: 'bg-ink' },
} as const;

export const platformDot = (p: keyof typeof PLATFORM) => PLATFORM[p].dot;

export function PlatformTag({ platform }: { platform: keyof typeof PLATFORM }) {
  const p = PLATFORM[platform];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-white px-2 py-0.5 text-xs font-semibold text-neutral-700">
      <span className={`h-2 w-2 rounded-full ${p.dot}`} aria-hidden />
      {p.label}
    </span>
  );
}

export function ModeTag({ mode }: { mode: 'AUTO' | 'MANUAL' }) {
  return mode === 'MANUAL' ? (
    <span className="rounded-md bg-orange-50 px-1.5 py-0.5 text-xs font-semibold text-orange-700">Manuel</span>
  ) : (
    <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-xs font-semibold text-sky-700">Auto</span>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </div>
  );
}

export function Loading() {
  return (
    <div className="space-y-3" role="status" aria-label="Chargement">
      <div className="skeleton h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-20" />)}
      </div>
      <div className="skeleton h-40" />
    </div>
  );
}

export function PageTitle({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 px-4 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">{hint}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  tone = 'brand',
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  tone?: 'brand' | 'danger';
}) {
  const on = tone === 'danger' ? 'bg-red-500' : 'bg-emerald-500';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? on : 'bg-neutral-300'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

const MODE_LABEL: Record<FeatureMode, string> = { OFF: 'Désactivé', REVIEW: 'Validation', AUTO: 'Automatique' };
const MODE_TONE: Record<FeatureMode, string> = {
  OFF: 'bg-neutral-100 text-neutral-600',
  REVIEW: 'bg-amber-50 text-amber-800',
  AUTO: 'bg-emerald-50 text-emerald-800',
};

export const modeLabel = (m: FeatureMode) => MODE_LABEL[m] ?? m;

export function ModeBadge({ mode }: { mode: FeatureMode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${MODE_TONE[mode] ?? MODE_TONE.OFF}`}>{MODE_LABEL[mode] ?? mode}</span>;
}

/** Segmented OFF / REVIEW / AUTO control. Only the modes in `options` are offered. */
export function ModeSwitch({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: FeatureMode;
  options: FeatureMode[];
  onChange: (m: FeatureMode) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-line bg-white text-xs font-semibold">
      {options.map((m) => {
        const active = m === value;
        const on = m === 'OFF' ? 'bg-neutral-700 text-white' : m === 'REVIEW' ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white';
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${active ? on : 'text-neutral-600 hover:bg-neutral-50'}`}
          >
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}

const MODE_LABEL: Record<FeatureMode, string> = { OFF: 'Désactivé', REVIEW: 'Validation', AUTO: 'Automatique' };
const MODE_TONE: Record<FeatureMode, string> = {
  OFF: 'bg-neutral-100 text-neutral-600',
  REVIEW: 'bg-amber-50 text-amber-800',
  AUTO: 'bg-emerald-50 text-emerald-800',
};

export const modeLabel = (m: FeatureMode) => MODE_LABEL[m] ?? m;

export function ModeBadge({ mode }: { mode: FeatureMode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${MODE_TONE[mode] ?? MODE_TONE.OFF}`}>{MODE_LABEL[mode] ?? mode}</span>;
}

/** Segmented OFF / REVIEW / AUTO control. Only the modes in `options` are offered. */
export function ModeSwitch({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: FeatureMode;
  options: FeatureMode[];
  onChange: (m: FeatureMode) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-line bg-white text-xs font-semibold">
      {options.map((m) => {
        const active = m === value;
        const on = m === 'OFF' ? 'bg-neutral-700 text-white' : m === 'REVIEW' ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white';
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${active ? on : 'text-neutral-600 hover:bg-neutral-50'}`}
          >
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
