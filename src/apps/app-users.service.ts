import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { AppUser, AppUserDocument, AppUserRole } from './schemas/app-user.schema';

export interface AppUserDtoShape {
    id: string;
    appId: string;
    email: string;
    role: AppUserRole;
    token: string;
    enabled: boolean;
    name?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

@Injectable()
export class AppUsersService {
    constructor(@InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>) {}

    async list(appId: string): Promise<AppUserDtoShape[]> {
        const docs = await this.users.find({ appId }).sort({ createdAt: -1 }).lean();
        return docs.map(doc => this.toDto(doc));
    }

    async create(appId: string, dto: { email: string; role?: AppUserRole; name?: string; enabled?: boolean }): Promise<AppUserDtoShape> {
        const email = dto.email.trim().toLowerCase();
        const token = randomUUID();
        const role = dto.role ?? AppUserRole.Viewer;
        const enabled = dto.enabled ?? true;
        const name = typeof dto.name === 'string' ? dto.name.trim() : undefined;
        const created = await this.users.create({ appId, email, role, token, name, enabled });
        return this.toDto(created.toObject());
    }

    async find(appId: string, userId: string): Promise<AppUserDtoShape> {
        const doc = await this.users.findOne({ appId, _id: userId }).lean();
        if (!doc) throw new NotFoundException('User not found');
        return this.toDto(doc);
    }

    async update(
        appId: string,
        userId: string,
        dto: { role?: AppUserRole; name?: string | null; enabled?: boolean; resetToken?: boolean }
    ): Promise<AppUserDtoShape> {
        const doc = await this.users.findOne({ appId, _id: userId });
        if (!doc) throw new NotFoundException('User not found');

        if (typeof dto.role !== 'undefined') doc.role = dto.role;
        if (typeof dto.enabled !== 'undefined') doc.enabled = dto.enabled;
        if (typeof dto.name !== 'undefined') {
            const trimmed = typeof dto.name === 'string' ? dto.name.trim() : undefined;
            doc.name = trimmed ?? undefined;
        }
        if (dto.resetToken) doc.token = randomUUID();

        await doc.save();
        return this.toDto(doc.toObject());
    }

    async remove(appId: string, userId: string): Promise<{ deleted: boolean }> {
        const res = await this.users.deleteOne({ appId, _id: userId });
        if (!res.deletedCount) throw new NotFoundException('User not found');
        return { deleted: true };
    }

    private toDto(doc: any): AppUserDtoShape {
        return {
            id: String(doc._id),
            appId: doc.appId,
            email: doc.email,
            role: doc.role,
            token: doc.token,
            enabled: doc.enabled,
            name: doc.name ?? undefined,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
        };
    }
}
