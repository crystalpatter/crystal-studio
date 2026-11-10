// Local look-and-feel server: the pretend Meta API plus the dev server in one
// process, using the pretend data from dev/preview-data.js.
import { startPreviewGraph } from './preview-data.js';
await startPreviewGraph(Number(new URL(process.env.GRAPH_BASE || 'http://localhost:5199').port));
await import('./server.js');
