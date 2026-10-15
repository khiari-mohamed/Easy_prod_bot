import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { getEnv } from '../env';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from './assets.service';
import { PART_SIZE_BYTES, UploadSessionService } from './upload-session.service';
import { CompleteUploadDto, ExternalAssetDto, ImportUrlDto, InitUploadDto, ListAssetsQuery } from './assets.dto';
import { MAX_DIRECT_BYTES } from './assets.constants';

function tmpDir(): string {
  const dir = getEnv().UPLOAD_TMP_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reads an unparsed request body into a Buffer, refusing oversized payloads. */
async function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BadRequestException(`Part exceeds the ${maxBytes} byte limit`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly sessions: UploadSessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query() q: ListAssetsQuery) {
    return this.assets.list(q);
  }

  /** Direct multipart upload for files up to MAX_DIRECT_BYTES. */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, tmpDir()),
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_DIRECT_BYTES },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('No file received (field name: file)');
    return this.assets.uploadDirect(file.path, file.originalname, file.mimetype, user);
  }

  /** Import from a Google Drive / Dropbox / any HTTPS direct link. */
  @Post('import-url')
  importUrl(@Body() dto: ImportUrlDto, @CurrentUser() user: AuthUser) {
    return this.assets.importUrl(dto, user);
  }

  /** Register an already-hosted asset without copying it (advanced). */
  @Post()
  @Roles(Role.APPROVER)
  async createExternal(@Body() dto: ExternalAssetDto, @CurrentUser() user: AuthUser) {
    const asset = await this.prisma.asset.create({
      data: { name: dto.name, url: dto.url, kind: dto.kind, processingStatus: 'READY', source: 'UPLOAD' },
    });
    await this.audit.log(user.id, 'asset.createExternal', 'Asset', asset.id, { url: dto.url });
    return asset;
  }

  // ── Resumable uploads ──────────────────────────────────────────────────────

  @Post('uploads')
  init(@Body() dto: InitUploadDto, @CurrentUser() user: AuthUser) {
    return this.sessions.init(dto, user);
  }

  @Put('uploads/:id/parts/:index')
  async uploadPart(
    @Param('id') id: string,
    @Param('index') index: string,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    const partIndex = Number(index);
    if (!Number.isInteger(partIndex) || partIndex < 0) throw new BadRequestException('Invalid part index');
    const body = await readRawBody(req, PART_SIZE_BYTES);
    if (!body.length) throw new BadRequestException('Empty part');
    return this.sessions.putPart(id, partIndex, body, user);
  }

  @Post('uploads/:id/complete')
  complete(@Param('id') id: string, @Body() dto: CompleteUploadDto, @CurrentUser() user: AuthUser) {
    return this.sessions.complete(id, dto, user);
  }

  @Delete('uploads/:id')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.cancel(id, user);
  }

  @Post(':id/reprocess')
  @Roles(Role.APPROVER)
  reprocess(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.assets.reprocess(id, user);
  }

  @Delete(':id')
  @Roles(Role.APPROVER)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.assets.remove(id, user);
  }
}
