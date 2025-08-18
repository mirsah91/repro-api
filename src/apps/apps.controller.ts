import { ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CreateAppDto, AppKeysDto } from '../docs/dto/apps.dto';
import {AppsService} from "./apps.service";
import {Body, Controller, Post, Headers} from "@nestjs/common";

@ApiTags('apps')
@Controller('v1/apps')
export class AppsController {
    constructor(private svc: AppsService) {}

    @ApiHeader({ name: 'x-admin-token', required: true })
    @ApiOkResponse({ type: AppKeysDto })
    @Post()
    async create(@Headers('x-admin-token') admin: string, @Body() body: CreateAppDto) {
        if (admin !== process.env.ADMIN_TOKEN) return { error: 'unauthorized' };
        return this.svc.createApp(body?.name);
    }
}
