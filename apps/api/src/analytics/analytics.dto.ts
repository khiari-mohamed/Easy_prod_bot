import { Platform, PostFormat } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ImportRowDto {
  @IsEnum(Platform) platform: Platform;
  @IsDateString() publishedAt: string;
  @IsOptional() @IsEnum(PostFormat) format?: PostFormat;
  @IsOptional() @IsString() @MaxLength(5000) caption?: string;
  @IsOptional() @IsUrl({ require_tld: false }) externalUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) views?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) reach?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) likes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) comments?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) shares?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) saves?: number;
}

export class ImportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ImportRowDto)
  rows: ImportRowDto[];
}
