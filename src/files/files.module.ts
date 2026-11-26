import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DomainSchema } from '../common/domain.schema';
import { FilesController } from './files.controller';
import { ImageKitService } from './imagekit.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'DocumentVersion', schema: DomainSchema, collection: 'document_versions' }])],
  controllers: [FilesController],
  providers: [ImageKitService],
  exports: [ImageKitService],
})
export class FilesModule {}
