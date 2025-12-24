import {
  ApiBearerAuth,
  ApiBody,
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
  ReindexSessionGraphResponseDto,
  ReproAiGraphDto,
  ReproAiHitDto,
  ReproAiQueryDto,
  ReproAiQueryResponseDto,
} from '../docs/dto/repro-ai.dto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionSummaryService } from './session-summary.service';
import { SessionGraphService } from './session-graph.service';
import { SdkTokenGuard } from '../common/guards/sdk-token.guard';
import { AppSecretGuard } from '../common/guards/app-secret.guard';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';
import { computeChatQuota } from '../apps/app-user.constants';

@ApiTags('sessions')
@ApiExtraModels(RrwebEventDto, ActionEventDto, NetEventDto)
@Controller('v1')
export class SessionsController {
  constructor(
    private svc: SessionsService,
    private summaries: SessionSummaryService,
    private graphAi: SessionGraphService,
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
    if (!req?.appUser?.chatEnabled) {
      throw new ForbiddenException(
        'Chat assistant is disabled for this user. Contact an administrator to request access.',
      );
    }
    const tenantId = req?.tenantId;
    const userId = this.extractAppUserId(req?.appUser);
    let reservedUser: any | null = null;
    try {
      reservedUser = await this.svc.reserveChatQuota(userId, tenantId);
      if (!reservedUser) {
        throw new ForbiddenException(
          'You have reached the maximum number of chat prompts allowed for this workspace.',
        );
      }
      const result = await this.summaries.chatSession(sessionId, {
        appId: req.appId,
        messages: body?.messages ?? [],
      });
      return {
        reply: result.reply,
        counts: result.counts,
        usage: result.usage,
        quota: computeChatQuota(reservedUser.chatUsageCount),
      };
    } catch (err) {
      if (reservedUser) {
        await this.svc.releaseChatQuota(userId, tenantId);
      }
      throw err;
    }
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @ApiOkResponse({ type: ReindexSessionGraphResponseDto })
  @Post('sessions/:sessionId/ai/reindex')
  async reindexSessionGraph(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
  ): Promise<ReindexSessionGraphResponseDto> {
    if (!req?.appUser?.chatEnabled) {
      throw new ForbiddenException(
        'Chat assistant is disabled for this user. Contact an administrator to request access.',
      );
    }
    const result = await this.graphAi.rebuildSessionGraph(sessionId, {
      appId: req.appId,
    });
    return {
      sessionId: result.sessionId,
      nodes: result.counts.nodes,
      edges: result.counts.edges,
      facts: result.counts.facts,
    };
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @ApiBody({ type: ReproAiQueryDto })
  @ApiOkResponse({ type: ReproAiQueryResponseDto })
  @Post('sessions/:sessionId/ai/query')
  async querySessionGraph(
    @Param('sessionId') sessionId: string,
    @Body() body: ReproAiQueryDto,
    @Req() req: any,
  ): Promise<ReproAiQueryResponseDto> {
    if (!req?.appUser?.chatEnabled) {
      throw new ForbiddenException(
        'Chat assistant is disabled for this user. Contact an administrator to request access.',
      );
    }
    const result = await this.graphAi.answerQuestion({
      sessionId,
      appId: req.appId,
      question: body?.question ?? '',
      nodeTypes: body?.nodeTypes,
      capabilityTags: body?.capabilityTags,
      limit: body?.limit,
      rebuildIndex: body?.rebuildIndex,
    });

    const hits: ReproAiHitDto[] = result.hits.map((hit) => ({
      nodeId: hit.fact.nodeId,
      nodeType: hit.fact.nodeType,
      title:
        hit.node?.title ??
        hit.fact.structured?.['functionName'] ??
        hit.fact.structured?.['url'],
      capabilityTags: hit.fact.capabilityTags ?? [],
      score: Number(hit.score ?? 0),
    }));
    const graph: ReproAiGraphDto = {
      nodes: result.graph.nodes.map((node) => ({
        nodeId: node._id,
        nodeType: node.type,
        title: node.title,
        capabilityTags: node.capabilityTags ?? [],
      })),
      edges: result.graph.edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        relation: edge.relation,
      })),
    };

    return {
      sessionId: result.sessionId,
      question: result.question,
      answer: result.answer,
      hits,
      graph,
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

  private extractAppUserId(appUser: any): string | undefined {
    if (!appUser) return undefined;
    if (typeof appUser.id === 'string') return appUser.id;
    if (typeof appUser._id === 'string') return appUser._id;
    if (appUser._id?.toHexString) return appUser._id.toHexString();
    if (appUser._id?.toString) return appUser._id.toString();
    return undefined;
  }
}
