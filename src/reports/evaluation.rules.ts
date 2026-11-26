import { Role } from '../common/roles';

export const COMPLIANCE_STATUSES = ['COMPLIANT', 'NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'NOT_ASSESSABLE'] as const;
export const FOLLOW_UP_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_VERIFICATION', 'REVISION_REQUIRED', 'COMPLETED', 'REJECTED'] as const;

export function normalizeComplianceStatus(value: unknown) {
  const normalized = String(value || '').toUpperCase();
  return (COMPLIANCE_STATUSES as readonly string[]).includes(normalized) ? normalized : 'NOT_ASSESSABLE';
}

export function validateReportEvidence(items: Array<{ pageNumber?: number; quote?: string }> = [], pageText: Map<number, string>) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).flatMap((item) => {
    const pageNumber = Number(item?.pageNumber);
    const quote = String(item?.quote || '').trim().slice(0, 1000);
    const sourceText = pageText.get(pageNumber);
    return sourceText && quote && sourceText.includes(quote) ? [{ pageNumber, quote }] : [];
  });
}

export function canTransitionFollowUpStatus(from: string, to: string) {
  const allowed: Record<string, string[]> = {
    OPEN: ['ASSIGNED', 'IN_PROGRESS'],
    ASSIGNED: ['IN_PROGRESS', 'SUBMITTED'],
    IN_PROGRESS: ['SUBMITTED'],
    SUBMITTED: ['UNDER_VERIFICATION'],
    UNDER_VERIFICATION: ['COMPLETED', 'REVISION_REQUIRED', 'REJECTED'],
    REVISION_REQUIRED: ['IN_PROGRESS', 'SUBMITTED'],
    COMPLETED: [], REJECTED: [],
  };
  return allowed[from]?.includes(to) || false;
}

export function canAccessFollowUp(role: string, userId: string, assigneeId?: string | null) {
  return role === Role.ADMIN_SPI || role === Role.PIMPINAN_SPI || (role === Role.ANGGOTA_SPI && String(assigneeId || '') === userId);
}

export function canCreateFollowUpFromRecommendation(status: string, verificationStatus: string) {
  return status === 'APPROVED' && verificationStatus === 'SUPPORTED';
}
