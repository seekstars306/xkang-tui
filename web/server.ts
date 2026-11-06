import { startWebServer } from '../src/web_server.js';
await startWebServer({ autoOpen: process.env.WEB_NO_OPEN !== '1' });
