import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  health(): { status: 'ok'; uptime: number } {
    return {
      status: 'ok',
      uptime: process.uptime(),
    };
  }

  @Get('db')
  async databaseStatus(): Promise<{
    status: 'ok';
    database: 'reachable';
  }> {
    await this.database.query('SELECT 1');

    return {
      status: 'ok',
      database: 'reachable',
    };
  }
}
