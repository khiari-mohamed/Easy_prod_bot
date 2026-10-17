import { CaptionLanguage, Platform, SuggestionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TONE_RE } from './caption-rules';

export class GenerateCaptionsDto {
  @IsOptional() @IsString() contentItemId?: string;
  @IsOptional() @IsString() planEntryId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsEnum(Platform, { each: true }) platforms: Platform[];
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsIn(['AUTO', 'ARABIC', 'LATIN']) script?: 'AUTO' | 'ARABIC' | 'LATIN';
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @Matches(TONE_RE, { each: true }) tones?: string[];
  @IsOptional() @IsString() @MaxLength(1000) brief?: string;
  /** Free-use mode (no content item): a caption whose facts must be preserved. */
  @IsOptional() @IsString() @MaxLength(2200) baseCaption?: string;
}

export class ListSuggestionsQuery {
  @IsOptional() @IsString() contentItemId?: string;
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsEnum(SuggestionStatus) status?: SuggestionStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;
}

export class EditSuggestionDto {
  /** The revision the editor was looking at: refused if someone changed it in between. */
  @IsInt() @Min(1) revision: number;
  @IsOptional() @IsString() @MaxLength(5000) text?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(80, { each: true }) hashtags?: string[];
  @IsOptional() @IsString() @MaxLength(500) feedback?: string;
}

export class ApproveSuggestionDto {
  @IsInt() @Min(1) revision: number;
  /** Warnings (language, facts, placeholders) must be explicitly acknowledged by the reviewer. */
  @IsOptional() @IsBoolean() acknowledgeWarnings?: boolean;
  @IsOptional() @IsString() @MaxLength(500) feedback?: string;
}

export class RejectSuggestionDto {
  @IsOptional() @IsString() @MaxLength(500) feedback?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  /** Also record the hashtags of this suggestion as rejected (negative signal for the ranking). */
  @IsOptional() @IsBoolean() rejectHashtags?: boolean;
}

export class ApplySuggestionDto {
  @IsInt() @Min(1) revision: number;
  @IsIn(['POST', 'CONTENT']) target: 'POST' | 'CONTENT';
  @IsOptional() @IsString() postId?: string;
  /** Required when the target already holds different text (including a caption supplied by the plan). */
  @IsOptional() @IsBoolean() confirmOverwrite?: boolean;
}

export class FeedbackDto {
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}