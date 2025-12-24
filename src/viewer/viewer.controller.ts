import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  ActionDetailsRespDto,
  SummaryRespDto,
  FullResponseDto,
  TimelineActionsResponseDto,
} from '../docs/dto/viewer.dto';
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ViewerService } from './viewer.service';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';

@ApiTags('viewer')
@Controller('v1')
export class ViewerController {
  constructor(private svc: ViewerService) {}

  @ApiParam({ name: 'sid' })
  @ApiOkResponse({ type: SummaryRespDto })
  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sid/summary')
  summary(@Param('sid') sid: string, @Req() req: any) {
    return this.svc.summary(sid, req.appId);
  }

  @ApiParam({ name: 'sid' })
  @ApiParam({ name: 'aid' })
  @ApiOkResponse({ type: ActionDetailsRespDto })
  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sid/actions/:aid')
  action(
    @Param('sid') sid: string,
    @Param('aid') aid: string,
    @Req() req: any,
  ) {
    return this.svc.actionDetails(sid, aid, req.appId);
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sid/full')
  @ApiOkResponse({ type: FullResponseDto })
  full(
    @Param('sid') sid: string,
    @Query('include') include?: string, // e.g., "rrweb,respdiffs,traces"
    @Query('includeRrweb') includeRrweb?: string,
    @Query('includeRespDiffs') includeRespDiffs?: string,
    @Query('includeTraces') includeTraces?: string,
    @Req() req?: any,
  ): Promise<FullResponseDto> {
    const inc = (include || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const truthy = (v?: string) =>
      typeof v === 'string' &&
      ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());

    return this.svc.full(sid, {
      appId: req?.appId,
      includeRrweb: inc.includes('rrweb') || truthy(includeRrweb),
      includeRespDiffs:
        inc.includes('respdiffs') ||
        inc.includes('resp-diffs') ||
        inc.includes('responses') ||
        truthy(includeRespDiffs),
      includeTraces: inc.includes('traces') || inc.includes('trace') || truthy(includeTraces),
    });
  }

  @ApiBearerAuth('appUser')
  @ApiSecurity('appId')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Viewer)
  @Get('sessions/:sid/timeline-actions')
  @ApiOkResponse({ type: TimelineActionsResponseDto })
  timelineActions(@Param('sid') sid: string, @Req() req: any) {
    return this.svc.timelineActions(sid, req.appId);
  }
}
