import type { FastifyInstance } from 'fastify';
import settings from './settings.js';
import taxonomy from './taxonomy.js';
import products from './products.js';
import ops from './ops.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(settings);
  await app.register(taxonomy);
  await app.register(products);
  await app.register(ops);
}
