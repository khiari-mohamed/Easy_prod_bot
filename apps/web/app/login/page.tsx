'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorNote } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      router.push('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-graphite md:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden p-12 text-white md:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-base font-extrabold text-ink">W</span>
          <span className="text-sm text-neutral-300">Easy Distribution</span>
        </div>
        <div>
          <h1 className="text-6xl font-extrabold leading-[0.95] tracking-tight">
            What
            <br />
            Else
          </h1>
          <p className="mt-6 max-w-sm text-base leading-relaxed text-neutral-400">
            Planifiez, validez et publiez la campagne du film. Chaque publication passe par une validation humaine.
          </p>
        </div>
        <p className="text-xs text-neutral-500">Au cinéma le 14 octobre</p>
        <div className="pointer-events-none absolute -right-24 top-1/3 h-72 w-72 rounded-full bg-brand/15 blur-3xl" aria-hidden />
      </section>

      <section className="flex items-center justify-center bg-canvas p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-line bg-white p-7 shadow-pop">
          <div>
            <div className="flex items-center gap-2 md:hidden">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-extrabold text-ink">W</span>
              <span className="font-semibold">What Else</span>
            </div>
            <h2 className="mt-3 text-xl font-bold tracking-tight md:mt-0">Connexion</h2>
            <p className="text-sm text-neutral-500">Accès réservé à l&apos;équipe de la campagne.</p>
          </div>
          <ErrorNote message={error} />
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="password">Mot de passe</label>
            <input id="password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary w-full py-2.5" disabled={busy}>
            {busy ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>
      </section>
    </div>
  );
}