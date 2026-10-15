import { CaptionLanguage, Platform, PostFormat, PublishMode, AssetRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ContentAssetDto {
  @IsString() assetId: string;
  @IsOptional() @IsInt() @Min(0) order?: number;
  @IsOptional() @IsEnum(AssetRole) role?: AssetRole;
}

export class CreateContentItemDto {
  @IsString() @MaxLength(300) title: string;
  @IsOptional() @IsEnum(CaptionLanguage) captionLanguage?: CaptionLanguage;
  @IsString() @MaxLength(5000) baseCaption: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) hashtags?: string[];
  @IsOptional() @IsEnum(PublishMode) defaultPublishMode?: PublishMode;
  @IsOptional() @IsString() planEntryId?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ContentAssetDto) assets?: ContentAssetDto[];
}

export class UpdateContentItemDto {
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsEnum(CaptionLanguage) captionLanguage?: CaptionLanguage;
  @IsOptional() @IsString() @MaxLength(5000) baseCaption?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) hashtags?: string[];
  @IsOptional() @IsEnum(PublishMode) defaultPublishMode?: PublishMode;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ContentAssetDto) assets?: ContentAssetDto[];
}

export class GeneratePostsDto {
  @IsArray() @IsEnum(Platform, { each: true }) platforms: Platform[];
  @IsOptional() @IsEnum(PostFormat) format?: PostFormat;
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsBoolean() generateCaptions?: boolean;
}

export class RejectContentDto {
  @IsString() @MaxLength(500) reason: string;
}

export class ListContentQuery {
  @IsOptional() @IsEnum(CaptionLanguage) captionLanguage?: CaptionLanguage;
  @IsOptional() @IsString() planEntryId?: string;
}
