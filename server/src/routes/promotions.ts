import type { FastifyInstance } from 'fastify';
import { runJob } from '../jobs/scheduler.js';
import { deletePromotion, listPromotions, savePromotion, setPortalUrl, syncTargetPromotions } from '../services/promotions.js';

export default async function (app: FastifyInstance) {
  app.get('/api/promotions', async () => listPromotions());
  app.post('/api/promotions', async (req) => savePromotion(req.body as any));
  app.put('/api/promotions/:id', async (req) => savePromotion(req.body as any, Number((req.params as any).id)));
  app.delete('/api/promotions/:id', async (req) => deletePromotion(Number((req.params as any).id)));
  app.post('/api/promotions/sync-target', async () => runJob('promotions-target', syncTargetPromotions));
  app.put('/api/promotions/portal-url', async (req) => setPortalUrl((req.body as any)?.url));
}
