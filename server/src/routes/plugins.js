import express from 'express';
import { get } from '../db.js';
import { HttpError } from './auth.js';
import { listPlugins, loadPlugins, setPluginEnabled } from '../plugins.js';

/** The Plugins page. Anyone signed in can look; only the person who created the first account can change anything. */
export const pluginsRouter = express.Router();

const isOwner = async (req) => (await get('SELECT id FROM users ORDER BY created_at, id LIMIT 1'))?.id === req.user.id;

async function requireOwner(req) {
  if (!(await isOwner(req))) throw new HttpError(403, 'Only the owner of this LiteForeFlow (the first account) can turn plugins on or off');
}

pluginsRouter.get('/', async (req, res) => {
  const canManage = await isOwner(req); // lets the page grey out the buttons for everyone else
  res.json(listPlugins().map((p) => ({ ...p, canManage })));
});

pluginsRouter.post('/reload', async (req, res) => {
  await requireOwner(req);
  res.json(await loadPlugins());
});

pluginsRouter.post('/:id/:action(enable|disable)', async (req, res) => {
  await requireOwner(req);
  res.json(await setPluginEnabled(req.params.id, req.params.action === 'enable'));
});
