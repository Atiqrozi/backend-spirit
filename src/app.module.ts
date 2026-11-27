import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { TemplatesModule } from './templates/templates.module';
import { ReportsModule } from './reports/reports.module';
import { TasksModule } from './tasks/tasks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { FilesModule } from './files/files.module';
import { VectorStoreModule } from './vector-store/vector-store.module';
import { MemosModule } from './memos/memos.module';

function getRedisConnection() {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    const parsed = new URL(redisUrl);
    const database = parsed.pathname.replace(/^\//, '');
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'rediss:' ? 6380 : 6379)),
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: database ? Number(database) : undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }

  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), MongooseModule.forRoot(process.env.MONGODB_URI || 'mongodb://localhost:27017/spi_compliance'), BullModule.forRoot({ connection: getRedisConnection() }), ScheduleModule.forRoot(), ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), AuthModule, UsersModule, DocumentsModule, TemplatesModule, ReportsModule, TasksModule, MemosModule, NotificationsModule, DashboardModule, AuditLogsModule, FilesModule, VectorStoreModule], controllers: [HealthController] })
export class AppModule {}
