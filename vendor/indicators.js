// Pure indicator math. No DOM, no globals, no app state — every function
// here takes candles in and returns arrays/objects out.

// ---------------- indicators ----------------
function emaArr(vals, len){
  const out=new Array(vals.length).fill(null), k=2/(len+1);
  let prev=null;
  for(let i=0;i<vals.length;i++){
    const v=vals[i];
    if(v==null){continue}
    prev = prev==null ? v : v*k + prev*(1-k);
    out[i]=prev;
  }
  return out;
}

function sma(cs,len){
  const out=new Array(cs.length).fill(null); let s=0;
  for(let i=0;i<cs.length;i++){s+=cs[i].c; if(i>=len)s-=cs[i-len].c; if(i>=len-1)out[i]=s/len}
  return out;
}

function rsi(cs,len=14){
  const n=cs.length, out=new Array(n).fill(null);
  if(n<len+1) return out;
  let gain=0, loss=0;
  for(let i=1;i<=len;i++){
    const d=cs[i].c-cs[i-1].c;
    if(d>=0) gain+=d; else loss-=d;
  }
  gain/=len; loss/=len;
  out[len] = loss===0 ? 100 : 100 - 100/(1+gain/loss);
  for(let i=len+1;i<n;i++){
    const d=cs[i].c-cs[i-1].c;
    const g=d>=0?d:0, l=d<0?-d:0;
    gain=(gain*(len-1)+g)/len; loss=(loss*(len-1)+l)/len;
    out[i]= loss===0 ? 100 : 100 - 100/(1+gain/loss);
  }
  return out;
}

function macd(cs,fast=12, slow=26, sig=9){
  const closes=cs.map(c=>c.c);
  const ef=emaArr(closes,fast), es=emaArr(closes,slow);
  const line=closes.map((_,i)=> (ef[i]==null||es[i]==null)?null:ef[i]-es[i]);
  const signal=emaArr(line.map(v=>v==null?null:v), sig);
  const hist=line.map((v,i)=> (v==null||signal[i]==null)?null:v-signal[i]);
  return {line, signal, hist};
}

function bollinger(cs,len=20, mult=2){
  const n=cs.length, mid=sma(cs,len), up=new Array(n).fill(null), lo=new Array(n).fill(null);
  for(let i=len-1;i<n;i++){
    let s=0; for(let j=i-len+1;j<=i;j++) s+=cs[j].c;
    const m=s/len;
    let v=0; for(let j=i-len+1;j<=i;j++){const d=cs[j].c-m; v+=d*d}
    const sd=Math.sqrt(v/len);
    up[i]=m+mult*sd; lo[i]=m-mult*sd;
  }
  return {mid, up, lo};
}

function vwap(cs){
  // Cumulative volume-weighted average price from the start of the loaded
  // series. When there's no real volume (some crypto/fallback sources),
  // falls back to an unweighted running average of typical price so the
  // line still renders something meaningful instead of just flatlining.
  const n=cs.length, out=new Array(n).fill(null);
  let cumPV=0, cumV=0, cumTP=0;
  for(let i=0;i<n;i++){
    const k=cs[i], tp=(k.h+k.l+k.c)/3;
    cumTP+=tp;
    if(k.v>0){ cumPV+=tp*k.v; cumV+=k.v; out[i]=cumPV/cumV; }
    else out[i]=cumTP/(i+1);
  }
  return out;
}

function atr(cs,len=14){
  const n=cs.length, out=new Array(n).fill(null), tr=new Array(n).fill(null);
  for(let i=0;i<n;i++){
    const k=cs[i];
    tr[i]= i===0 ? k.h-k.l : Math.max(k.h-k.l, Math.abs(k.h-cs[i-1].c), Math.abs(k.l-cs[i-1].c));
  }
  if(n<len) return out;
  let s=0; for(let i=0;i<len;i++) s+=tr[i];
  out[len-1]=s/len;
  for(let i=len;i<n;i++) out[i]=(out[i-1]*(len-1)+tr[i])/len; // Wilder smoothing
  return out;
}

// Classifies current volatility against THIS asset's own recent history,
// rather than a fixed threshold — a "high" ATR reading means nothing
// without knowing what's normal for that specific instrument. Uses
// whatever candles are already loaded, so this is free — no extra fetch.
function computeVolRegime(candles, len=14){
  const a = atr(candles, len);
  const valid = a.filter(v=>v!=null);
  if(valid.length < 30) return null; // too little history for a meaningful percentile
  const cur = valid[valid.length-1];
  const below = valid.filter(v=>v<cur).length;
  const pctile = below/valid.length*100;
  const label = pctile>=75 ? "High" : pctile>=25 ? "Normal" : "Low";
  return {cur, pctile, label, n: valid.length};
}

// Supertrend: an ATR-based trailing stop that flips between trend directions.
//
// Bands are placed at (high+low)/2 ± multiplier × ATR, then made "sticky":
// the upper band can only ratchet DOWN while price stays below it, and the
// lower band only ratchets UP while price stays above. That ratcheting is
// what makes it a trailing stop rather than a symmetric envelope — without
// it the line would whipsaw on every bar.
//
// The trend flips only when a CLOSE crosses the active band, not a wick, so
// intrabar spikes don't trigger it. Direction 1 = uptrend (line below price,
// acting as support), -1 = downtrend (line above price, acting as
// resistance).
function supertrend(cs, period=10, mult=3){
  const n = cs.length;
  const out = new Array(n).fill(null);
  if(n < period+1) return out;
  const a = atr(cs, period);
  let upper=null, lower=null, dir=1;
  for(let i=0;i<n;i++){
    if(a[i]==null) continue;
    const mid = (cs[i].h + cs[i].l)/2;
    const basicUp = mid + mult*a[i];
    const basicLo = mid - mult*a[i];
    const prevClose = i>0 ? cs[i-1].c : cs[i].c;
    // ratchet: tighten toward price, never loosen away from it
    upper = (upper==null || basicUp < upper || prevClose > upper) ? basicUp : upper;
    lower = (lower==null || basicLo > lower || prevClose < lower) ? basicLo : lower;
    // flip on a close beyond the active band
    if(dir===1 && cs[i].c < lower) dir = -1;
    else if(dir===-1 && cs[i].c > upper) dir = 1;
    out[i] = {v: dir===1 ? lower : upper, dir};
  }
  return out;
}


// Stochastic oscillator.
//
// Answers "where did this bar close inside the recent high-low range?" —
// 0 means it closed at the very bottom of the last kPeriod bars, 100 at the
// very top. Unlike RSI, which averages the SIZE of gains and losses, this
// only cares about POSITION within the range, which is why the two disagree
// in a strong trend: price can pin near the top of its range (stochastic ~100)
// while momentum cools (RSI falling).
//
// Three parameters, and the middle one is the one people get wrong:
//   kPeriod  lookback for the high-low range
//   smooth   SMA applied to raw %K. smooth=1 is "fast" stochastic, which is
//            noisy enough to be nearly unusable; smooth=3 is "slow", and is
//            what almost everyone actually means by "stochastic 14,3,3".
//   dPeriod  SMA of %K, drawn as the signal line
//
// Returns null at every index without enough history, matching the other
// indicators here so the renderers can skip on null rather than guess.
function stochastic(cs, kPeriod = 14, smooth = 3, dPeriod = 3) {
  const n = cs.length;
  const rawK = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (cs[j].h > hh) hh = cs[j].h;
      if (cs[j].l < ll) ll = cs[j].l;
    }
    const span = hh - ll;
    // A flat range would divide by zero. It means every bar in the window had
    // the same high and low, so the close is trivially at "the top" and the
    // bottom simultaneously; 50 is the only non-arbitrary answer.
    rawK[i] = span === 0 ? 50 : ((cs[i].c - ll) / span) * 100;
  }
  const smaOf = (arr, len) => {
    const out = new Array(n).fill(null);
    if (len <= 1) return arr.slice();
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) { sum = 0; count = 0; continue; }
      sum += arr[i]; count++;
      if (count > len) { sum -= arr[i - len]; count = len; }
      if (count === len) out[i] = sum / len;
    }
    return out;
  };
  const k = smaOf(rawK, smooth);
  const d = smaOf(k, dPeriod);
  return { k, d };
}

export { emaArr, sma, rsi, macd, bollinger, vwap, atr, computeVolRegime, supertrend, stochastic };
