'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type { Campaign, EffectiveMap, Me, PauseState } from '@/lib/types';
import { Loading } from './ui';

type IconName = 'home' | 'calendar' | 'plan' | 'content' | 'send' | 'chart' | 'media' | 'plug' | 'team' | 'comments' | 'admin';

const ICONS: Record<IconName, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  plan: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  content: 'M4 5h16v10H4zM8 19h8M12 15v4',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  media: 'M4 5h16v14H4zM4 15l5-4 4 3 3-2 4 3M9 9h.01',
  plug: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 01-10 0zM12 17v4',
  team: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 100-5M21 19c0-2.4-1.6-4.4-4-5',
  comments: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  admin: 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM9 12l2 2 4-4',
};


function Icon({ name, className = 'h-[18px] w-[18px]' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

const NAV: Array<{ href: string; label: string; icon: IconName; admin?: boolean }> = [
  { href: '/', label: 'Tableau de bord', icon: 'home' },
  { href: '/calendar', label: 'Calendrier', icon: 'calendar' },
  { href: '/planning', label: 'Planning', icon: 'plan' },
  { href: '/content', label: 'Contenu', icon: 'content' },
  { href: '/publishing', label: 'Publication', icon: 'send' },
  { href: '/comments', label: 'Commentaires', icon: 'comments' },
  { href: '/analytics', label: 'Analytics', icon: 'chart' },
  { href: '/assets', label: 'Médias', icon: 'media' },
  { href: '/accounts', label: 'Comptes', icon: 'plug' },
  { href: '/team', label: 'Équipe', icon: 'team', admin: true },
  { href: '/administration', label: 'Administration', icon: 'admin', admin: true },
];

const dayKey = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Tunis' }).format(d);

/** Whole days from today (Tunis) to the release date: >0 before, 0 on the day, <0 after. */
export function daysToRelease(releaseIso: string): number {
  const a = Date.parse(`${dayKey(new Date())}T00:00:00Z`);
  const b = Date.parse(`${dayKey(new Date(releaseIso))}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function releaseLabel(days: number): string {
  if (days > 1) return `J-${days}`;
  if (days === 1) return 'Demain';
  if (days === 0) return 'Jour J';
  return `J+${-days}`;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const me = useFetch<Me>('/auth/me');
  const pause = useFetch<PauseState>('/settings/pause');
  const campaign = useFetch<Campaign>('/campaign');
  const effective = useFetch<EffectiveMap>(EP.features.effective);
  const emergencyActive = Object.values(effective.data ?? {}).some((e) => e.restrictions.some((r) => r.by === 'EMERGENCY_STOP'));
  const [busy, setBusy] = useState(false);

  if (me.loading) return <div className="p-8"><Loading /></div>;
  if (!me.data) return null; // api() already redirected to /login

  const role = me.data.role;
  const canPause = role === 'ADMIN' || role === 'APPROVER';
  const items = NAV.filter((n) => !n.admin || role === 'ADMIN');
  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const rel = campaign.data ? daysToRelease(campaign.data.releaseDate) : null;

  async function togglePause() {
    const next = !pause.data?.paused;
    const reason = next ? window.prompt('Raison de la pause (optionnel) :') ?? undefined : undefined;
    if (next && !window.confirm('Arrêter toutes les publications automatiques ?')) return;
    setBusy(true);
    try {
      await api('/settings/pause', { method: 'POST', body: { paused: next, reason } });
      await pause.reload();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-graphite px-3 py-5 text-white md:flex">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-base font-extrabold text-ink">W</span>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">What Else</div>
            <div className="text-xs text-neutral-400">Easy Distribution</div>
          </div>
        </div>

        {rel !== null && (
          <div className="mx-2 mb-5 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="text-xs text-neutral-400">Sortie en salle</div>
            <div className="text-lg font-bold leading-tight text-brand">{releaseLabel(rel)}</div>
          </div>
        )}

        <nav className="flex flex-1 flex-col gap-0.5" aria-label="Navigation principale">
          {items.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-white/10 font-semibold text-white shadow-[inset_3px_0_0_#f2b705]' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon name={n.icon} className={`h-[18px] w-[18px] ${active ? 'text-brand' : ''}`} />
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 border-t border-white/10 px-2 pt-3 text-xs text-neutral-400">
          <div className="truncate font-medium text-neutral-200">{me.data.name}</div>
          <div className="mb-2">{role === 'ADMIN' ? 'Administrateur' : role === 'APPROVER' ? 'Validateur' : 'Éditeur'}</div>
          <button onClick={logout} className="rounded underline-offset-2 hover:text-white hover:underline">Déconnexion</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex gap-1 overflow-x-auto bg-graphite p-2 md:hidden" aria-label="Navigation principale">
          {items.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs ${active ? 'bg-brand font-semibold text-ink' : 'text-neutral-300'}`}
              >
                <Icon name={n.icon} className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>

        {pause.data?.paused && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-red-600 px-4 py-2.5 text-sm font-semibold text-white">
            <span>
              Publications en pause{pause.data.reason ? ` : ${pause.data.reason}` : ''}. Rien ne sera publié automatiquement.
            </span>
            {canPause && (
              <button className="rounded-md bg-white px-3 py-1 text-red-700 hover:bg-red-50" disabled={busy} onClick={togglePause}>
                Reprendre
              </button>
            )}
          </div>
        )}

        {emergencyActive && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-red-700 px-4 py-2.5 text-sm font-semibold text-white">
            <span>
              Arrêt d&apos;urgence de l&apos;automatisation actif. Aucune nouvelle action externe automatique ne sera lancée.
            </span>
            {role === 'ADMIN' && (
              <Link href="/administration" className="rounded-md bg-white px-3 py-1 text-red-700 hover:bg-red-50">
                Ouvrir l&apos;administration
              </Link>
            )}
          </div>
        )}

        <header className="flex items-center justify-between gap-2 border-b border-line bg-white/80 px-4 py-2 backdrop-blur md:px-6">
          <span className="text-xs text-neutral-500 md:text-sm">
            {rel !== null && (
              <>
                Sortie : <b className="text-ink">{releaseLabel(rel)}</b>
              </>
            )}
          </span>
          {canPause && !pause.data?.paused && (
            <button className="btn btn-danger" disabled={busy} onClick={togglePause}>
              Pause d&apos;urgence
            </button>
          )}
        </header>

        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}