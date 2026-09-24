import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { LoginService } from './login.service.js';
import { SessionService } from './session.service.js';
import { SignupService } from './signup.service.js';

@Module({
  controllers: [AuthController],
  providers: [SignupService, LoginService, SessionService, AuthGuard],
  exports: [SessionService, AuthGuard],
})
export class AuthModule {}
