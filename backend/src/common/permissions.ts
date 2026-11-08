export type Role = 'admin' | 'support' | 'auditor';

/** Fixed permission list (T-006). Checked on the server for every endpoint. */
export const PERMISSIONS = [
  'staff.view', 'staff.manage', 'roles.view',
  'drivers.view', 'drivers.review', 'documents.view',
  'settings.view', 'settings.edit',
  'trips.suspend', 'bookings.view',
  'cases.handle', 'records.correct', 'records.request_correction', 'cash.correct',
  'audit.view', 'reports.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  // Auditor: view only, plus audit (ADR 0008)
  auditor: ['staff.view', 'roles.view', 'drivers.view', 'documents.view', 'settings.view', 'bookings.view', 'audit.view', 'reports.view'],
  // Support: cases, view bookings, request corrections
  support: ['roles.view', 'drivers.view', 'documents.view', 'settings.view', 'bookings.view', 'cases.handle', 'records.request_correction'],
};

/** staff.manage is further limited to the main admin in the service layer. */
export function can(role: Role | null, p: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(p);
}
