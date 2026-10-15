import { AssetKind, AssetSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ListAssetsQuery {
  @IsOptional() @IsEnum(AssetKind) kind?: AssetKind;
  @IsOptional() @IsString() folder?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}

export class ExternalAssetDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] }) url: string;
  @IsEnum(AssetKind) kind: AssetKind;
}

export class ImportUrlDto {
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] }) url: string;
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsEnum(AssetKind) kind?: AssetKind;
  @IsOptional() @IsEnum(AssetSource) source?: AssetSource;
  @IsOptional() @IsString() @MaxLength(120) folder?: string;
}

export class InitUploadDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(120) mime?: string;
  @IsEnum(AssetKind) kind: AssetKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4 * 1024 * 1024 * 1024) totalBytes?: number;
}

export class CompleteUploadDto {
  /** SHA-256 of the assembled file, in hex. Optional but recommended. */
  @IsOptional() @IsString() @MaxLength(64) checksumSha256?: string;
}
