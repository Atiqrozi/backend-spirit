import { Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { DocumentProcessingService } from './documents.service';

class DocumentDto { @IsString() title: string; @IsOptional() @IsString() number?: string; @IsOptional() @IsString() category?: string; @IsOptional() @IsString() description?: string; }

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentProcessingService) {}

  @Get() list(@Query() query: any) { return this.service.list(query); }
  @Post() @Roles(Role.ADMIN_SPI) create(@Body() dto: DocumentDto, @Req() req: any) { return this.service.create(dto, req.user); }
  @Get(':id/versions') versions(@Param('id') id: string) { return this.service.listVersions(id); }
  @Get(':id') getStatus(@Param('id') id: string) { return this.service.status(id); }
  @Get(':id/process-status') processStatus(@Param('id') id: string) { return this.service.status(id); }

  @Post(':id/versions')
  @Roles(Role.ADMIN_SPI)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20971520) }, fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) }))
  @ApiConsumes('multipart/form-data')
  addVersion(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body() dto: any, @Req() req: any) {
    if (!file) throw new BadRequestException('File PDF/JPG/PNG wajib diunggah');
    return this.service.addVersion(id, file, dto, req.user);
  }

  @Post(':id/publish')
  @Roles(Role.ADMIN_SPI)
  publish(@Param('id') id: string, @Req() req: any) { return this.service.publish(id, req.user.sub); }

  @Post(':id/reprocess')
  @Roles(Role.ADMIN_SPI)
  reprocess(@Param('id') id: string) { return this.service.reprocess(id); }
}
