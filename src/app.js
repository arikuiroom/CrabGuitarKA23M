import {GuitarAudio} from './audio.js?v=18';
import {mountSpriteParts, SPRITE_URLS, SPRITE_HIT_REGIONS} from './sprite-parts.js?v=19';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const audio=new GuitarAudio();
const bases=[82.406889,110,146.832384,195.997718,246.941651,329.627557];
const names=['E','A','D','G','B','E'];
const chords={open:[0,0,0,0,0,0],C:[null,3,2,0,1,0],G:[3,2,0,0,0,3],Am:[null,0,2,2,1,0],Em:[0,2,2,0,0,0]};
let chord='open',muted=false, plucks=0, playEpoch=0, armPointer=null;
const pointers=new Map(), keys=new Set(), flashes=new Map(), palmPointers=new Set();
const board=$('#stringboard'), instrument=$('#instrument'), scene=$('.scene');
mountSpriteParts(instrument);
const {palm: palmRegion, arm: armRegion}=SPRITE_HIT_REGIONS;
const midiName=f=>['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][(Math.round(69+12*Math.log2(f/440))%12+12)%12];
for(let i=0;i<6;i++){
 const b=document.createElement('button');b.className='string-button';b.dataset.string=i;b.style.setProperty('--thickness',`${3-i*.36}px`);b.innerHTML=`<span class="note">${names[i]}</span><span class="wire"></span><span class="number">${6-i}</span>`;b.setAttribute('aria-label',`${6-i}弦 ${names[i]}を弾く`);board.append(b);
 b.addEventListener('click',e=>{if(e.detail===0){play(i);}});
 const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.id=`actual-${i}`;path.setAttribute('d',`M ${635+i*11.4} ${684+i*19.6} L ${1522+i*6.8} ${314+i*19.4}`);path.classList.add('actual-string');$('#actualStrings').append(path);
}
async function play(i,velocity=.72,harmonic=false){harmonic=harmonic&&scene.dataset.preset!=='redbrown';if(armPointer!==null||palmPointers.size||i<0||i>5||chords[chord][i]===null)return;const epoch=playEpoch;const frequency=bases[i]*2**(chords[chord][i]/12);const button=board.children[i],wire=$(`#actual-${i}`);clearTimeout(flashes.get(i));button.classList.remove('playing');button.classList.add('playing');wire.classList.add('playing');flashes.set(i,setTimeout(()=>{button.classList.remove('playing');wire.classList.remove('playing');},500));$('#lastNote').textContent=harmonic?'✧ '+midiName(frequency):midiName(frequency);$('#mood').textContent=harmonic?'✧ キーン':'♪ ぽろん';scene.dataset.plucks=String(++plucks);scene.dataset.lastFrequency=frequency.toFixed(3);scene.dataset.lastTechnique=harmonic?'harmonic':'normal';try{if(audio.context?.state!=='running')await audio.unlock();if(epoch!==playEpoch||palmPointers.size||armPointer!==null)return;if(harmonic)audio.pluckHarmonic(frequency,velocity,i);else audio.pluck(frequency,velocity,i);wakeSound();$('#soundState').textContent=muted?'ミュート中':harmonic?'ピッキングハーモニクス':'音あそび中';$('#soundDot').classList.toggle('on',!muted);}catch(error){$('#soundState').textContent='音を出せませんでした。もう一度タップ';console.error('Audio initialization failed',error);}}
function boardPosition(e){const r=board.getBoundingClientRect(),value=(e.clientX-r.left-5)/(r.width-10)*6-.5;return {value,sides:Array.from({length:6},(_,i)=>value-i),normalX:1,normalY:0,tangentX:0,tangentY:1,along:e.clientY>=r.top&&e.clientY<=r.bottom,inside:e.clientY>=r.top&&e.clientY<=r.bottom&&e.clientX>=r.left&&e.clientX<=r.right};}
function instrumentPosition(e){
 const matrix=$('#actualStrings').getScreenCTM();if(!matrix)return{value:0,inside:false};
 const point=instrument.createSVGPoint();point.x=e.clientX;point.y=e.clientY;
 const {x,y}=point.matrixTransform(matrix.inverse()),armMatrix=$('#tremoloArm').getScreenCTM(),armPoint=armMatrix?point.matrixTransform(armMatrix.inverse()):{x,y};
 const ux=887,uy=-370,dx=x-635,dy=y-684,t=(dx*ux+dy*uy)/(ux*ux+uy*uy),value=(dx*370+dy*887)/(11.4*370+19.6*887);
 const screenX=matrix.a*ux+matrix.c*uy,screenY=matrix.b*ux+matrix.d*uy,length=Math.hypot(screenX,screenY),orientation=Math.sign(matrix.a*matrix.d-matrix.b*matrix.c)||1;
 // Test the actual rendered line equations, including their slightly tapered spacing.
 const sides=Array.from({length:6},(_,i)=>(887-4.6*i)*(y-684-19.6*i)-(-370-.2*i)*(x-635-11.4*i));
 return {value,t,x,y,sides,normalX:-screenY/length*orientation,normalY:screenX/length*orientation,tangentX:screenX/length,tangentY:screenY/length,arm:((armPoint.x-armRegion.x)/armRegion.rx)**2+((armPoint.y-armRegion.y)/armRegion.ry)**2<=1,along:t>=-.03&&t<=1.04,harmonic:scene.dataset.preset!=='redbrown'&&t>=.76&&t<=.98,palm:((x-palmRegion.x)/palmRegion.rx)**2+((y-palmRegion.y)/palmRegion.ry)**2<=1,inside:t>=-.03&&t<=1.04&&value>=-2.75&&value<=7.75};
}
function index(p){return Math.max(0,Math.min(5,Math.round(p.value)));}
function setArmBend(semitones,releasing=false){audio.setBend(semitones,releasing?80:35);scene.dataset.bend=semitones.toFixed(3);$('#tremoloArm').style.transition=releasing?'transform 80ms ease-out':'none';$('#tremoloArm').style.transform=`rotate(${semitones*5}deg)`;scene.classList.toggle('arm-held',!releasing);}
function dampChanged(){audio.setDamped(palmPointers.size>0);scene.classList.toggle('palm-down',palmPointers.size>0);scene.dataset.damped=String(palmPointers.size>0);$('#soundState').textContent=palmPointers.size?'そっと消音中':muted?'ミュート中':'ふれると音が出ます';if(palmPointers.size){++playEpoch;$('#soundDot').classList.remove('on');for(const p of pointers.values())if(p.pending){clearTimeout(p.onsetTimer);p.pending=false;p.cancelled=true;}}}
function crossedIndices(a,b){
 if(!(a.along||a.inside)||!(b.along||b.inside))return [];
 const low=-2.75,high=7.75,delta=b.value-a.value;if(!delta)return [];
 if(Math.max(a.value,b.value)<low||Math.min(a.value,b.value)>high)return [];
 const start=index(a),end=index(b),direction=Math.sign(delta),out=[];
 if(!a.inside)out.push(start);
 for(let i=start+direction;direction*(end-i)>=0;i+=direction)out.push(i);
 return out;
}
function normalCross(a,b){for(const i of crossedIndices(a,b))play(i,.62);}
// Every crossing sounds immediately, with no velocity classifier or cut latch.
function handleStroke(held,p,e){
 if(held.pending){
  if(held.maxDistance<=3&&index(p)===index(held.start)){Object.assign(held,p);return;}
  held.pending=false;play(index(held.start),.62);normalCross(held.start,p);
 }else normalCross(held,p);
 Object.assign(held,p);
}
function attach(surface,position){
 surface.addEventListener('pointerdown',e=>{
  if(e.button!==0&&e.pointerType==='mouse')return;const p=position(e);
  if(armPointer!==null&&!p.arm&&!p.palm)return;if(!p.inside&&!p.palm&&!p.arm&&!p.sides)return;if(p.arm&&armPointer!==null)return;
  e.preventDefault();surface.setPointerCapture(e.pointerId);
  if(p.arm){armPointer=e.pointerId;scene.dataset.armGestures=String(Number(scene.dataset.armGestures||0)+1);++playEpoch;for(const [id,held]of pointers)if(!held.palm){clearTimeout(held.onsetTimer);pointers.delete(id)}const m=$('#actualStrings').getScreenCTM(),ax=m.c-.17*m.a,ay=m.d-.17*m.b,length=Math.hypot(ax,ay);pointers.set(e.pointerId,{surface,arm:true,startX:e.clientX,startY:e.clientY,axisX:ax/length,axisY:ay/length});setArmBend(0);return;}
  if(p.palm){palmPointers.add(e.pointerId);pointers.set(e.pointerId,{surface,palm:true});dampChanged();return;}
  const held={...p,surface,pending:p.inside&&p.harmonic,maxDistance:0,start:p,startX:e.clientX,startY:e.clientY,started:performance.now()};pointers.set(e.pointerId,held);if(audio.context?.state!=='running')audio.unlock().catch(()=>{});
  if(p.inside&&!p.harmonic)play(index(p));
 });
 surface.addEventListener('pointermove',e=>{
  const held=pointers.get(e.pointerId);if(!held||held.palm)return;e.preventDefault();if(held.arm||held.cancelled)return;
  held.maxDistance=Math.max(held.maxDistance,Math.hypot(e.clientX-held.startX,e.clientY-held.startY));
  handleStroke(held,position(e),e);
 });
 for(const ev of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(ev,e=>{
  const held=pointers.get(e.pointerId);if(!held)return;clearTimeout(held.onsetTimer);pointers.delete(e.pointerId);
  if(held.arm){armPointer=null;setArmBend(0,true);}else if(held.palm){palmPointers.delete(e.pointerId);dampChanged();}
  else if(ev==='pointerup'&&!held.cancelled&&!palmPointers.size&&armPointer===null){const p=position(e);held.maxDistance=Math.max(held.maxDistance,Math.hypot(e.clientX-held.startX,e.clientY-held.startY));
   const moved=held.maxDistance>3||index(p)!==index(held.start);
   if(held.pending&&!moved&&p.inside)play(index(held.start),.72,held.start.harmonic&&p.harmonic&&performance.now()-held.started<350);
   else handleStroke(held,p,e);
  }
 });
}
// Arm tracking belongs to the window, not its small visible handle or SVG bounds.
// Capture normally routes every event; window listeners also cover a lost target.
window.addEventListener('pointermove',e=>{const held=pointers.get(e.pointerId);if(!held?.arm)return;e.preventDefault();const delta=(e.clientX-held.startX)*held.axisX+(e.clientY-held.startY)*held.axisY;setArmBend(Math.max(-4,Math.min(4,delta/18*4)));},{passive:false});
for(const type of ['pointerup','pointercancel'])window.addEventListener(type,e=>{if(e.pointerId!==armPointer)return;pointers.delete(e.pointerId);armPointer=null;setArmBend(0,true);});
attach(board,boardPosition);attach(instrument,instrumentPosition);
function selectChord(b){chord=b.dataset.chord;$$('[data-chord]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));for(let i=0;i<6;i++){const disabled=chords[chord][i]===null,f=bases[i]*2**((chords[chord][i]||0)/12),note=disabled?'×':midiName(f);board.children[i].querySelector('.note').textContent=note;board.children[i].classList.toggle('disabled',disabled);board.children[i].setAttribute('aria-label',disabled?`${6-i}弦はこのコードでは鳴らしません`:`${6-i}弦 ${note}を弾く`);}$('#mood').textContent=chord==='open'?'きいてるよ':`${chord} のきぶん`;}
$$('[data-chord]').forEach(b=>{b.addEventListener('pointerdown',e=>{if(e.button!==0&&e.pointerType==='mouse')return;e.preventDefault();selectChord(b);});b.addEventListener('click',e=>{if(e.detail===0)selectChord(b);});});
$('#mute').addEventListener('click',()=>{muted=!muted;audio.mute(muted);wakeSound();$('#mute').setAttribute('aria-pressed',String(muted));$('#mute').setAttribute('aria-label',muted?'ミュートを解除する':'ミュートにする');$('#soundState').textContent=muted?'ミュート中':'ふれると音が出ます';$('#soundDot').classList.toggle('on',!muted);});
$('#volume').addEventListener('input',e=>{audio.setVolume(Number(e.target.value)/100);wakeSound();$('#volumeValue').value=`${e.target.value}%`;});audio.setVolume(.45);
$('#stop').addEventListener('click',()=>{++playEpoch;audio.stopAll();$('#soundState').textContent='音を止めました';});
window.addEventListener('keydown',e=>{if(e.repeat||e.ctrlKey||e.metaKey||e.altKey||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;const i=Number(e.key)-1;if(i>=0&&i<6&&Number.isInteger(i)){e.preventDefault();keys.add(e.key);play(i);}});
window.addEventListener('keyup',e=>{keys.delete(e.key)});
function reset(){cancelAnimationFrame(meterFrame);meterFrame=0;scene.classList.remove('happy');sounding=false;quietSince=null;flutterEnvelope=0;flutterPeak=0;flutterVoice=null;setFlutterAmount(0);scene.dataset.audible='false';++playEpoch;armPointer=null;setArmBend(0,true);for(const p of pointers.values())clearTimeout(p.onsetTimer);pointers.clear();palmPointers.clear();keys.clear();audio.setDamped(false);scene.classList.remove('palm-down');scene.dataset.damped='false';audio.stopAll();}
window.addEventListener('blur',reset);document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});

// Effects use one persistent audio graph; UI buttons are siblings of the SVG,
// so tapping a control never enters the instrument pointer handlers.
const presets={red:{name:'赤',tone:'澄んだ響き',rgb:null},mint:{name:'ミントグリーン',tone:'ファンク',rgb:[.56,.87,.70]},black:{name:'黒',tone:'メタル',rgb:[.065,.07,.08]},darkbrown:{name:'焦茶',tone:'ナイロン',rgb:[.22,.11,.06]},redbrown:{name:'赤茶色',tone:'軽やかウクレレ',rgb:[.51,.20,.10]}};
function selectPreset(id){const p=presets[id];if(!p)return;++playEpoch;for(const held of pointers.values())if(held.pending){clearTimeout(held.onsetTimer);held.pending=false;held.cancelled=true;}audio.setPreset(id);scene.dataset.preset=id;$$('button[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===id)));$('#harmonicHint').style.display=id==='redbrown'?'none':'';$('#presetName').textContent=`${p.name} · ${p.tone}`;$('#instrument').setAttribute('aria-label',`${p.name}のカニギター。一つの大きなハサミと四本の小さな足。弦にふれると音が出ます。`);for(const image of $$('.painted-sprite')){image.setAttribute('href',SPRITE_URLS[id]);image.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',SPRITE_URLS[id]);}}
// Bounded five-resource browser image cache, warmed before the first color change.
const colorImages=Object.keys(presets).map(id=>{const image=new Image();image.src=SPRITE_URLS[id];image.decode?.().catch(()=>{});return image;});
$$('button[data-preset]').forEach(b=>b.addEventListener('click',()=>selectPreset(b.dataset.preset)));
selectPreset('red');

// Animate only measured sound at the final master output, including reverb tails.
// Hysteresis and a short quiet hold prevent flicker between waveform crossings.
let sounding=false,quietSince=null,lastMeter=0,meterFrame=0,lastSoundWake=0,lastLevelWrite=0;
let flutterEnvelope=0,flutterPeak=0,flutterVoice=null,flutterAmount=0;
function wakeSound(){
 lastSoundWake=performance.now();
 // A new voice re-normalizes this note's measured attack, including quiet nylon.
 // Volume/mute wakes must not turn an existing, fading note back into a full flap.
 const newest=audio.voices[audio.voices.length-1];
 if(newest&&newest!==flutterVoice&&newest.start>=(flutterVoice?.start??-Infinity)){flutterVoice=newest;flutterPeak=0;flutterEnvelope=0;}
 if(!meterFrame&&!document.hidden)meterFrame=requestAnimationFrame(watchSound);
}
function setMetric(name,value){if(scene.dataset[name]!==value)scene.dataset[name]=value;}
function setFlutterAmount(amount){
 // One quantized property, at the meter's 30 Hz cadence, drives all five limbs.
 // Keep each CSS animation's phase; never restart animations for meter samples.
 const next=Math.round(Math.max(0,Math.min(1,amount))*200)/200;
 if(next!==flutterAmount){flutterAmount=next;scene.style.setProperty('--flutter-amount',String(next));}
}
function watchSound(now){
 meterFrame=0;let level=0;
 if(now-lastMeter>=30){
  const elapsed=Math.min(100,now-lastMeter);lastMeter=now;
  level=audio.readOutputLevel();
  if(now-lastLevelWrite>=180||level===0||(!sounding&&level>.0004)){setMetric('outputLevel',level.toFixed(6));lastLevelWrite=now;}
  // Fast attack, gentle release, and a held per-note peak follow the audible
  // envelope without normalizing every quiet sample back up to full movement.
  flutterEnvelope+=(level-flutterEnvelope)*(1-Math.exp(-elapsed/(level>flutterEnvelope?24:120)));
  flutterPeak=Math.max(flutterPeak,level);
  if(level>0.0004){quietSince=null;if(!sounding){sounding=true;scene.classList.add('happy');scene.dataset.dances=String(Number(scene.dataset.dances||0)+1);$('#mood').textContent='♪ ぱたぱた';}}
  else if(sounding&&level<0.00018){quietSince??=now;if(now-quietSince>=100){sounding=false;scene.classList.remove('happy');$('#mood').textContent='もういっかい？';}}
  else if(level>=0.00018)quietSince=null;
  // The power curve retains a small, readable tail; the final quiet hold brings
  // it smoothly to exact zero, including Stop, palm mute and volume zero.
  const relative=Math.max(0,flutterEnvelope-.00018)/Math.max(.0004,flutterPeak-.00018);
  const quietFade=quietSince===null?1:Math.max(0,1-(now-quietSince)/100);
  setFlutterAmount(sounding?Math.pow(Math.min(1,relative),.7)*quietFade:0);
  setMetric('audible',String(sounding));
 }
 // End the single meter loop after the voices and audible tail have drained.
 // Muted/zero-volume output need not keep sampling silent, still-live sources.
 const forcedQuiet=muted||audio.volume<=0||audio.context?.state!=='running';
 const drained=!sounding&&(forcedQuiet||(!audio.liveVoices.size&&now-lastSoundWake>500));
 if(!document.hidden&&!drained)meterFrame=requestAnimationFrame(watchSound);
 else if(drained){flutterEnvelope=0;if(!audio.liveVoices.size){flutterPeak=0;flutterVoice=null;}setFlutterAmount(0);}
}
