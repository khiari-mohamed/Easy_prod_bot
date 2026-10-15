import { CaptionLanguage, Platform, PostFormat, PostStatus, PublishMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePostDto {
  @IsOptional() @IsString() dayId?: string;
  @IsOptional() @IsString() contentItemId?: string;
  @IsEnum(Platform) platform: Platform;
  @IsEnum(PostFormat) format: PostFormat;
  @IsString() @MaxLength(5000) caption: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) hashtags?: string[];
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsEnum(PublishMode) publishMode?: PublishMode;
  @IsOptional() @IsEnum(CaptionLanguage) captionLanguage?: CaptionLanguage;
}

export class UpdatePostDto {
  @IsOptional() @IsEnum(PostFormat) format?: PostFormat;
  @IsOptional() @IsString() @MaxLength(5000) caption?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) hashtags?: string[];
  @IsOptional() @IsString() assetId?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  @IsOptional() @IsEnum(PublishMode) publishMode?: PublishMode;
  @IsOptional() @IsEnum(CaptionLanguage) captionLanguage?: CaptionLanguage;
}

export class ListPostsQuery {
  @IsOptional() @IsEnum(PostStatus) status?: PostStatus;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
  @IsOptional() @IsString() dayId?: string;
  @IsOptional() @IsString() contentItemId?: string;
}

export class RejectDto {
  @IsString() @MaxLength(500) reason: string;
}

export class RescheduleDto {
  @IsDateString() scheduledAt: string;
}

/** Publish now must be an explicit, deliberate API call: the body has to say so. */
export class PublishNowDto {
  @Equals(true, { message: 'confirm must be true to publish now' }) confirm: boolean;
}

export class MarkPublishedDto {
  @IsOptional() @IsUrl({ require_tld: false }) externalUrl?: string;
  @IsOptional() @IsDateString() publishedAt?: string;
}

export class ConfirmManualDto {
  @IsOptional() @IsUrl({ require_tld: false }) externalUrl?: string;
  @IsOptional() @IsDateString() publishedAt?: string;
}

/**
 * Manual metrics snapshot. Every field is optional: whatever is not supplied is
 * recorded as "unavailable" (never as a real 0).
 */
export class MetricsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) views?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) reach?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) likes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) comments?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) shares?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) saves?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) clicks?: number;
}