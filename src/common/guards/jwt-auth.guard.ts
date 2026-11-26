import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}
  canActivate(context: ExecutionContext): boolean { const req = context.switchToHttp().getRequest(); const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); if (!token) throw new UnauthorizedException(); try { req.user = this.jwt.verify(token, { secret: process.env.JWT_ACCESS_SECRET }); return true; } catch { throw new UnauthorizedException('Token tidak valid atau kedaluwarsa'); } }
}
