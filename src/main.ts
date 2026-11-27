import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function createApplication() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin tidak diizinkan oleh konfigurasi CORS.'));
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix(process.env.API_PREFIX || 'api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  const config = new DocumentBuilder()
    .setTitle('SPI Compliance API')
    .setDescription('Sistem Pemantauan Kepatuhan Dokumen SPI.')
    .setVersion('2.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), { useGlobalPrefix: true });
  return app;
}

let vercelApp: ReturnType<typeof createApplication> | undefined;

async function vercelHandler(req: any, res: any) {
  vercelApp ||= createApplication();
  const app = await vercelApp;
  await app.init();
  return app.getHttpAdapter().getInstance()(req, res);
}

// Vercel's Node Function runtime needs an exported request handler. Keep the
// regular listener for local/server deployments that run `npm run start:prod`.
export default vercelHandler;
module.exports = vercelHandler;

if (!process.env.VERCEL) {
  void createApplication().then((app) => app.listen(process.env.PORT || 3000));
}
