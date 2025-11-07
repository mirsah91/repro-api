import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  StartSessionDto,
  StartSessionRespDto,
  AppendEventsDto,
  RrwebEventDto,
  ActionEventDto,
  NetEventDto,
  BackendIngestDto,
  FinishSessionDto,
  FinishSessionRespDto,
} from '../docs/dto/sessions.dto';
import {
  SessionChatRequestDto,
  SessionChatResponseDto,
} from '../docs/dto/apps.dto';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionSummaryService } from './session-summary.service';
import { SdkTokenGuard } from '../common/guards/sdk-token.guard';
import { AppSecretGuard } from '../common/guards/app-secret.guard';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';

@ApiTags('sessions')
@ApiHeader({
  name: 'X-Tenant-Id',
  description: 'Tenant identifier for the workspace.',
  required: true,
})
@ApiExtraModels(RrwebEventDto, ActionEventDto, NetEventDto)
@Controller('v1')
export class SessionsController {
  constructor(
    private svc: SessionsService,
    private summaries: SessionSummaryService,
  ) {}

  @ApiSecurity('sdkToken')
  @ApiBearerAuth('appUser')
  @ApiOkResponse({ type: StartSessionRespDto })
  @UseGuards(SdkTokenGuard, AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Recorder)
  @Post('sessions')
  start(@Body() body: StartSessionDto, @Req() req: any) {
    return this.svc.startSession(req.appId, body?.clientTime, req.appUser);
  }

  @ApiSecurity('sdkToken')
  @ApiBearerAuth('appUser')
  @ApiParam({ name: 'sid' })
  @ApiBody({ type: AppendEventsDto })
  @ApiOkResponse({ schema: { example: { ok: true } } })
  @UseGuards(SdkTokenGuard, AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Recorder)
  @Post('sessions/:sid/events')
  append(
    @Param('sid') sid: string,
    @Body() body: AppendEventsDto,
    @Req() req: any,
  ) {
    return this.svc.appendEvents(sid, req.appId, body);
  }

  @ApiSecurity('appId')
  @ApiSecurity('appSecret')
  @ApiParam({ name: 'sid' })
  @ApiBody({ type: BackendIngestDto })
  @ApiOkResponse({ schema: { example: { ok: true } } })
  @UseGuards(AppSecretGuard)
  @Post('sessions/:sid/backend')
  backend(
    @Param('sid') sid: string,
    @Body() body: BackendIngestDto,
    @Req() req: any,
  ) {
    return this.svc.ingestBackend(sid, req.appId, body);
  }

  @ApiSecurity('sdkToken')
  @ApiBearerAuth('appUser')
  @ApiParam({ name: 'sid' })
  @ApiBody({ type: FinishSessionDto })
  @ApiOkResponse({ type: FinishSessionRespDto })
  @UseGuards(SdkTokenGuard, AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Recorder)
  @Post('sessions/:sid/finish')
  finish(
    @Param('sid') sid: string,
    @Body() body: FinishSessionDto,
    @Req() req: any,
  ) {
    return this.svc.finishSession(sid, req.appId, body?.notes);
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sessionId/rrweb')
  async getRrwebChunks(
    @Param('sessionId') sessionId: string,
    @Query('afterSeq') afterSeq = '0',
    @Query('limit') limit = '5',
    @Req() req: any,
  ) {
    const a = Math.max(0, Number(afterSeq) || 0);
    const l = Math.min(20, Math.max(1, Number(limit) || 5)); // cap to avoid huge payloads

    const chunks = await this.svc.getRrwebChunksPaged(
      sessionId,
      req.appId,
      a,
      l,
    );
    return {
      sessionId,
      items: chunks.map((c) => ({
        seq: c.seq,
        tFirst: c.tFirst,
        tLast: c.tLast,
        // send as base64 string (utf8) so client can decode JSON safely
        base64: c.data.toString('base64'),
      })),
      nextAfterSeq: chunks.length ? chunks[chunks.length - 1].seq : a,
    };
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @ApiBody({ type: SessionChatRequestDto })
  @ApiOkResponse({ type: SessionChatResponseDto })
  @Post('sessions/:sessionId/chat')
  async chatSession(
    @Param('sessionId') sessionId: string,
    @Body() body: SessionChatRequestDto,
    @Req() req: any,
  ): Promise<SessionChatResponseDto> {
    const result = await this.summaries.chatSession(sessionId, {
      appId: req.appId,
      messages: body?.messages ?? [],
    });
    return {
      reply: result.reply,
      counts: result.counts,
      usage: result.usage,
    };
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sessionId/timeline')
  async getTimeline(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.svc.getTimeline(sessionId, req.appId);
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sessionId/traces')
  async getTraces(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.svc.getTracesBySession(sessionId, req.appId);
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get(':sessionId/rrweb/chunk')
  async getChunk(
    @Param('sessionId') sessionId: string,
    @Query('seq') seqStr: string,
    @Req() req: any,
  ) {
    return this.svc.getChunk(sessionId, req.appId, seqStr);
  }
}
