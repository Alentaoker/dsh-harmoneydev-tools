import {mkdirSync} from 'node:fs';
import {setHost,dataRoot} from './state';
import {getHarmonyDeviceManager} from '../vendor/lib/harmony';
import {routes} from './routes';
export const name='dshHarmony';
export const inject=['connection','sessions','llm','attachments'];
export function apply(ctx:any){mkdirSync(dataRoot,{recursive:true});setHost(ctx);for(const route of routes)ctx.effect(()=>ctx.connection.fetch.register(route),'dshHarmony: '+route.path);ctx.effect(()=>async()=>{await getHarmonyDeviceManager().dispose();},'dshHarmony: cleanup');}
