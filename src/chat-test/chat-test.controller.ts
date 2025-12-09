import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ChatTestService } from './chat-test.service';
import { ChatTestRequestDto, ChatTestResponseDto } from './dto/chat-test.dto';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';

@ApiTags('chat-test')
@ApiHeader({
  name: 'X-Tenant-Id',
  description: 'Tenant identifier for scoping the query.',
  required: true,
})
@ApiBearerAuth('appUser')
@ApiSecurity('appId')
@Controller('v1/chat-test')
export class ChatTestController {
  constructor(private readonly chatTest: ChatTestService) {}

  @Post()
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @ApiBody({ type: ChatTestRequestDto })
  @ApiOkResponse({ type: ChatTestResponseDto })
  async createQuery(
    @Body() body: ChatTestRequestDto,
  ): Promise<ChatTestResponseDto> {
    const result = await this.chatTest.runQuestion(body?.question ?? '');
    return {
      question: body?.question ?? '',
      model: result.model,
      raw: result.raw,
      plan: result.plan,
      pipeline: result.pipeline,
      results: result.results,
      collection: result.collection,
      tenantId: result.tenantId,
    };
  }
}
