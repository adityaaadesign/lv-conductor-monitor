// Cloudflare Worker entry point. The configuration files are bundled into the Worker
// when it is built (a Worker cannot read files at run time). After changing anything in
// config/, deploy again: npm run cf:deploy
//
// Logic: ./app.js. Setup: docs/DEPLOYMENT.md.

import feeder from '../../config/feeder.json' with { type: 'json' };
import detection from '../../config/detection.json' with { type: 'json' };
import server from '../../config/server.json' with { type: 'json' };
import { createApp } from './app.js';

export default createApp({ files: { feeder, detection, server } });
