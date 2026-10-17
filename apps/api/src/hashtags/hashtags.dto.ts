import { CaptionLanguage, HashtagOrigin, Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateHashtagsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(80, { each: true }) tags: string[];
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class UpdateHashtagDto {
  @IsOptional() @IsString() @MaxLength(80) displayTag?: string;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @IsOptional() @IsBoolean() blocked?: boolean;
  @IsOptional() @IsString() @MaxLength(200) blockedReason?: string;
}

export class ListHashtagsQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsEnum(HashtagOrigin) origin?: HashtagOrigin;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() blocked?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}

export class RecommendQuery {
  @IsEnum(Platform) platform: Platform;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsString() contentItemId?: string;
  @IsOptional() @IsString() campaignId?: string;
  @IsOptional() @IsString() @MaxLength(2200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(40) limit?: number;
}