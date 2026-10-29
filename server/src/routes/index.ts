import type { FastifyInstance } from 'fastify';
import settings from './settings.js';
import taxonomy from './taxonomy.js';
import products from './products.js';
import ops from './ops.js';
import grid from './grid.js';
import golive from './golive.js';
import images from './images.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(settings);
  await app.register(taxonomy);
  await app.register(products);
  await app.register(ops);
  await app.register(grid);
  await app.register(golive);
  await app.register(images);
}
