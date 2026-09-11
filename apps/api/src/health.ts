import 'reflect-metadata';
import { Controller, Get, Inject, Module, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
export const DB_PROBE = Symbol('DB_PROBE');
@Controller('health')
export class HealthController {
  constructor(@Inject(DB_PROBE) private readonly probe: () => Promise<void>) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    try {
      await this.probe();
      return { status: 'ready' };
    } catch {
      throw new HttpException({ status: 'not_ready' }, 503);
    }
  }
}
export async function createHealthApp(probe: () => Promise<void>): Promise<NestFastifyApplication> {
  @Module({ controllers: [HealthController], providers: [{ provide: DB_PROBE, useValue: probe }] })
  class HealthModule {}
  const app = await NestFactory.create<NestFastifyApplication>(HealthModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
