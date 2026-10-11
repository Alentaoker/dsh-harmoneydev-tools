import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const out=await build({entryPoints:['vendor/lib/harmony/media/hos-packets.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {HosVideoPacketizer}=await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);
// Baseline SPS with cropped height: 1280 x 720.
const sps=Buffer.from('6742c01fda014016ec0440000003004000000c83c60c658','hex');
const pps=Buffer.from('68ce3c80','hex');
const annex=(...units)=>Buffer.concat(units.flatMap(x=>[Buffer.from([0,0,0,1]),x]));
test('SPS supplies cropped dimensions and configuration precedes the first picture',()=>{
 const packets=new HosVideoPacketizer().push(annex(sps,pps,Buffer.from([0x65,1,2])));
 assert.equal(packets.length,2);assert.equal(packets[0].readUInt32BE(),2);
 assert.equal(packets[0].readUInt32BE(9),1280);assert.equal(packets[0].readUInt32BE(13),720);
 assert.equal(packets[1].readUInt32BE(),3);assert.equal(packets[1][8],1);
});
test('changed parameter sets reconfigure and malformed SPS cannot invent dimensions',()=>{
 const p=new HosVideoPacketizer();assert.deepEqual(p.push(annex(Buffer.from([0x67,1,2]),pps,Buffer.from([0x65,1]))),[]);
 assert.equal(p.push(annex(sps,pps,Buffer.from([0x65,1]))).length,2);
 assert.equal(p.push(annex(Buffer.from([0x41,2]))).length,1);
 assert.equal(p.push(annex(sps,Buffer.from('68ce3c81','hex'),Buffer.from([0x65,1])))[0].readUInt32BE(),2);
});

test('change-driven video is explicitly marked without changing the default protocol',()=>{
 const bytes=annex(sps,pps,Buffer.from([0x65,1]));
 const ordinary=new HosVideoPacketizer().push(bytes)[0];
 const changeDriven=new HosVideoPacketizer(30,true).push(bytes)[0];
 assert.equal(changeDriven.length,ordinary.length+1);
 assert.equal(changeDriven.at(-1),1);
 assert.equal(changeDriven.readUInt32BE(4),ordinary.readUInt32BE(4)+1);
});
