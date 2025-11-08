import {
  Body,
  Controller,
  NotFoundException,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
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
    @Req() req: any,
    @Body() loginDto: AppUserLoginDto,
  ): Promise<AppUserLoginResponseDto> {
    const tenantHeader = req?.headers?.['x-tenant-id'];
    const headerValue = Array.isArray(tenantHeader)
      ? tenantHeader[0]
      : tenantHeader;
    const hasTenant =
      typeof headerValue === 'string' && headerValue.trim().length > 0;

    const result = hasTenant
      ? await this.users.loginByCredentials(loginDto.email, loginDto.password)
      : await this.users.loginWithoutTenant(loginDto.email, loginDto.password);

    return result;
  }

  @ApiOkResponse({ type: AppUserProfileResponseDto })
  @ApiHeader({
    name: 'X-Tenant-Id',
    description: 'Tenant identifier for the workspace.',
    required: true,
  })
  @ApiBearerAuth('appUser')
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
