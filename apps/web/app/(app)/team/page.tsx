'use client';

import { useState } from 'react';
import { api, useFetch } from '@/lib/api';
import type { Role } from '@/lib/types';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';

interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

const ROLE_HELP: Record<Role, string> = {
  ADMIN: 'Tout, y compris comptes et équipe',
  APPROVER: 'Valide, programme, publie, met en pause',
  EDITOR: 'Crée et soumet des posts',
};

export default function TeamPage() {
  const users = useFetch<User[]>('/users');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'APPROVER' as Role });
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await api('/users', { method: 'POST', body: form });
      setForm({ email: '', name: '', password: '', role: 'APPROVER' });
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggle(u: User) {
    setError(null);
    try {
      await api(`/users/${u.id}/active`, { method: 'PATCH', body: { active: !u.active } });
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (users.loading) return <Loading />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle title="Équipe" />
      <ErrorNote message={error ?? users.error} />
      <div className="card">
        <ul className="divide-y divide-neutral-100">
          {users.data?.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="flex-1">
                <div className={`font-medium ${u.active ? '' : 'text-neutral-400 line-through'}`}>{u.name}</div>
                <div className="text-xs text-neutral-500">{u.email} · {u.role}</div>
              </div>
              <button className="btn" onClick={() => toggle(u)}>{u.active ? 'Désactiver' : 'Réactiver'}</button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card space-y-3">
        <h2 className="font-bold">Ajouter un membre</h2>
        <div className="grid gap-2 md:grid-cols-2">
          <input className="input" placeholder="Nom" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="input" type="password" placeholder="Mot de passe (12 caractères min.)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_HELP) as Role[]).map((r) => <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" disabled={form.password.length < 12 || !form.email || !form.name} onClick={create}>Créer</button>
      </div>
    </div>
  );
}
