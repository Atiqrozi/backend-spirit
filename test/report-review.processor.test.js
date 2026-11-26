const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ReportReviewProcessor } = require('../dist/reports/report-review.processor');

function query(value) {
  return { sort() { return this; }, select() { return this; }, lean: async () => value };
}

describe('ReportReviewProcessor integration with mocked providers and repositories', () => {
  it('pins the report version, validates citations, and persists separate recommendation categories', async () => {
    const chunkId = 'chunk-verified-1';
    const reportEvidenceText = 'Pemeriksaan rekam medis dilakukan pada bulan Mei.';
    const report = { _id: 'report-1', data: { title: 'Laporan SPI' } };
    const version = { _id: 'version-1', version: 3, status: 'EXTRACTED', data: {} };
    const persisted = { findings: [], sources: [], recommendations: [], reviewUpdates: [], reportUpdates: [] };
    const models = {
      reports: { updateOne: async (...args) => { persisted.reportUpdates.push(args); } },
      reportVersions: { findOne: () => ({ lean: async () => version }) },
      templateVersions: {},
      reviews: { findOneAndUpdate: async (_filter, update) => { persisted.reviewUpdates.push(update); return { _id: 'review-1' }; }, updateOne: async (_filter, update) => { persisted.reviewUpdates.push(update); } },
      findings: {
        deleteMany: async () => {},
        insertMany: async (rows) => { persisted.findings = rows.map((row, index) => ({ ...row, _id: `finding-${index}` })); return persisted.findings; },
      },
      sourcesModel: { deleteMany: async () => {}, insertMany: async (rows) => { persisted.sources.push(...rows); } },
      pages: { find: () => query([{ pageNumber: 1, text: reportEvidenceText }]) },
      recommendations: { deleteMany: async () => {}, insertMany: async (rows) => { persisted.recommendations.push(...rows); } },
    };
    const vectorStore = { search: async () => ({ embeddingModel: 'embed-test', rerankModel: 'rerank-test', sources: [{
      chunkId, documentId: 'regulation-1', documentVersionId: 'regulation-version-1', pageStart: 4, pageEnd: 4,
      section: 'Pasal 2', text: 'Rekam medis wajib didokumentasikan.',
    }] }) };
    const response = { choices: [{ message: { content: JSON.stringify({
      summary: 'Perlu verifikasi dokumen pendukung.', limitations: ['Konteks terbatas'],
      regulationAssessments: [{ documentId: 'regulation-1', documentVersionId: 'regulation-version-1', status: 'PARTIALLY_COMPLIANT', summary: 'Belum cukup bukti.', sourceChunkIds: [chunkId, 'fake-chunk'] }],
      findings: [{ title: 'Bukti belum lengkap', description: 'Perlu pemeriksaan manual.', priority: 'HIGH', complianceStatus: 'PARTIALLY_COMPLIANT', confidence: 0.7, sourceChunkIds: [chunkId, 'fake-chunk'], reportEvidence: [
        { pageNumber: 1, quote: 'dilakukan pada bulan Mei' }, { pageNumber: 9, quote: 'kutipan karangan' },
      ] }],
      reportRecommendations: [{ title: 'Lengkapi laporan', description: 'Lampirkan bukti.', rationale: 'Bukti kurang.', action: 'Lampirkan dokumen.', priority: 'MEDIUM', sourceChunkIds: [chunkId] }],
      inspectionRecommendations: [{ title: 'Verifikasi ulang', description: 'Pastikan monitoring.', rationale: 'Data tidak cukup.', action: 'Periksa jadwal.', priority: 'LOW', needsVerification: true }],
    }) } }] };
    const nvidia = { review: async () => response };
    const processor = new ReportReviewProcessor(
      { updateOne: async (...args) => persisted.reportUpdates.push(args), findById: () => query(report) },
      models.reportVersions, models.templateVersions, models.reviews, models.findings, models.sourcesModel,
      models.pages, models.recommendations, nvidia, vectorStore,
    );
    const result = await processor.process({
      id: 'job-1', data: { reportId: 'report-1', reportVersionId: 'version-1', reviewId: 'review-1', userId: 'user-1' },
      opts: { attempts: 3 }, attemptsMade: 0,
    });

    assert.equal(result.reviewId, 'review-1');
    assert.equal(persisted.findings[0].complianceStatus, 'PARTIALLY_COMPLIANT');
    assert.deepEqual(persisted.findings[0].sourceChunkIds, [chunkId]);
    assert.deepEqual(persisted.findings[0].reportEvidence, [{ pageNumber: 1, quote: 'dilakukan pada bulan Mei' }]);
    assert.equal(persisted.sources[0].documentVersionId, 'regulation-version-1');
    assert.deepEqual(persisted.recommendations.map((item) => item.type), ['REPORT_IMPROVEMENT', 'INSPECTION_IMPROVEMENT']);
    assert.equal(persisted.recommendations[1].status, 'NEEDS_VERIFICATION');
    assert.equal(persisted.reviewUpdates.at(-1).$set['data.status'], 'AI_REVIEW_COMPLETED');
  });
});
