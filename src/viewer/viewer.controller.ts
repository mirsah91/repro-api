import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  ActionDetailsRespDto,
  SummaryRespDto,
  FullResponseDto,
} from '../docs/dto/viewer.dto';
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ViewerService } from './viewer.service';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from '../apps/schemas/app-user.schema';

@ApiTags('viewer')
@ApiHeader({
  name: 'X-Tenant-Id',
  description: 'Tenant identifier for the workspace.',
  required: true,
})
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
    @Query('include') include?: string, // e.g., "rrweb,respdiffs"
    @Req() req?: any,
  ): Promise<FullResponseDto> {
    const inc = (include || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    return this.svc.full(sid, {
      appId: req?.appId,
      includeRrweb: inc.includes('rrweb'),
      includeRespDiffs:
        inc.includes('respdiffs') ||
        inc.includes('resp-diffs') ||
        inc.includes('responses'),
    });
  }
}
