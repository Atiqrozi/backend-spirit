import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { DomainSchema } from '../common/domain.schema';
import { ReportsController } from './reports.controller';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { ReportReviewProcessor } from './report-review.processor';
import { FilesModule } from '../files/files.module';
import { ApprovalSchema, FollowUpEvidenceSchema, FollowUpSchema, HumanEvaluationSchema, EvaluationHistorySchema, RecommendationSchema, ReportReviewSchema, ReviewFindingSchema, ReviewSourceSchema } from './evaluation.schemas';
import { ReportEvaluationController } from './report-evaluation.controller';
import { User, UserSchema } from '../users/user.schema';
@Module({imports:[MongooseModule.forFeature([{name:'Report',schema:DomainSchema,collection:'reports'},{name:'ReportVersion',schema:DomainSchema,collection:'report_versions'},{name:'ReportTemplateVersion',schema:DomainSchema,collection:'report_template_versions'},{name:'Review',schema:ReportReviewSchema,collection:'report_reviews'},{name:'ReviewFinding',schema:ReviewFindingSchema,collection:'review_findings'},{name:'ReviewSource',schema:ReviewSourceSchema,collection:'review_sources'},{name:'DocumentPage',schema:DomainSchema,collection:'document_pages'},{name:'Approval',schema:ApprovalSchema,collection:'approvals'},{name:'Recommendation',schema:RecommendationSchema,collection:'ai_recommendations'},{name:'HumanEvaluation',schema:HumanEvaluationSchema,collection:'human_evaluations'},{name:'FollowUp',schema:FollowUpSchema,collection:'follow_up_actions'},{name:'FollowUpEvidence',schema:FollowUpEvidenceSchema,collection:'follow_up_evidence'},{name:'EvaluationHistory',schema:EvaluationHistorySchema,collection:'evaluation_history'},{name:'Task',schema:DomainSchema,collection:'tasks'},{name:User.name,schema:UserSchema}]),BullModule.registerQueue({name:'report-review'},{name:'document-extraction'}),VectorStoreModule,FilesModule],controllers:[ReportsController,ReportEvaluationController],providers:[ReportReviewProcessor]}) export class ReportsModule {}
