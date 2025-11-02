import {
  BadRequestException,
  Injectable,
  Scope,
  Inject,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Request-scoped accessor that exposes the resolved tenant for the current
 * request. Guards populate `req.tenantId` and the context normalizes access
 * for services without forcing controllers to thread the ID through.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  private resolved?: string | null;

  constructor(@Inject(REQUEST) private readonly request: Request) {}

  /**
   * Returns the tenant id for the current request. Throws when missing so
   * downstream code does not silently operate on the wrong database.
   */
  get tenantId(): string {
    const existing = this.tryGetTenantId();
    if (!existing) {
      throw new BadRequestException('Missing tenant id (x-tenant-id header)');
    }
    return existing;
  }

  /**
   * Sets the tenant id when a guard or interceptor resolves it. This keeps the
   * context in sync even when the header is absent (e.g. internal calls).
   */
  setTenantId(id: string) {
    this.resolved = id;
    (this.request as any).tenantId = id;
  }

  /**
   * Returns the tenant id if available, otherwise undefined.
   */
  tryGetTenantId(): string | undefined {
    if (this.resolved) return this.resolved;

    const fromReq = (this.request as any).tenantId;
    if (typeof fromReq === 'string' && fromReq.trim()) {
      this.resolved = fromReq.trim();
      return this.resolved;
    }

    const header = this.request.headers['x-tenant-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (typeof headerValue === 'string' && headerValue.trim()) {
      this.resolved = headerValue.trim();
      (this.request as any).tenantId = this.resolved;
      return this.resolved;
    }

    return undefined;
  }
}
