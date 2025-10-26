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
import { ApiOkResponse, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AppUsersService } from './app-users.service';
import {
  AppUserDto,
  AppUserLoginDto,
  CreateAppUserDto,
  UpdateAppUserDto,
} from '../docs/dto/apps.dto';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUserRoles } from '../common/decorators/app-user-roles.decorator';
import { AppUserRole } from './schemas/app-user.schema';

@ApiTags('app-users')
@Controller('v1/apps/:appId/users')
export class AppUsersController {
  constructor(private readonly users: AppUsersService) {}

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @ApiOkResponse({ type: AppUserDto, isArray: true })
  @Get()
  list(@Param('appId') appId: string) {
    return this.users.list(appId);
  }

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @ApiOkResponse({ type: AppUserDto })
  @Post()
  create(@Param('appId') appId: string, @Body() body: CreateAppUserDto) {
    return this.users.create(appId, body);
  }

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @ApiOkResponse({ type: AppUserDto })
  @Get(':userId')
  get(@Param('appId') appId: string, @Param('userId') userId: string) {
    return this.users.find(appId, userId);
  }

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @ApiOkResponse({ type: AppUserDto })
  @Patch(':userId')
  update(
    @Param('appId') appId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateAppUserDto,
  ) {
    return this.users.update(appId, userId, body);
  }

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin)
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  @Delete(':userId')
  remove(@Param('appId') appId: string, @Param('userId') userId: string) {
    return this.users.remove(appId, userId);
  }

  @ApiParam({ name: 'appId' })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @AppUserRoles(AppUserRole.Admin, AppUserRole.Recorder)
  @ApiOkResponse({ type: AppUserDto })
  @Post('/canRecord')
  canRecord(@Param('appId') appId: string, @Body() loginDto: AppUserLoginDto) {
    return this.users.canRecord(appId, loginDto.email, loginDto.token);
  }

  @ApiParam({ name: 'appId' })
  @ApiOkResponse({ type: AppUserDto })
  @Post('/login')
  login(@Param('appId') appId: string, @Body() loginDto: AppUserLoginDto) {
    return this.users.login(appId, loginDto.email, loginDto.token);
  }
}
