import { Module } from '@nestjs/common'; import { MongooseModule } from '@nestjs/mongoose'; import { DomainSchema } from '../common/domain.schema'; import { AuditLogsController } from './audit-logs.controller';
@Module({imports:[MongooseModule.forFeature([{name:'AuditLog',schema:DomainSchema,collection:'audit_logs'}])],controllers:[AuditLogsController]}) export class AuditLogsModule {}
