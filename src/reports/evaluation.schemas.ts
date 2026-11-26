import { Schema } from 'mongoose';

const timestamps = { timestamps: true, minimize: false } as const;

export const ReportReviewSchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportVersionId: { type: Schema.Types.ObjectId, default: null, index: true },
  templateVersionId: { type: Schema.Types.ObjectId, default: null },
  reviewerId: { type: String, required: true },
  jobId: { type: String, sparse: true, unique: true },
  status: { type: String, default: 'PROCESSING', index: true },
  data: { type: Schema.Types.Mixed, default: {} },
}, { ...timestamps, strict: false, collection: 'report_reviews' });
ReportReviewSchema.index({ reportId: 1, createdAt: -1 });
ReportReviewSchema.index({ reportVersionId: 1, createdAt: -1 });

export const ReviewFindingSchema = new Schema({
  reviewId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  title: { type: String, required: true }, description: { type: String, default: '' },
  priority: { type: String, default: 'MEDIUM', index: true }, complianceStatus: { type: String, default: 'NOT_ASSESSABLE', index: true },
  reasoning: { type: String, default: '' }, suggestion: { type: String, default: '' }, confidence: { type: Number, default: null },
  reportEvidence: { type: [Schema.Types.Mixed], default: [] }, sourceChunkIds: { type: [String], default: [] },
  sourceVerification: { type: String, default: 'NO_VERIFIABLE_SOURCE' }, invalidSourceReferencesDropped: { type: Boolean, default: false },
  humanReview: { type: Schema.Types.Mixed, default: {} },
}, { ...timestamps, strict: false, collection: 'review_findings' });
ReviewFindingSchema.index({ reviewId: 1, createdAt: 1 });
ReviewFindingSchema.index({ reportId: 1, reviewId: 1 });

export const ReviewSourceSchema = new Schema({
  reviewId: { type: Schema.Types.ObjectId, required: true, index: true },
  findingId: { type: Schema.Types.ObjectId, default: null, index: true },
  chunkId: { type: String, required: true }, documentId: { type: Schema.Types.ObjectId, required: true, index: true },
  documentVersionId: { type: Schema.Types.ObjectId, required: true, index: true },
  pageStart: { type: Number, required: true }, pageEnd: { type: Number, required: true }, section: { type: String, default: null }, text: { type: String, required: true },
}, { ...timestamps, strict: false, collection: 'review_sources' });
ReviewSourceSchema.index({ reviewId: 1, chunkId: 1 });
ReviewSourceSchema.index({ documentVersionId: 1, pageStart: 1 });

export const ApprovalSchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  decision: { type: String, required: true, index: true }, note: { type: String, default: '' }, reviewerId: { type: Schema.Types.ObjectId, required: true },
}, { ...timestamps, strict: false, collection: 'approvals' });
ApprovalSchema.index({ reportId: 1, createdAt: -1 });

export const RecommendationSchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportVersionId: { type: Schema.Types.ObjectId, required: true, index: true },
  reviewId: { type: Schema.Types.ObjectId, required: true, index: true },
  findingId: { type: Schema.Types.ObjectId, default: null, index: true },
  type: { type: String, enum: ['REPORT_IMPROVEMENT', 'INSPECTION_IMPROVEMENT'], required: true, index: true },
  title: { type: String, required: true, maxlength: 500 },
  description: { type: String, required: true, maxlength: 8000 },
  rationale: { type: String, default: '', maxlength: 4000 },
  action: { type: String, default: '', maxlength: 4000 },
  priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' },
  status: { type: String, enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_VERIFICATION'], default: 'PENDING_REVIEW', index: true },
  verificationStatus: { type: String, enum: ['SUPPORTED', 'NEEDS_VERIFICATION'], default: 'SUPPORTED' },
  reportEvidence: { type: [Schema.Types.Mixed], default: [] },
  regulationSources: { type: [Schema.Types.Mixed], default: [] },
  sourceChunkIds: { type: [String], default: [] },
  reviewedBy: { type: Schema.Types.ObjectId, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: '', maxlength: 4000 },
  createdBy: { type: String, default: 'ai' },
}, timestamps);
RecommendationSchema.index({ reviewId: 1, type: 1, createdAt: -1 });

export const HumanEvaluationSchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportVersionId: { type: Schema.Types.ObjectId, required: true, index: true },
  reviewId: { type: Schema.Types.ObjectId, default: null, index: true },
  reviewerId: { type: Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ['IN_PROGRESS', 'APPROVED', 'REVISION_REQUIRED'], default: 'IN_PROGRESS', index: true },
  note: { type: String, default: '', maxlength: 10000 },
  findingDecisions: { type: [Schema.Types.Mixed], default: [] },
  decisionAt: { type: Date, default: null },
}, timestamps);
HumanEvaluationSchema.index({ reportId: 1, createdAt: -1 });

export const FollowUpSchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  reportVersionId: { type: Schema.Types.ObjectId, required: true, index: true },
  reviewId: { type: Schema.Types.ObjectId, required: true, index: true },
  evaluationId: { type: Schema.Types.ObjectId, default: null, index: true },
  recommendationId: { type: Schema.Types.ObjectId, required: true, unique: true },
  taskId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
  status: { type: String, enum: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_VERIFICATION', 'REVISION_REQUIRED', 'COMPLETED', 'REJECTED'], default: 'OPEN', index: true },
  assigneeId: { type: Schema.Types.ObjectId, default: null, index: true },
  dueDate: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  verifiedBy: { type: Schema.Types.ObjectId, default: null },
  verifiedAt: { type: Date, default: null },
}, timestamps);
FollowUpSchema.index({ reportId: 1, createdAt: -1 });

export const FollowUpEvidenceSchema = new Schema({
  followUpId: { type: Schema.Types.ObjectId, required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, required: true, index: true },
  file: { type: Schema.Types.Mixed, required: true },
  description: { type: String, default: '', maxlength: 2000 },
  uploadedBy: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['SUBMITTED', 'ACCEPTED', 'REJECTED'], default: 'SUBMITTED' },
  verifiedBy: { type: Schema.Types.ObjectId, default: null },
  verificationNote: { type: String, default: '', maxlength: 4000 },
}, timestamps);
FollowUpEvidenceSchema.index({ followUpId: 1, createdAt: -1 });

export const EvaluationHistorySchema = new Schema({
  reportId: { type: Schema.Types.ObjectId, required: true, index: true },
  followUpId: { type: Schema.Types.ObjectId, default: null, index: true },
  taskId: { type: Schema.Types.ObjectId, default: null, index: true },
  evaluationId: { type: Schema.Types.ObjectId, default: null, index: true },
  actorId: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, required: true, index: true },
  fromStatus: { type: String, default: null },
  toStatus: { type: String, default: null },
  note: { type: String, default: '', maxlength: 4000 },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { ...timestamps, versionKey: false });
EvaluationHistorySchema.index({ reportId: 1, createdAt: -1 });

