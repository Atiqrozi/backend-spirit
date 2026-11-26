import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(@InjectConnection() private readonly db: Connection) {}
  @Get('health') health() { return { status: 'ok', timestamp: new Date().toISOString() }; }
  @Get('ready') ready() { return { status: this.db.readyState === 1 ? 'ready' : 'not_ready', database: this.db.readyState === 1 }; }
}
