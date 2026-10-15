import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSpritePainter} from '../../src/sprite-parts.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(options={}){
 const nodes=[];const svg={dataset:{},setAttribute(){},querySelectorAll:()=>nodes};
 function node(attrs={}){return {attrs,cloneNode:()=>node({...attrs}),setAttribute(k,v){this.attrs[k]=v;},setAttributeNS(ns,k,v){this.attrs[k]=v;},replaceWith(next){nodes[nodes.indexOf(this)]=next;}};}
 for(let i=0;i<7;i++)nodes.push(node());
 const pending=[];const painter=createSpritePainter(svg,{loadTimeout:60,decodeTimeout:10,createImage:()=>{const image={naturalWidth:0,decode:()=>Promise.resolve(),src:''};pending.push(image);return image;},...options});
 const load=(n=0)=>{pending[n].naturalWidth=2048;pending[n].onload?.();};
 return {svg,nodes,pending,painter,load};
}
test('initial delayed load commits seven fresh nodes only after decoding',async()=>{
 const f=fixture();const original=[...f.nodes];const ready=f.painter.select('red');
 assert.equal(f.pending.length,1);assert.equal(f.svg.dataset.spriteState,'loading');assert.equal(f.nodes[0].attrs.href,undefined);
 let decode;f.pending[0].decode=()=>new Promise(r=>decode=r);f.load();await tick();assert.equal(f.nodes[0].attrs.href,undefined);decode();assert.equal(await ready,true);
 assert.equal(f.svg.dataset.spriteState,'ready');f.nodes.forEach((n,i)=>{assert.notEqual(n,original[i]);assert.match(n.attrs.href,/red.png/);assert.equal(n.attrs.href,n.attrs['xlink:href']);});
});
test('rejected decode falls back to successful load; hung decode is bounded',async()=>{
 for(const decode of [()=>Promise.reject(Error('decode')),()=>new Promise(()=>{})]){const f=fixture();const p=f.painter.select('red');f.pending[0].decode=decode;f.load();assert.equal(await p,true);assert.equal(f.svg.dataset.spriteState,'ready');}
});
test('failed first request retries only current sheet',async()=>{
 const f=fixture();const p=f.painter.select('mint');f.pending[0].onerror();await tick();assert.equal(f.pending.length,2);assert.match(f.pending[1].src,/mint.png.*paintRetry=1/);f.load(1);assert.equal(await p,true);
});
test('rapid switch cancels stale completion and retains old artwork while loading',async()=>{
 const f=fixture();let p=f.painter.select('red');f.load();await p;
 p=f.painter.select('mint');const oldLoad=f.pending[1].onload;const latest=f.painter.select('black');assert.match(f.nodes[0].attrs.href,/red.png/);assert.equal(await p,false);
 oldLoad();await tick();assert.match(f.nodes[0].attrs.href,/red.png/);f.load(2);assert.equal(await latest,true);assert.match(f.nodes[0].attrs.href,/black.png/);assert.equal(f.svg.dataset.spriteDisplayed,'black');
});
test('two failed loads stop; selecting same button retries after fallback',async()=>{
 const f=fixture();let p=f.painter.select('red');f.pending[0].onerror();await tick();f.pending[1].onerror();assert.equal(await p,false);assert.equal(f.svg.dataset.spriteState,'error');assert.equal(f.pending.length,2);
 p=f.painter.select('red');assert.equal(f.pending.length,3);f.load(2);assert.equal(await p,true);
});
test('load timeouts are bounded and preserve existing ready artwork',async()=>{
 const f=fixture({loadTimeout:5});let p=f.painter.select('red');f.load();await p;
 assert.equal(await f.painter.select('black'),false);assert.equal(f.pending.length,3);assert.match(f.nodes[0].attrs.href,/red.png/);assert.equal(f.svg.dataset.spriteState,'error');
});
