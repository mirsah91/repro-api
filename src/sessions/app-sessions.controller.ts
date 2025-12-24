import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SessionsService } from './sessions.service';
import {
  AppSessionDto,
  CreateAppSessionDto,
  SessionListResponseDto,
  UpdateAppSessionDto,
} from '../docs/dto/sessions.dto';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';

@ApiTags('app-sessions')
@ApiBearerAuth('appUser')
@UseGuards(AppUserTokenGuard)
@AppUserRoles(AppUserRole.Admin)
@Controller('v1/apps/:appId/sessions')
export class AppSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @ApiOkResponse({ type: SessionListResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'finished'],
  })
  list(
    @Param('appId') appId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ): Promise<SessionListResponseDto> {
    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    const normalizedStatus =
      status === 'active' || status === 'finished' ? status : undefined;
    const normalizedSearch = search?.trim() || undefined;
    return this.sessions.listSessionsForApp(appId, {
      limit: safeLimit,
      cursor: cursor ?? undefined,
      search: normalizedSearch,
      status: normalizedStatus,
    });
  }

  @Post('manual')
  @ApiOkResponse({ type: AppSessionDto })
  createManual(
    @Param('appId') appId: string,
    @Body() body: CreateAppSessionDto,
    @Req() req: any,
  ): Promise<AppSessionDto> {
    const userId =
      req?.appUser?._id?.toString?.() ??
      req?.appUser?.id ??
      req?.appUser?._id ??
      undefined;
    return this.sessions.createSessionForApp(appId, {
      ...body,
      userId,
    });
  }

  @Get(':sessionId')
  @ApiParam({ name: 'sessionId' })
  @ApiOkResponse({ type: AppSessionDto })
  get(
    @Param('appId') appId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<AppSessionDto> {
    return this.sessions.getSessionForApp(appId, sessionId);
  }

  @Patch(':sessionId')
  @ApiParam({ name: 'sessionId' })
  @ApiOkResponse({ type: AppSessionDto })
  update(
    @Param('appId') appId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateAppSessionDto,
  ): Promise<AppSessionDto> {
    return this.sessions.updateSessionForApp(appId, sessionId, body);
  }

  @Delete(':sessionId')
  @ApiParam({ name: 'sessionId' })
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  remove(
    @Param('appId') appId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessions.deleteSessionForApp(appId, sessionId);
  }
}
