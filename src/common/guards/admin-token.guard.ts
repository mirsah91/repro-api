import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AdminTokenGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const header = req.headers['x-admin-token'];
        const token = Array.isArray(header) ? header[0] : header;
        if (!token) return false;
        return token === process.env.ADMIN_TOKEN;
    }
}
