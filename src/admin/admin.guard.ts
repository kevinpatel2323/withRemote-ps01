import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bearer-token guard for /admin/* and /internal/* (PLAN §8/§9). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const header = req.headers['authorization'] ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || token !== expected) {
      throw new UnauthorizedException('invalid admin token');
    }
    return true;
  }
}
