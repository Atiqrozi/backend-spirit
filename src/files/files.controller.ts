import { Controller, Get, Header, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ImageKitService } from './imagekit.service';

@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('files')
export class FilesController {
  constructor(
    @InjectModel('DocumentVersion') private readonly documentVersions: Model<any>,
    private readonly imageKit: ImageKitService,
  ) {}

  @Get(':fileId/access')
  @Header('Cache-Control', 'no-store')
  async access(@Param('fileId') fileId: string, @Query('disposition') disposition = 'inline') {
    if (!['inline', 'attachment'].includes(disposition)) throw new NotFoundException('File tidak ditemukan');
    const version: any = await this.documentVersions.findOne({ 'data.file.fileId': fileId })
      .select('data.file.fileId data.file.filePath data.file.fileName data.file.mimeType')
      .lean();
    const file = version?.data?.file;
    if (!file?.filePath) throw new NotFoundException('File tidak ditemukan');

    const expiresInSeconds = 300;
    const url = this.imageKit.createSignedUrl(file.filePath, expiresInSeconds);
    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      fileName: file.fileName,
      mimeType: file.mimeType,
    };
  }
}
