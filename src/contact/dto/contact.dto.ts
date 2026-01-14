import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class ContactRequestDto {
  @ApiProperty({ example: 'Ada' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'Lovelace' })
  @IsString()
  @IsNotEmpty()
  suername!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'Can we schedule a demo next week?' })
  @IsString()
  @IsNotEmpty()
  message!: string;
}

export class ContactResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}
