import { db } from '../db/db.ts';

/**
 * Member Registry integration.
 *
 * Wakandi's Member Registry is the source of truth for identity and currently exposes ONLY:
 * member ID (member number), full name and identification number. QuickLoan never copies
 * these fields into its own tables — it stores `registry_member_id` and resolves identity
 * through this adapter. The local adapter reads a registry replica table; a remote adapter
 * (HTTP) can implement the same interface later.
 */
export interface RegistryIdentity {
  registryId: string;
  organizationId: string;
  memberNumber: string;
  fullName: string;
  idNumber: string;
}

export interface MemberRegistryAdapter {
  get(registryId: string): RegistryIdentity | null;
  getMany(registryIds: string[]): Map<string, RegistryIdentity>;
  findByMemberNumber(organizationId: string, memberNumber: string): RegistryIdentity | null;
  search(organizationId: string, q: string): RegistryIdentity[];
}

const map = (r: any): RegistryIdentity => ({
  registryId: r.id, organizationId: r.organization_id, memberNumber: r.member_number, fullName: r.full_name, idNumber: r.id_number,
});

class LocalRegistryAdapter implements MemberRegistryAdapter {
  get(id: string) {
    const r = db.get('SELECT * FROM registry_members WHERE id = ?', id);
    return r ? map(r) : null;
  }
  getMany(ids: string[]) {
    const out = new Map<string, RegistryIdentity>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (!chunk.length) continue;
      for (const r of db.all(`SELECT * FROM registry_members WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.set(r.id, map(r));
    }
    return out;
  }
  findByMemberNumber(orgId: string, memberNumber: string) {
    const r = db.get('SELECT * FROM registry_members WHERE organization_id = ? AND upper(member_number) = upper(?)', orgId, memberNumber.trim());
    return r ? map(r) : null;
  }
  search(orgId: string, q: string) {
    const like = `%${q.trim().toLowerCase()}%`;
    return db.all(
      `SELECT * FROM registry_members WHERE organization_id = ? AND (lower(full_name) LIKE ? OR lower(member_number) LIKE ? OR id_number LIKE ?) LIMIT 500`,
      orgId, like, like, like,
    ).map(map);
  }
}

export const registry: MemberRegistryAdapter = new LocalRegistryAdapter();
