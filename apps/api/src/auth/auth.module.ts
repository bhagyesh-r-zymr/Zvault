import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [DevicesModule],
  controllers: [AuthController],
  providers: [SignupService, LoginService],
})
export class AuthModule {}
