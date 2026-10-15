import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(userId: string | null, action: string, entity: string, entityId?: string, data?: unknown) {
    await this.prisma.auditLog.create({
      data: { userId, action, entity, entityId, data: data === undefined ? undefined : (data as any) },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
