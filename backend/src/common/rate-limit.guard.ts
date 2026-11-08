import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from './errors';

export const RATE = 'rate_limit';
/** e.g. @RateLimit(60) → 60 requests per minute per IP for this endpoint (SEC-001). */
export const RateLimit = (perMinute: number) => SetMetadata(RATE, perMinute);

/** Simple in-memory limiter (one API instance on staging). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private hits = new Map<string, number[]>();
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const limit = this.reflector.get<number | undefined>(RATE, ctx.getHandler());
    if (!limit) return true;
    const req = ctx.switchToHttp().getRequest();
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${req.ip}`;
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= limit) throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS', 'Too many requests. Please wait a minute and try again.');
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.clear();
    return true;
  }
}
