import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UploadIntentDto {
  @IsString()
  @MaxLength(100)
  contentType: string;

  @IsInt()
  @Min(1)
  size: number;

  /** Accepted for the client's convenience and ignored: it never reaches the key. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filename?: string;
}
