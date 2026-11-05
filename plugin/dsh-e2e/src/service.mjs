import {join} from 'node:path';
import {homedir} from 'node:os';
import {createLogLibrary} from './log-library.mjs';
import {listLogSessionLabels} from './log-management.mjs';
// Keep existing absolute analysis paths valid; never migrate or delete old data.
export const LEGACY_STORAGE_DIR='dshE2E';
export const dataRoot=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'storages',LEGACY_STORAGE_DIR);
export function createLogService(ctx,root=dataRoot){const logLibrary=createLogLibrary(root,{listSessions:()=>listLogSessionLabels(ctx)});return {logLibrary,dispose:()=>logLibrary.dispose()};}
