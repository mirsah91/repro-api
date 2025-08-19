import { ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { ActionDetailsRespDto, SummaryRespDto } from '../docs/dto/viewer.dto';
import {Controller, Get, Param, Query} from "@nestjs/common";
import {ViewerService} from "./viewer.service";

@ApiTags('viewer')
@Controller('v1')
export class ViewerController {
    constructor(private svc: ViewerService) {}

    @ApiParam({ name: 'sid' })
    @ApiOkResponse({ type: SummaryRespDto })
    @Get('sessions/:sid/summary')
    summary(@Param('sid') sid: string) { return this.svc.summary(sid); }

    @ApiParam({ name: 'sid' })
    @ApiParam({ name: 'aid' })
    @ApiOkResponse({ type: ActionDetailsRespDto })
    @Get('sessions/:sid/actions/:aid')
    action(@Param('sid') sid: string, @Param('aid') aid: string) { return this.svc.actionDetails(sid, aid); }


    @Get('sessions/:sid/full')
    full(
        @Param('sid') sid: string,
        @Query('include') include?: string, // e.g., "rrweb"
    ) {
        const inc = (include || '').split(',').map(s => s.trim().toLowerCase());
        return this.svc.full(sid, { includeRrweb: inc?.includes('rrweb') });
    }
}
