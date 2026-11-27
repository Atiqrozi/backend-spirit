import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { DomainSchema } from '../common/domain.schema';
import { FilesModule } from '../files/files.module';
import { User, UserSchema } from '../users/user.schema';
import { FollowUpSchema, RecommendationSchema, ReportReviewSchema } from '../reports/evaluation.schemas';
import { MemoSchema } from './memo.schema';
import { MemosController } from './memos.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Memo', schema: MemoSchema },
      { name: 'Report', schema: DomainSchema, collection: 'reports' },
      { name: 'ReportVersion', schema: DomainSchema, collection: 'report_versions' },
      { name: 'DocumentPage', schema: DomainSchema, collection: 'document_pages' },
      { name: 'Review', schema: ReportReviewSchema, collection: 'report_reviews' },
      { name: 'Recommendation', schema: RecommendationSchema, collection: 'ai_recommendations' },
      { name: 'FollowUp', schema: FollowUpSchema, collection: 'follow_up_actions' },
      { name: 'Task', schema: DomainSchema, collection: 'tasks' },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: 'document-extraction' }, { name: 'report-review' }),
    FilesModule,
  ],
  controllers: [MemosController],
})
export class MemosModule {}
