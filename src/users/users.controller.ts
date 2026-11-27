import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './user.schema';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/roles';

class CreateUserDto {
  @IsString() name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsString() unit?: string;
}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(@InjectModel(User.name) private users: Model<UserDocument>) {}

  @Get()
  @Roles(Role.ADMIN_SPI)
  async list(@Query('page') page = '1', @Query('limit') limit = '20') {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(1, Number(limit) || 20), 100);
    const [items, total] = await Promise.all([
      this.users.find().select('-passwordHash -refreshTokenHash').skip((p - 1) * size).limit(size).lean(),
      this.users.countDocuments(),
    ]);
    return { items, page: p, limit: size, total };
  }

  @Get('assignees')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async assignees(@Query('page') page = '1', @Query('limit') limit = '100') {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(1, Number(limit) || 100), 100);
    const filter = { active: true, role: Role.ANGGOTA_SPI };
    const [items, total] = await Promise.all([
      this.users.find(filter).select('_id name email role unit').sort({ name: 1 }).skip((p - 1) * size).limit(size).lean(),
      this.users.countDocuments(filter),
    ]);
    return { items, page: p, limit: size, total };
  }

  @Get('units')
  @Roles(Role.ADMIN_SPI, Role.PIMPINAN_SPI)
  async units(@Query('page') page = '1', @Query('limit') limit = '100') {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(1, Number(limit) || 100), 100);
    const values = await this.users.distinct('unit', { active: true, unit: { $type: 'string', $ne: '' } });
    const items = values.filter((unit): unit is string => typeof unit === 'string' && !!unit.trim()).sort((a, b) => a.localeCompare(b, 'id'));
    return { items: items.slice((p - 1) * size, p * size).map((name) => ({ _id: name, name })), page: p, limit: size, total: items.length };
  }

  @Post()
  @Roles(Role.ADMIN_SPI)
  async create(@Body() d: CreateUserDto) {
    const user = await this.users.create({ name: d.name, email: d.email.toLowerCase(), unit: d.unit?.trim() || undefined, passwordHash: await bcrypt.hash(d.password, 12), role: d.role || Role.ANGGOTA_SPI });
    return { id: user.id, name: user.name, email: user.email, role: user.role, unit: user.unit };
  }

  @Patch(':id')
  @Roles(Role.ADMIN_SPI)
  update(@Param('id') id: string, @Body() body: Partial<CreateUserDto>) {
    const { password, ...patch } = body as any;
    if (typeof patch.unit === 'string') patch.unit = patch.unit.trim() || undefined;
    return this.users.findByIdAndUpdate(id, { ...patch, ...(password ? { passwordHash: bcrypt.hashSync(password, 12) } : {}) }, { new: true }).select('-passwordHash -refreshTokenHash');
  }
}
