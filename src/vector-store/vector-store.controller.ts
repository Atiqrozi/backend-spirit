import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';
import { VectorStoreService } from './vector-store.service';

class ChunkDto {
  @IsString() @MinLength(1) chunkId: string;
  @IsString() @MinLength(1) @MaxLength(50000) text: string;
  @IsInt() @Min(1) pageStart: number;
  @IsInt() @Min(1) pageEnd: number;
  @IsOptional() @IsString() section?: string;
  @IsInt() @Min(0) ordinal: number;
}
class IndexChunksDto {
  @IsString() @MinLength(1) documentId: string;
  @IsString() @MinLength(1) documentVersionId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(256) @ValidateNested({ each: true }) @Type(() => ChunkDto) chunks: ChunkDto[];
}
class SearchFiltersDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) documentIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) documentVersionIds?: string[];
}
class SearchDto {
  @IsString() @MinLength(1) @MaxLength(8000) query: string;
  @IsOptional() @ValidateNested() @Type(() => SearchFiltersDto) filters?: SearchFiltersDto;
  @IsOptional() @IsInt() @Min(1) @Max(100) topK?: number;
  @IsOptional() @IsBoolean() rerank?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(50) rerankTopN?: number;
}

@ApiTags('Vector Search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class VectorStoreController {
  constructor(private readonly vectorStore: VectorStoreService) {}

  @Post('indexing/chunks')
  @Roles(Role.ADMIN_SPI)
  async index(@Body() dto: IndexChunksDto, @Req() req: any, @Headers('x-request-id') requestId?: string) {
    const result = await this.vectorStore.indexChunks(dto, req.user.sub, 'DRAFT');
    return { ...result, requestId: requestId || randomUUID() };
  }

  @Post('retrieval/search')
  async search(@Body() dto: SearchDto, @Headers('x-request-id') requestId?: string) {
    const result = await this.vectorStore.search(dto);
    return { ...result, requestId: requestId || randomUUID() };
  }
}
