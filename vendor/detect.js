import { zigzag, lsq, checkBreakout, checkBreakoutEither, volumeGrade } from './zigzag.js';
import { C } from './theme.js';

function detectPatterns(cs){
  const piv=zigzag(cs), overlays=[], badges=[], n=cs.length;
  let lo=Infinity, hi=-Infinity;
  for(const k of cs){lo=Math.min(lo,k.l);hi=Math.max(hi,k.h)}
  const range=hi-lo;
  const tail=piv.slice(-6);
  const seq=(kinds,from)=>{
    for(let s=tail.length-kinds.length;s>=Math.max(0,tail.length-kinds.length-from);s--){
      const win=tail.slice(s,s+kinds.length);
      if(win.length===kinds.length && win.every((p,j)=>p.hi===kinds[j])) return win;
    }
    return null;
  };
  // measured move: project pattern height from entry, stop at invalidation → target + R:R
  const mkProj=(dir,entry,stop,height,brkX,firm)=>{
    const target = dir==="up" ? entry+height : entry-height;
    const risk = Math.abs(entry-stop), reward = Math.abs(target-entry);
    const rr = risk>0 ? reward/risk : null;
    const x0 = brkX>=0 ? brkX : Math.max(0, n-14);
    overlays.push({t:"tgt",kind:"entry", p:entry, x0, dash:true});
    overlays.push({t:"tgt",kind:"stop",  p:stop,  x0, dash:!firm});
    overlays.push({t:"tgt",kind:"target",p:target,x0, dir, dash:!firm});
    return {dir, entry, stop, target, risk, reward, rr, firm};
  };
  let m=seq([true,false,true,false,true],2); // 5-point peaks
  if(m){
    const [p1,p2,p3,p4,p5]=m;
    const h1=p1.p, l1=p2.p, h2=p3.p, l2=p4.p, h3=p5.p;
    const maxH=Math.max(h1,h2,h3), minH=Math.min(h1,h2,h3);
    const avgH=(h1+h2+h3)/3, avgL=(l1+l2)/2;
    // Triple Top: all 3 highs are roughly equal
    if(maxH-minH < 0.2*(avgH-avgL) && avgH-avgL > range*0.04 && !badges.length){
      const brk=checkBreakout(cs,"down",()=>avgL,p5.i,n-1);
      const status=brk>=0?"breakdown":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p1.i,p1:avgL,x2:n-1,p2:avgL,col:C.dn,dash:true},
        {t:"lab",x:p3.i,p:h2,txt:"Triple Top"+(status==="breakdown"?" ▼":""),above:true,col:status==="breakdown"?C.dn:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"down",col:C.dn});
      badges.push({name:"Triple Top",tag:"reversal · bearish",status,vol,brk,proj:mkProj("down", avgL, avgH, avgH-avgL, brk, brk>=0)});
    }
    // Head & Shoulders
    else if(h2>h1 && h2>h3 && Math.abs(h1-h3)<0.35*(h2-Math.max(l1,l2)) && h2-h1>range*0.03 && !badges.length){
      const nk=lsq([p2,p4]), neck=i=>nk.a+nk.b*i;
      const brk=checkBreakout(cs,"down",neck,p5.i,n-1);
      const status=brk>=0?"breakdown":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p2.i,p1:neck(p2.i),x2:n-1,p2:neck(n-1),col:C.dn,dash:true},
        {t:"lab",x:p3.i,p:h2,txt:"Head and Shoulders"+(status==="breakdown"?" ▼":""),above:true,col:status==="breakdown"?C.dn:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"down",col:C.dn});
      badges.push({name:"Head and Shoulders",tag:"reversal · bearish",status,vol,brk,proj:mkProj("down", brk>=0?neck(brk):neck(n-1), Math.max(h1,h3), h2-neck(p3.i), brk, brk>=0)});
    }
    // Cup & Handle (Bearish / Inverse Cup and Handle) - M shape but the middle low is very deep, the last high is shallow
    else if(Math.abs(l1-l2)<0.3*(h2-l1) && h1>h2 && h3>l2 && h3<l2+(h2-l2)*0.5 && !badges.length){
      const neck=l1;
      const brk=checkBreakout(cs,"down",()=>neck,p5.i,n-1);
      const status=brk>=0?"breakdown":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p2.i,p1:neck,x2:n-1,p2:neck,col:C.dn,dash:true},
        {t:"lab",x:p3.i,p:h2,txt:"Inverse Cup and Handle"+(status==="breakdown"?" ▼":""),above:true,col:status==="breakdown"?C.dn:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"down",col:C.dn});
      badges.push({name:"Inverse Cup and Handle",tag:"continuation · bearish",status,vol,brk,proj:mkProj("down", neck, Math.max(h1,h3), h2-neck, brk, brk>=0)});
    }
    // Bearish Harmonic (Gartley / Cypher) approximation
    else if(h1>h3 && l1<l2 && h2<h1 && !badges.length) {
      // W shape with specific lower highs/lows
      const name = h3>h2 ? "Cypher (Bearish)" : "Gartley (Bearish)";
      badges.push({name, tag:"harmonic · bearish", status:"forming", vol:null, brk:-1, proj:null});
      overlays.push({t:"poly",pts:m,col:C.dn}, {t:"lab",x:p3.i,p:h2,txt:name,above:true,col:C.dn});
    }
  }

  m=seq([false,true,false,true,false],2); // 5-point troughs
  if(m && !badges.length){
    const [p1,p2,p3,p4,p5]=m;
    const l1=p1.p, h1=p2.p, l2=p3.p, h2=p4.p, l3=p5.p;
    const maxL=Math.max(l1,l2,l3), minL=Math.min(l1,l2,l3);
    const avgL=(l1+l2+l3)/3, avgH=(h1+h2)/2;
    // Triple Bottom
    if(maxL-minL < 0.2*(avgH-avgL) && avgH-avgL > range*0.04){
      const brk=checkBreakout(cs,"up",()=>avgH,p5.i,n-1);
      const status=brk>=0?"breakout":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p1.i,p1:avgH,x2:n-1,p2:avgH,col:C.up,dash:true},
        {t:"lab",x:p3.i,p:l2,txt:"Triple Bottom"+(status==="breakout"?" ▲":""),above:false,col:status==="breakout"?C.up:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"up",col:C.up});
      badges.push({name:"Triple Bottom",tag:"reversal · bullish",status,vol,brk,proj:mkProj("up", avgH, avgL, avgH-avgL, brk, brk>=0)});
    }
    // Inverse Head & Shoulders
    else if(l2<l1 && l2<l3 && Math.abs(l1-l3)<0.35*(Math.min(h1,h2)-l2) && l1-l2>range*0.03){
      const nk=lsq([p2,p4]), neck=i=>nk.a+nk.b*i;
      const brk=checkBreakout(cs,"up",neck,p5.i,n-1);
      const status=brk>=0?"breakout":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p2.i,p1:neck(p2.i),x2:n-1,p2:neck(n-1),col:C.up,dash:true},
        {t:"lab",x:p3.i,p:l2,txt:"Inverse Head and Shoulders"+(status==="breakout"?" ▲":""),above:false,col:status==="breakout"?C.up:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"up",col:C.up});
      badges.push({name:"Inverse Head and Shoulders",tag:"reversal · bullish",status,vol,brk,proj:mkProj("up", brk>=0?neck(brk):neck(n-1), Math.min(l1,l3), neck(p3.i)-l2, brk, brk>=0)});
    }
    // Cup & Handle - W shape but middle high is very high, last low is shallow
    else if(Math.abs(h1-h2)<0.3*(h1-l2) && l1<l2 && l3<h2 && l3>h2-(h2-l2)*0.5){
      const neck=h1;
      const brk=checkBreakout(cs,"up",()=>neck,p5.i,n-1);
      const status=brk>=0?"breakout":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:p2.i,p1:neck,x2:n-1,p2:neck,col:C.up,dash:true},
        {t:"lab",x:p3.i,p:l2,txt:"Cup and Handle"+(status==="breakout"?" ▲":""),above:false,col:status==="breakout"?C.up:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"up",col:C.up});
      badges.push({name:"Cup and Handle",tag:"continuation · bullish",status,vol,brk,proj:mkProj("up", neck, Math.min(l1,l3), neck-l2, brk, brk>=0)});
    }
    // Bullish Harmonic (Gartley / Cypher) approximation
    else if(l1<l3 && h1>h2 && l2>l1) {
      // M shape with specific higher lows/highs
      const name = l3<l2 ? "Cypher (Bullish)" : "Gartley (Bullish)";
      badges.push({name, tag:"harmonic · bullish", status:"forming", vol:null, brk:-1, proj:null});
      overlays.push({t:"poly",pts:m,col:C.up}, {t:"lab",x:p3.i,p:l2,txt:name,above:false,col:C.up});
    }
  }

  m=seq([true,false,true],2); // double top
  if(m && !badges.length){
    const [h1,lM,h2]=m;
    if(Math.abs(h1.p-h2.p)<0.3*((h1.p+h2.p)/2-lM.p) && h1.p-lM.p>range*0.04){
      const brk=checkBreakout(cs,"down",()=>lM.p,h2.i,n-1);
      const status=brk>=0?"breakdown":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:h1.i,p1:lM.p,x2:n-1,p2:lM.p,col:C.dn,dash:true},
        {t:"lab",x:h2.i,p:h2.p,txt:"Double Top"+(status==="breakdown"?" ▼":""),above:true,col:status==="breakdown"?C.dn:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"down",col:C.dn});
      badges.push({name:"Double Top",tag:"reversal · bearish",status,vol,brk,proj:mkProj("down", lM.p, Math.max(h1.p,h2.p), (h1.p+h2.p)/2-lM.p, brk, brk>=0)});
    }
  }
  m=seq([false,true,false],2); // double bottom
  if(m && !badges.length){
    const [l1,hM,l2]=m;
    if(Math.abs(l1.p-l2.p)<0.3*(hM.p-(l1.p+l2.p)/2) && hM.p-l1.p>range*0.04){
      const brk=checkBreakout(cs,"up",()=>hM.p,l2.i,n-1);
      const status=brk>=0?"breakout":"forming", vol=volumeGrade(cs,brk);
      overlays.push(
        {t:"poly",pts:m,col:C.amber},
        {t:"seg",x1:l1.i,p1:hM.p,x2:n-1,p2:hM.p,col:C.up,dash:true},
        {t:"lab",x:l2.i,p:l2.p,txt:"Double Bottom"+(status==="breakout"?" ▲":""),above:false,col:status==="breakout"?C.up:C.amber});
      if(brk>=0) overlays.push({t:"brk",x:brk,p:cs[brk].c,dir:"up",col:C.up});
      badges.push({name:"Double Bottom",tag:"reversal · bullish",status,vol,brk,proj:mkProj("up", hM.p, Math.min(l1.p,l2.p), hM.p-(l1.p+l2.p)/2, brk, brk>=0)});
    }
  }

  // triangles / wedges / channels / flags / pennants from trendline fits
  const phs=piv.filter(p=>p.hi).slice(-5), pls=piv.filter(p=>!p.hi).slice(-5);
  if(phs.length>=2 && pls.length>=2 && !badges.length){
    const U=lsq(phs.slice(-4)), L=lsq(pls.slice(-4));
    const x0=Math.min(phs[phs.length-2].i,pls[pls.length-2].i), x1=n-1, span=Math.max(1,x1-x0);
    const sU=(U.b*span)/range, sL=(L.b*span)/range;
    const cls=s=>Math.abs(s)<0.18?0:s>0?1:-1;
    const cU=cls(sU), cL=cls(sL);
    const g0=(U.a+U.b*x0)-(L.a+L.b*x0), g1=(U.a+U.b*x1)-(L.a+L.b*x1);
    const converging=g1<g0*0.72, parallel=Math.abs(g1-g0)<=Math.abs(g0)*0.28, widening=g1>g0*1.3;
    let name=null, tag="";
    
    // Check for prior strong trend for flags/pennants (the "pole")
    const poleStart = Math.max(0, x0 - 20);
    let poleDir = 0; // 1 up, -1 down
    if(cs[x0].c - cs[poleStart].c > range * 0.4) poleDir = 1;
    else if(cs[poleStart].c - cs[x0].c > range * 0.4) poleDir = -1;

    // Diamond pattern approximation: widening then converging (using 6 pivots)
    if(phs.length>=3 && pls.length>=3) {
      const midH = phs[phs.length-2].p, prevH = phs[phs.length-3].p, lastH = phs[phs.length-1].p;
      const midL = pls[pls.length-2].p, prevL = pls[pls.length-3].p, lastL = pls[pls.length-1].p;
      if(midH > prevH && midH > lastH && midL < prevL && midL < lastL) {
        name = "Diamond"; tag = "reversal";
      }
    }

    if(!name) {
      if(cU===0&&cL===1){name="Ascending Triangle";tag="bilateral · bullish lean"}
      else if(cU===-1&&cL===0){name="Descending Triangle";tag="bilateral · bearish lean"}
      else if(cU===-1&&cL===1){
        if(span < 20 && poleDir===1) {name="Bullish Pennant"; tag="continuation · bullish";}
        else if(span < 20 && poleDir===-1) {name="Bearish Pennant"; tag="continuation · bearish";}
        else {name="Symmetrical Triangle";tag="bilateral";}
      }
      else if(cU===1&&cL===1){
        // Both trendlines rising. Parallel + short + a DOWN pole is the
        // plain Bearish Flag — the mirror of Bullish Flag below. Converging
        // + short + a DOWN pole is the same idea but wedge-shaped. Both
        // drift counter to the pole, matching standard flag definitions.
        // (Previously only the wedge variant was handled here — a plain
        // parallel bearish flag fell through and got labeled "Channel".)
        if(parallel && span < 20 && poleDir===-1) {name="Bearish Flag"; tag="continuation · bearish";}
        else if(converging && span<20 && poleDir===-1){ name="Bearish Wedge Flag"; tag="continuation · bearish"; }
        else {name=converging?"Ascending Wedge":"Channel";tag=converging?"usually bearish":"continuation"}
      }
      else if(cU===-1&&cL===-1){
        // Both trendlines falling. Parallel + short + an UP pole is the
        // classic Bullish Flag; converging + short + an UP pole is the same
        // idea but wedge-shaped. Both drift counter to the pole, matching
        // standard flag-pattern definitions.
        if(parallel && span < 20 && poleDir===1) {name="Bullish Flag"; tag="continuation · bullish";}
        else if(converging && span<20 && poleDir===1){ name="Bullish Wedge Flag"; tag="continuation · bullish"; }
        else {name=converging?"Descending Wedge":"Channel";tag=converging?"usually bullish":"continuation"}
      }
      else if(cU===0&&cL===0&&parallel){
        name="Livermore Cylinder";tag="accumulation · breakout expected";
      }
      else if(widening){name="Megaphone";tag="broadening · volatility expanding"}
    }

    if(name){
      const win=Math.max(x0,n-8);
      const brkHit=checkBreakoutEither(cs,[
        {dir:"up",  lineAt:i=>U.a+U.b*i, fromIdx:win, toIdx:n-1},
        {dir:"down",lineAt:i=>L.a+L.b*i, fromIdx:win, toIdx:n-1},
      ]);
      const status=brkHit?(brkHit.dir==="up"?"breakout":"breakdown"):"forming";
      const vol=brkHit?volumeGrade(cs,brkHit.idx):null;
      const stCol=status==="breakout"?C.up:status==="breakdown"?C.dn:C.amber;
      
      if(name==="Diamond") {
        const midH = phs[phs.length-2], prevH = phs[phs.length-3], lastH = phs[phs.length-1];
        const midL = pls[pls.length-2], prevL = pls[pls.length-3], lastL = pls[pls.length-1];
        overlays.push({t:"poly", pts:[prevL, midH, lastL, midL, prevH], col:C.amber});
        overlays.push({t:"lab",x:midH.i,p:midH.p,txt:name,above:true,col:stCol});
      } else {
        overlays.push(
          {t:"seg",x1:x0,p1:U.a+U.b*x0,x2:x1,p2:U.a+U.b*x1,col:"rgba(232,184,75,0.9)"},
          {t:"seg",x1:x0,p1:L.a+L.b*x0,x2:x1,p2:L.a+L.b*x1,col:"rgba(232,184,75,0.9)"},
          {t:"fill",x0,x1,U,L},
          {t:"lab",x:Math.round((x0+x1)/2),p:(U.a+L.a)/2+((U.b+L.b)/2)*((x0+x1)/2),
            txt:name+(status==="breakout"?" ▲":status==="breakdown"?" ▼":""),mid:true,col:stCol});
      }
      
      if(brkHit) overlays.push({t:"brk",x:brkHit.idx,p:cs[brkHit.idx].c,dir:brkHit.dir,col:stCol});
      let proj=null;
      if(brkHit && name!=="Diamond"){
        const bi=brkHit.idx;
        const uAt=U.a+U.b*bi, lAt=L.a+L.b*bi;
        const entry=brkHit.dir==="up"?uAt:lAt, stop=brkHit.dir==="up"?lAt:uAt;
        proj=mkProj(brkHit.dir, entry, stop, Math.abs(g0), bi, true);
      }
      badges.push({name,tag,status,vol,brk:brkHit?brkHit.idx:-1,proj});
    }
  }
  return {overlays,badges};
}

export { detectPatterns };
