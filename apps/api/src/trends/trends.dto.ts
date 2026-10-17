import { Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TREND_MAX_TTL_HOURS, TREND_SOURCES } from './trend-rules';

export class AddTrendDto {
  @IsEnum(Platform) platform: Platform;
  @IsString() @MaxLength(80) tag: string;
  @IsOptional() @IsIn(TREND_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) region?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) score?: number;
  @IsOptional() @IsInt() @Min(1) @Max(TREND_MAX_TTL_HOURS) ttlHours?: number;
  @IsString() @MinLength(5) @MaxLength(300) sourceNote: string;
}

export class ImportTrendsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AddTrendDto) rows: AddTrendDto[];
}

export class ListTrendsQuery {
  @IsOptional() @IsEnum(Platform) platform?: Platform;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeExpired?: boolean;
}