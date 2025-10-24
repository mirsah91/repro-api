import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AppUsersService } from './app-users.service';
import { AppUserDto, CreateAppUserDto, UpdateAppUserDto } from '../docs/dto/apps.dto';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from './schemas/app-user.schema';

@ApiTags('app-users')
@ApiParam({ name: 'appId' })
@ApiSecurity('appUserToken')
@UseGuards(AppUserTokenGuard)
@AppUserRoles(AppUserRole.Admin)
@Controller('v1/apps/:appId/users')
export class AppUsersController {
    constructor(private readonly users: AppUsersService) {}

    @ApiOkResponse({ type: AppUserDto, isArray: true })
    @Get()
    list(@Param('appId') appId: string) {
        return this.users.list(appId);
    }

    @ApiOkResponse({ type: AppUserDto })
    @Post()
    create(@Param('appId') appId: string, @Body() body: CreateAppUserDto) {
        return this.users.create(appId, body);
    }

    @ApiOkResponse({ type: AppUserDto })
    @Get(':userId')
    get(@Param('appId') appId: string, @Param('userId') userId: string) {
        return this.users.find(appId, userId);
    }

    @ApiOkResponse({ type: AppUserDto })
    @Patch(':userId')
    update(
        @Param('appId') appId: string,
        @Param('userId') userId: string,
        @Body() body: UpdateAppUserDto,
    ) {
        return this.users.update(appId, userId, body);
    }

    @ApiOkResponse({ schema: { example: { deleted: true } } })
    @Delete(':userId')
    remove(@Param('appId') appId: string, @Param('userId') userId: string) {
        return this.users.remove(appId, userId);
    }
}
