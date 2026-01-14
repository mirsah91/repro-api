import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { ContactRequestDto, ContactResponseDto } from './dto/contact.dto';

@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @ApiBody({ type: ContactRequestDto })
  @ApiOkResponse({ type: ContactResponseDto })
  @Post()
  async submit(
    @Body() body: ContactRequestDto,
  ): Promise<ContactResponseDto> {
    await this.contact.sendContactEmail(body);
    return { ok: true };
  }
}
