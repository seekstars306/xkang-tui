import path from 'node:path';
import { CodeGraphService } from '../../server/src/codegraph/service.ts';
const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const graph = new CodeGraphService(root, out);
const result = await graph.rebuildIndex();
console.log(JSON.stringify({root, out, stats: result.stats}));
