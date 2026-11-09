import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsInt()
  @Min(0)
  price_cents: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;
}
