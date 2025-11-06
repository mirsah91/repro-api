import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CreateAppDto,
  AppKeysDto,
  AppDetailDto,
  AppDto,
  UpdateAppDto,
} from '../docs/dto/apps.dto';
import { AppsService } from './apps.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from './schemas/app-user.schema';

@ApiTags('apps')
@Controller('v1/apps')
export class AppsController {
  constructor(private svc: AppsService) {}

  @ApiOkResponse({ type: AppKeysDto })
  @Post()
  async create(@Body() body: CreateAppDto) {
    return this.svc.createApp(body?.name, body.adminEmail, body.adminPassword);
  }

  @ApiOkResponse({ type: AppDto, isArray: true })
  @ApiBearerAuth('appUser')
  @ApiHeader({
    name: 'X-Tenant-Id',
    description: 'Tenant identifier for the workspace.',
    required: true,
  })
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @Get()
  list() {
    return this.svc.listApps();
  }

  @ApiOkResponse({ type: AppDetailDto })
  @ApiBearerAuth('appUser')
  @ApiHeader({
    name: 'X-Tenant-Id',
    description: 'Tenant identifier for the workspace.',
    required: true,
  })
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @Get(':appId')
  get(@Param('appId') appId: string) {
    return this.svc.getApp(appId);
  }

  @ApiOkResponse({ type: AppDetailDto })
  @ApiBearerAuth('appUser')
  @ApiHeader({
    name: 'X-Tenant-Id',
    description: 'Tenant identifier for the workspace.',
    required: true,
  })
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @Patch(':appId')
  update(@Param('appId') appId: string, @Body() body: UpdateAppDto) {
    return this.svc.updateApp(appId, body);
  }

  @ApiOkResponse({ schema: { example: { deleted: true } } })
  @ApiBearerAuth('appUser')
  @ApiHeader({
    name: 'X-Tenant-Id',
    description: 'Tenant identifier for the workspace.',
    required: true,
  })
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @Delete(':appId')
  remove(@Param('appId') appId: string) {
    return this.svc.removeApp(appId);
  }
}
