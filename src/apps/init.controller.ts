import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AppsService } from './apps.service';
import { AppUsersService } from './app-users.service';
import {
  AppKeysDto,
  AppUserLoginDto,
  AppUserLoginResponseDto,
  InitWorkspaceDto,
  SessionSummaryRequestDto,
  SessionSummaryResponseDto,
} from '../docs/dto/apps.dto';
import { SessionSummaryService } from './session-summary.service';

@ApiTags('init')
@Controller('init')
export class InitController {
  constructor(
    private readonly apps: AppsService,
    private readonly users: AppUsersService,
    private readonly summaries: SessionSummaryService,
  ) {}

  @ApiOkResponse({ type: AppKeysDto })
  @Post()
  async createWorkspace(@Body() body: InitWorkspaceDto): Promise<AppKeysDto> {
    const result = await this.apps.createApp(
      body.appName,
      body.email,
      body.password,
    );
    return result;
  }

  @ApiOkResponse({ type: AppUserLoginResponseDto })
  @Post('login')
  async login(
    @Body() body: AppUserLoginDto,
  ): Promise<AppUserLoginResponseDto> {
    const { user, app } = await this.users.loginWithoutTenant(
      body.email,
      body.password,
    );
    return { user, app };
  }

  @ApiOkResponse({ type: SessionSummaryResponseDto })
  @Post('session-summary')
  async summarizeSession(
    @Body() body: SessionSummaryRequestDto,
  ): Promise<SessionSummaryResponseDto> {
    return this.summaries.summarizeSession(body.sessionId, {
      appId: body.appId,
    });
  }
}
