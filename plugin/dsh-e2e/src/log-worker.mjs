import { parentPort, workerData } from 'node:worker_threads';
import { indexLog, blockPage, materializeLog } from './log-storage.mjs';
const operations = { index: indexLog, page: blockPage, materialize: materializeLog };
try { const fn = operations[workerData.operation]; if (!fn) throw Error('无效日志后台任务'); const value = await fn(workerData.payload, progress => parentPort.postMessage({ progress })); parentPort.postMessage({ value }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
