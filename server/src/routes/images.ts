import type { FastifyInstance } from 'fastify';
import { imageEditor, pushImages, saveImagePlan } from '../services/images.js';

export default async function (app: FastifyInstance) {
  app.get('/api/products/:id/images', async (req) => imageEditor((req.params as any).id));
  app.put('/api/products/:id/images', async (req) => saveImagePlan((req.params as any).id, ((req.body ?? {}) as any).plan));
  app.post('/api/products/:id/images/push', async (req) => pushImages((req.params as any).id, ((req.body ?? {}) as any)));
}
