// Pivot detection and line-fitting primitives used by the pattern detector.

// ---------------- pattern engine ----------------
// Pipeline: candles -> zigzag() reduces noise to a sequence of alternating
// swing highs/lows -> shape matchers look for specific pivot arrangements ->
// each match emits a "badge" (name, bullish/bearish tag, status) plus a
// "proj" (entry/stop/target) built by mkProj.
//
// status meanings, used everywhere downstream:
//   forming    - the shape is present but price hasn't closed beyond the
//                trigger line yet
//   breakout   - price has closed above the line (bullish direction)
//   breakdown  - price has closed below it (bearish direction)
//
// zigzag() is the foundation everything else rests on. It walks the series
// tracking the running extreme in the current direction, and only records a
// pivot once price reverses by more than `thr`. The 2.6x average-range
// threshold is empirical: lower values produce pivots on ordinary noise and
// the matchers start "finding" patterns everywhere; higher values miss real
// structure on quieter instruments. It scales off each series' own average
// range so it adapts to volatile and calm assets alike rather than using a
// fixed percentage.
function zigzag(cs){
  const n=cs.length;
  let avgRange=0; for(const k of cs) avgRange+=k.h-k.l; avgRange/=n;
  const thr=avgRange*2.6, piv=[];
  let dir=0, extP=cs[0].h, extI=0;
  for(let i=1;i<n;i++){
    const k=cs[i];
    if(dir>=0){
      if(k.h>=extP){extP=k.h;extI=i}
      if(extP-k.l>thr){piv.push({i:extI,p:extP,hi:true});dir=-1;extP=k.l;extI=i}
    }
    if(dir<=0){
      if(k.l<=extP){extP=k.l;extI=i}
      if(k.h-extP>thr){piv.push({i:extI,p:extP,hi:false});dir=1;extP=k.h;extI=i}
    }
    if(dir===0) dir=cs[i].c>=cs[0].c?1:-1;
  }
  piv.push({i:extI,p:extP,hi:dir>=0});
  return piv;
}

function lsq(pts){
  const m=pts.length; let sx=0,sy=0,sxx=0,sxy=0;
  for(const q of pts){sx+=q.i;sy+=q.p;sxx+=q.i*q.i;sxy+=q.i*q.p}
  const b=(m*sxy-sx*sy)/Math.max(1e-9,m*sxx-sx*sx);
  return {a:(sy-b*sx)/m, b};
}

// breakout + volume confirmation: a shape is only "confirmed" once price
// actually closes beyond its boundary line, ideally on above-average volume
function checkBreakout(cs, dir, lineAt, fromIdx, toIdx){
  for(let i=Math.max(0,fromIdx); i<=toIdx; i++){
    const lv=lineAt(i);
    if(dir==="up" && cs[i].c>lv) return i;
    if(dir==="down" && cs[i].c<lv) return i;
  }
  return -1;
}

function checkBreakoutEither(cs, specs){
  let best=null;
  for(const s of specs){
    const idx=checkBreakout(cs, s.dir, s.lineAt, s.fromIdx, s.toIdx);
    if(idx>=0 && (!best||idx<best.idx)) best={idx, dir:s.dir};
  }
  return best;
}

function volumeGrade(cs, idx){
  if(idx<0) return null;
  const hasVol=cs.some(k=>k.v>0);
  if(!hasVol) return null;
  const lookback=20; let s=0,c=0;
  for(let i=Math.max(0,idx-lookback);i<idx;i++){s+=cs[i].v;c++}
  const avg=c?s/c:0;
  return avg>0 ? cs[idx].v>avg*1.3 : null;
}

export { zigzag, lsq, checkBreakout, checkBreakoutEither, volumeGrade };
