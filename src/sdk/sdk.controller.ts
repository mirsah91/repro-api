import { ApiOkResponse, ApiQuery, ApiTags, getSchemaPath, ApiExtraModels } from '@nestjs/swagger';
import { BootstrapOkDto, BootstrapDisabledDto } from '../docs/dto/sdk.dto';
import {Controller, Get, Query} from "@nestjs/common";
import {SdkService} from "./sdk.service";

@ApiTags('sdk')
@ApiExtraModels(BootstrapOkDto, BootstrapDisabledDto)
@Controller('v1/sdk')
export class SdkController {
    constructor(private svc: SdkService) {}

    @ApiQuery({ name: 'appId', required: true })
    @ApiOkResponse({
        schema: { oneOf: [{ $ref: getSchemaPath(BootstrapOkDto) }, { $ref: getSchemaPath(BootstrapDisabledDto) }] }
    })
    @Get('bootstrap')
    async bootstrap(@Query('appId') appId: string) {
        return this.svc.bootstrap(appId);
    }
}
