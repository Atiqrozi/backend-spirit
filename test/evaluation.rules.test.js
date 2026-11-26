const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canAccessFollowUp,
  canCreateFollowUpFromRecommendation,
  canTransitionFollowUpStatus,
  normalizeComplianceStatus,
  validateReportEvidence,
} = require('../dist/reports/evaluation.rules');
const { RolesGuard } = require('../dist/common/guards/roles.guard');

describe('SPI evaluation and follow-up rules', () => {
  it('normalizes unknown AI compliance labels to NOT_ASSESSABLE', () => {
    assert.equal(normalizeComplianceStatus('non_compliant'), 'NON_COMPLIANT');
    assert.equal(normalizeComplianceStatus('invented'), 'NOT_ASSESSABLE');
  });

  it('keeps only report quotes found on the cited page', () => {
    const pages = new Map([[2, 'Monitoring dilakukan setiap bulan dan dicatat.']]);
    assert.deepEqual(validateReportEvidence([
      { pageNumber: 2, quote: 'dilakukan setiap bulan' },
      { pageNumber: 9, quote: 'dilakukan setiap bulan' },
      { pageNumber: 2, quote: 'kutipan yang tidak ada' },
    ], pages), [{ pageNumber: 2, quote: 'dilakukan setiap bulan' }]);
  });

  it('allows follow-up creation only from approved and verified recommendations', () => {
    assert.equal(canCreateFollowUpFromRecommendation('APPROVED', 'SUPPORTED'), true);
    assert.equal(canCreateFollowUpFromRecommendation('APPROVED', 'NEEDS_VERIFICATION'), false);
    assert.equal(canCreateFollowUpFromRecommendation('PENDING_REVIEW', 'SUPPORTED'), false);
  });

  it('enforces follow-up status transitions and prevents reopening completed tasks', () => {
    assert.equal(canTransitionFollowUpStatus('ASSIGNED', 'IN_PROGRESS'), true);
    assert.equal(canTransitionFollowUpStatus('SUBMITTED', 'UNDER_VERIFICATION'), true);
    assert.equal(canTransitionFollowUpStatus('UNDER_VERIFICATION', 'COMPLETED'), true);
    assert.equal(canTransitionFollowUpStatus('COMPLETED', 'IN_PROGRESS'), false);
    assert.equal(canTransitionFollowUpStatus('OPEN', 'COMPLETED'), false);
  });

  it('limits member access to assigned follow-ups', () => {
    assert.equal(canAccessFollowUp('ANGGOTA_SPI', 'u1', 'u1'), true);
    assert.equal(canAccessFollowUp('ANGGOTA_SPI', 'u1', 'u2'), false);
    assert.equal(canAccessFollowUp('PIMPINAN_SPI', 'u3', null), true);
  });

  it('enforces declared role metadata at the API guard', () => {
    const guard = new RolesGuard({ getAllAndOverride: () => ['PIMPINAN_SPI', 'ADMIN_SPI'] });
    const context = (role) => ({
      getHandler: () => function handler() {}, getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    });
    assert.equal(guard.canActivate(context('PIMPINAN_SPI')), true);
    assert.equal(guard.canActivate(context('ADMIN_SPI')), true);
    assert.throws(() => guard.canActivate(context('ANGGOTA_SPI')), (error) => error.getStatus() === 403);
  });
});
