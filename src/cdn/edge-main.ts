import { storageFromEnv } from '../storage/storage';
import { createEdge } from './edge';

const port = Number(process.env.EDGE_PORT ?? 8088);
const { server } = createEdge(storageFromEnv());
server.listen(port, '127.0.0.1', () => {
  console.log(`edge listening on http://127.0.0.1:${port} (serves assets/*)`);
});
