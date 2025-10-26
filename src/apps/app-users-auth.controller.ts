import { Body, Controller, NotFoundException, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AppUsersService } from './app-users.service';
import {
  AppUserLoginDto,
  AppUserLoginResponseDto,
  AppUserProfileResponseDto,
  UpdateAppUserProfileDto,
} from '../docs/dto/apps.dto';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';

@ApiTags('app-users')
@Controller('v1/app-users')
export class AppUsersAuthController {
  constructor(private readonly users: AppUsersService) {}

  @ApiOkResponse({ type: AppUserLoginResponseDto })
  @Post('login')
  async login(
    @Body() loginDto: AppUserLoginDto,
  ): Promise<AppUserLoginResponseDto> {
    const { user, app } = await this.users.loginByCredentials(
      loginDto.email,
      loginDto.token,
    );
    return { user, app };
  }

  @ApiOkResponse({ type: AppUserProfileResponseDto })
  @ApiSecurity('appUserToken')
  @UseGuards(AppUserTokenGuard)
  @Patch('me')
  async updateProfile(
    @Req() req: any,
    @Body() body: UpdateAppUserProfileDto,
  ): Promise<AppUserProfileResponseDto> {
    const appId = req?.appId;
    const userId = String(req?.appUser?._id ?? req?.appUser?.id);
    if (!appId || !userId) {
      throw new NotFoundException('User context unavailable');
    }
    const updated = await this.users.updateProfile(appId, userId, body);
    return { user: updated };
  }
}
