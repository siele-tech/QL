import { db, json } from '../db/db.ts';

/** Permission catalogue. This app serves members only, so there is a single role. */
export const PERMISSIONS = {
  'member.self': 'Access own member lending information',
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const DEFAULT_ROLES: { key: string; name: string; description: string; scope: 'MEMBER'; permissions: Permission[] }[] = [
  { key: 'member', name: 'Member', description: 'Borrower — own lending information only.', scope: 'MEMBER', permissions: ['member.self'] },
];

const cache = new Map<string, Set<string>>();
export function permissionsFor(roleKey: string): Set<string> {
  if (!cache.has(roleKey)) {
    const row = db.get<{ permissions: string }>('SELECT permissions FROM roles WHERE key = ?', roleKey);
    cache.set(roleKey, new Set(json<string[]>(row?.permissions, [])));
  }
  return cache.get(roleKey)!;
}
export const clearPermissionCache = () => cache.clear();

export function seedRoles() {
  for (const r of DEFAULT_ROLES) {
    db.run(
      `INSERT INTO roles (key, name, description, scope, permissions, is_system) VALUES (?,?,?,?,?,1)
       ON CONFLICT(key) DO UPDATE SET name=excluded.name, description=excluded.description, permissions=excluded.permissions`,
      r.key, r.name, r.description, r.scope, JSON.stringify(r.permissions),
    );
  }
  clearPermissionCache();
}
