import {
    ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiSecurity, ApiTags, ApiExtraModels, getSchemaPath
} from '@nestjs/swagger';
import {
    StartSessionDto, StartSessionRespDto, AppendEventsDto,
    RrwebEventDto, ActionEventDto, NetEventDto,
    BackendIngestDto, FinishSessionDto, FinishSessionRespDto
} from '../docs/dto/sessions.dto';
import {Body, Controller, Get, Param, Post, Query, Req} from "@nestjs/common";
import {SessionsService} from "./sessions.service";

@ApiTags('sessions')
@ApiExtraModels(RrwebEventDto, ActionEventDto, NetEventDto)
@Controller('v1')
export class SessionsController {
    constructor(private svc: SessionsService) {}

    @ApiBearerAuth('sdk')
    @ApiOkResponse({ type: StartSessionRespDto })
    @Post('sessions')
    start(@Body() body: StartSessionDto, @Req() req: any) {
        return this.svc.startSession(req.appId, body?.clientTime);
    }

    @ApiBearerAuth('sdk')
    @ApiParam({ name: 'sid' })
    @ApiBody({ type: AppendEventsDto })
    @ApiOkResponse({ schema: { example: { ok: true } } })
    @Post('sessions/:sid/events')
    append(@Param('sid') sid: string, @Body() body: AppendEventsDto) {
        return this.svc.appendEvents(sid, body);
    }

    @ApiSecurity('appId')
    @ApiSecurity('appSecret')
    @ApiParam({ name: 'sid' })
    @ApiBody({ type: BackendIngestDto })
    @ApiOkResponse({ schema: { example: { ok: true } } })
    @Post('sessions/:sid/backend')
    backend(@Param('sid') sid: string, @Body() body: BackendIngestDto) {
        return this.svc.ingestBackend(sid, body);
    }

    @ApiBearerAuth('sdk')
    @ApiParam({ name: 'sid' })
    @ApiBody({ type: FinishSessionDto })
    @ApiOkResponse({ type: FinishSessionRespDto })
    @Post('sessions/:sid/finish')
    finish(@Param('sid') sid: string, @Body() body: FinishSessionDto) {
        return this.svc.finishSession(sid, body?.notes);
    }

    @Get('sessions/:sessionId/rrweb')
    async getRrwebChunks(
        @Param('sessionId') sessionId: string,
        @Query('afterSeq') afterSeq = '0',
        @Query('limit') limit = '5',
    ) {
        const a = Math.max(0, Number(afterSeq) || 0);
        const l = Math.min(20, Math.max(1, Number(limit) || 5)); // cap to avoid huge payloads

        const chunks = await this.svc.getRrwebChunksPaged(sessionId, a, l);
        return {
            sessionId,
            items: chunks.map(c => ({
                seq: c.seq,
                tFirst: c.tFirst,
                tLast: c.tLast,
                // send as base64 string (utf8) so client can decode JSON safely
                base64: c.data.toString('base64'),
            })),
            nextAfterSeq: chunks.length ? chunks[chunks.length - 1].seq : a,
        };
    }

    @Get('sessions/:sessionId/timeline')
    async getTimeline(@Param('sessionId') sessionId: string) {
        return this.svc.getTimeline(sessionId);
    }

    @Get(':sessionId/rrweb/chunk')
    async getChunk(
        @Param('sessionId') sessionId: string,
        @Query('seq') seqStr: string,
    ) {
        return this.svc.getChunk(sessionId, seqStr)
    }
}
