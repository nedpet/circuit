/* ═══ ENGINE: bit-level math + gate behavior definitions ═══════════════════
   Pure functions and static data with no dependency on wire geometry, wire
   routing, or the stateful circuit itself — split out of engine.js into its
   own module so the layers built on top of it (engine-geometry.js,
   engine-routing.js, engine-circuit.js) have a single, dependency-free base.
   See engine.js for how all four are composed back into one flat `engine`
   module. */
defineModule('engine-core', [], () => {
  'use strict';

  // These functions ensure v is read correctly as a width-bit unsigned input
  function bitMask(width) {
    return width>=32 ? 0xFFFFFFFF : (Math.pow(2,width)-1);
  }
  function maskVal(v, width) {
    return (v & bitMask(width)) >>> 0;
  }

  // Component whose per-instance `bitWidth` is user-configurable and consistent component-wide
  const BIT_WIDTH_KINDS = new Set(['INPUT','OUTPUT','CONST','AND','OR','NOT','NAND','NOR','XOR','XNOR','REG','MUX','SHFT']);

  // REG's EN/CLK/RESET must stay 1-bit regardless of the component's bitWidth
  const FIXED_WIDTH_PINS = { REG: { in: new Set([1,2,3]) } };

  // MUX's select pin width is derived from muxInputs, the number of inputs in the mux
  function muxSelectWidth(muxInputs) {
    return (muxInputs||2) <= 2 ? 1 : 2;
  }

  // SHFT's shift-amount input only needs enough bits to address every position in the value being shifted
  // bitWidth 1 has no meaningful shift amount, so it's floored at 1 bit
  function shiftAmountWidth(bitWidth) {
    return Math.max(1, Math.ceil(Math.log2(Math.max(1,bitWidth||1))));
  }

  // Sign-extends (or truncates) v from fromWidth bits to toWidth bits, v being read as a 2's complement number
  function signExtend(v, fromWidth, toWidth) {
    const masked = maskVal(v, fromWidth);
    const half = Math.pow(2, fromWidth-1);
    const signed = masked >= half ? masked - Math.pow(2, fromWidth) : masked;
    const reencoded = signed < 0 ? signed + Math.pow(2, toWidth) : signed;
    return maskVal(reencoded, toWidth);
  }

  // Returns the number of bits of the pin in direction dir at index idx on component comp
  // Kinds outside BIT_WIDTH_KINDS only ever handle 1-bit values on all their pins
  function pinBitWidthAt(comp, dir, idx) {
    if (!comp) return 1;
    if (comp.kind === 'MUX') {
      const n = comp.muxInputs || 2;
      if (dir === 'in' && idx === n) return muxSelectWidth(n);
      return comp.bitWidth || 1;
    }
    if (comp.kind === 'SHFT') {
      if (dir === 'in' && idx === 1) return shiftAmountWidth(comp.bitWidth);
      return comp.bitWidth || 1;
    }
    if (comp.kind === 'EXTND') {
      return dir === 'in' ? (comp.bitWidthIn||1) : (comp.bitWidthOut||1);
    }
    if (comp.kind === 'SPLIT') {
      const wide = comp.bits||2, narrow = 1;
      const merge = comp.splitType === 'merge';
      return dir === 'in' ? (merge ? narrow : wide) : (merge ? wide : narrow);
    }
    const fixed = FIXED_WIDTH_PINS[comp.kind];
    if (fixed && fixed[dir] && fixed[dir].has(idx)) return 1;
    // A custom gate's ports each carry their own fixed width (set by
    // registerCustomGate from the bitWidth of the INPUT/OUTPUT it was built
    // from), unrelated to one another and to any single comp.bitWidth — so
    // it's recorded per-pin on the GATE_DEF itself (inWidths/outWidths)
    // rather than fitting the single-bitWidth-per-component shape every
    // other kind above uses.
    const def = GATE_DEFS[comp.kind];
    const widths = def && (dir === 'in' ? def.inWidths : def.outWidths);
    if (widths) return widths[idx] || 1;
    return BIT_WIDTH_KINDS.has(comp.kind) ? (comp.bitWidth||1) : 1;
  }

  // Returns the number of inputs for component c
  // MUX and SPLIT are the only kinds whose input count varies per instance
  function compInputCount(c) {
    if (c.kind === 'MUX') return (c.muxInputs||2) + 1;
    if (c.kind === 'SPLIT') return c.splitType==='merge' ? (c.bits||2) : GATE_DEFS.SPLIT.inputs;
    return GATE_DEFS[c.kind].inputs;
  }

  const GATE_DEFS = {
    INPUT:  { kind:'INPUT',   label:'IN',    inputs:0, outputs:1, family:'io',
              compute:(i,s,w) => [maskVal(s.value||0, w||1)] },
    OUTPUT: { kind:'OUTPUT',  label:'OUT',   inputs:1, outputs:0, family:'io',
              compute:()=>[] },
    CLOCK:  { kind:'CLOCK',   label:'CLK',   inputs:0, outputs:1, family:'io',
              compute:(i,s) => [s.value?1:0] },
    CONST:  { kind:'CONST',   label:'CONST', inputs:0, outputs:1, family:'io',
              compute:(i,s,w) => [maskVal(s.value||0, w||1)] },
    SEVEN:  { kind:'SEVEN',   label:'7SEG',  inputs:7, outputs:0, family:'io',
              compute:()=>[] },
    AND:    { kind:'AND',     label:'AND',   inputs:2, outputs:1, family:'and',
              compute:([a,b],s,w) => [maskVal(a&b,w)] },
    OR:     { kind:'OR',      label:'OR',    inputs:2, outputs:1, family:'or',
              compute:([a,b],s,w) => [maskVal(a|b,w)] },
    NOT:    { kind:'NOT',     label:'NOT',   inputs:1, outputs:1, family:'not',
              compute:([a],s,w)   => [maskVal(~a,w)] },
    NAND:   { kind:'NAND',    label:'NAND',  inputs:2, outputs:1, family:'and',
              compute:([a,b],s,w) => [maskVal(~(a&b),w)] },
    NOR:    { kind:'NOR',     label:'NOR',   inputs:2, outputs:1, family:'or',
              compute:([a,b],s,w) => [maskVal(~(a|b),w)] },
    XOR:    { kind:'XOR',     label:'XOR',   inputs:2, outputs:1, family:'xor',
              compute:([a,b],s,w) => [maskVal(a^b,w)] },
    XNOR:   { kind:'XNOR',    label:'XNOR',  inputs:2, outputs:1, family:'xor',
              compute:([a,b],s,w) => [maskVal(~(a^b),w)] },
    // arity is per-instance, so compute needs the whole comp to know where the select pin sits
    MUX:    { kind:'MUX',  label:'MUX',   inputs:3, outputs:1, family:'mux',
              compute:(inputVals,s,w,comp)=>{
                const n=(comp&&comp.muxInputs)||2;
                const sel=(inputVals[n]||0) & (n<=2?1:3);
                const val=(n===2) ? (sel?inputVals[1]:inputVals[0]) : ((sel<n)?(inputVals[sel]||0):0); // sel=3 when there are only 3 inputs sets it to 0
                return [maskVal(val||0, w||1)];
              } },
    DFF:    { kind:'DFF',  label:'D-FF',  inputs:2, outputs:1, family:'seq',
              compute:([d,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r)s.q=d?1:0; return[s.q||0]; } },
    TFF:    { kind:'TFF',  label:'T-FF',  inputs:2, outputs:1, family:'seq',
              compute:([t,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r&&t)s.q=s.q?0:1; return[s.q||0]; } },
    JKFF:   { kind:'JKFF', label:'JK-FF', inputs:3, outputs:1, family:'seq',
              compute:([j,k,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r){if(j&&k)s.q=s.q?0:1; else if(j)s.q=1; else if(k)s.q=0;} return[s.q||0]; } },
    SRFF:   { kind:'SRFF', label:'SR-FF', inputs:2, outputs:1, family:'seq',
              compute:([s2,r],s)=>{ if(s2&&!r)s.q=1; else if(r&&!s2)s.q=0; return[s.q||0]; } },
    REG:    { kind:'REG',  label:'REGISTER',   inputs:4, outputs:1, family:'misc',
              compute:([d,en,clk,res],s,w)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(res)s.q=0; else if(r&&en)s.q=maskVal(d||0,w||1); return[s.q||0]; } },
    SHFT:   { kind:'SHFT', label:'SHIFTER',  inputs:2, outputs:1, family:'misc',
              compute:([a,b],s,w,comp) => {
                const width = w||1;
                const amt = (b||0) & bitMask(shiftAmountWidth(width));
                const av = maskVal(a||0, width);
                const mode = (comp&&comp.shiftMode) || 'left';
                if (mode==='right') return [maskVal(av >>> amt, width)]; // logical, zero-fills from the high end
                if (mode==='arith') {                                    // right shift that repeats the sign bit
                  const half = Math.pow(2,width-1);
                  const signed = av>=half ? av-Math.pow(2,width) : av;
                  return [maskVal(Math.floor(signed/Math.pow(2,amt)), width)];
                }
                return [maskVal(av*(2**amt), width)];                    // logical, zero-fills from the low end
              } } ,
    EXTND:  { kind:'EXTND', label:'EXTENDER', inputs:1, outputs:1, family:'misc',
              compute:([a],s,w,comp) => {
                const fromW = (comp&&comp.bitWidthIn)||1;
                const toW = (comp&&comp.bitWidthOut)||1;
                return [signExtend(a||0, fromW, toW)];
              } } ,
    // 'split': one multibit input split into many 1-bit outputs
    // output i reads bit i of the input (0 = topmost pin = LSB)
    // 'merge': many 1-bit inputs merge into one multibit output
    SPLIT:  { kind:'SPLIT', label:'SPLITTER', inputs:1, outputs:8, family:'misc',
              compute:(inputVals,s,w,comp) => {
                const n = (comp&&comp.bits)||2;
                if (comp && comp.splitType === 'merge') {
                  let v = 0;
                  for (let i=0;i<n;i++) v |= (inputVals[i]?1:0) << i;
                  return [v>>>0];
                }
                const v = inputVals[0]||0;
                return Array.from({length:n}, (_,i)=>(v>>>i)&1);
              } } ,
  };

  return {
    bitMask, maskVal, BIT_WIDTH_KINDS, muxSelectWidth, shiftAmountWidth,
    signExtend, pinBitWidthAt, compInputCount, GATE_DEFS,
  };
});
