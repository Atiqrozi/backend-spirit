import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { DocumentsController } from './documents.controller';
import { DocumentProcessingService } from './documents.service';
import { DomainSchema } from '../common/domain.schema';
import { FilesModule } from '../files/files.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { DocumentExtractionProcessor } from './document-extraction.processor';
import { TextChunkerService } from './text-chunker.service';
@Module({imports:[MongooseModule.forFeature([{name:'ReferenceDocument',schema:DomainSchema,collection:'reference_documents'},{name:'DocumentVersion',schema:DomainSchema,collection:'document_versions'},{name:'ReportVersion',schema:DomainSchema,collection:'report_versions'},{name:'Report',schema:DomainSchema,collection:'reports'},{name:'DocumentPage',schema:DomainSchema,collection:'document_pages'}]),BullModule.registerQueue({name:'document-extraction'}),FilesModule,VectorStoreModule],controllers:[DocumentsController],providers:[DocumentProcessingService,DocumentExtractionProcessor,TextChunkerService]}) export class DocumentsModule {}
