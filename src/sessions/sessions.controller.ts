import {
    ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiSecurity, ApiTags, ApiExtraModels, getSchemaPath
} from '@nestjs/swagger';
import {
    StartSessionDto, StartSessionRespDto, AppendEventsDto,
    RrwebEventDto, ActionEventDto, NetEventDto,
    BackendIngestDto, FinishSessionDto, FinishSessionRespDto
} from '../docs/dto/sessions.dto';
import {Body, Controller, Param, Post, Req} from "@nestjs/common";
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
}
