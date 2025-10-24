import { ApiOkResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CreateAppDto, AppKeysDto, AppDetailDto, AppDto, UpdateAppDto } from '../docs/dto/apps.dto';
import { AppsService } from './apps.service';
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';

@ApiTags('apps')
@Controller('v1/apps')
export class AppsController {
    constructor(private svc: AppsService) {}

    @ApiOkResponse({ type: AppKeysDto })
    @ApiSecurity('adminToken')
    @UseGuards(AdminTokenGuard)
    @Post()
    async create(@Body() body: CreateAppDto) {
        return this.svc.createApp(body?.name, body.adminEmail);
    }

    @ApiOkResponse({ type: AppDto, isArray: true })
    @ApiSecurity('adminToken')
    @UseGuards(AdminTokenGuard)
    @Get()
    list() {
        return this.svc.listApps();
    }

    @ApiOkResponse({ type: AppDetailDto })
    @ApiSecurity('adminToken')
    @UseGuards(AdminTokenGuard)
    @Get(':appId')
    get(@Param('appId') appId: string) {
        return this.svc.getApp(appId);
    }

    @ApiOkResponse({ type: AppDetailDto })
    @ApiSecurity('adminToken')
    @UseGuards(AdminTokenGuard)
    @Patch(':appId')
    update(@Param('appId') appId: string, @Body() body: UpdateAppDto) {
        return this.svc.updateApp(appId, body);
    }

    @ApiOkResponse({ schema: { example: { deleted: true } } })
    @ApiSecurity('adminToken')
    @UseGuards(AdminTokenGuard)
    @Delete(':appId')
    remove(@Param('appId') appId: string) {
        return this.svc.removeApp(appId);
    }
}
