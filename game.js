/* Empire on Borrowed Money — core engine (ES5, UMD).
 * Pure logic, no DOM. Runs in browser (window.EOB) and Node (module.exports).
 * Design pillars:
 *  - compounding capital (exp cost growth)
 *  - spatial tension: adjacency synergy (cluster) vs demand saturation (spread)
 *  - credit cycle: leverage tempts, crunch punishes the overextended & rewards dry powder
 *  - expiring leases keep the map in flux
 *  - race Vane's net worth to a deadline (player vs system)
 * All tunable numbers live in CFG so the balance sim can sweep them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EOB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CFG = {
    W: 6, H: 4,                 // grid -> 24 lots
    deadline: 24,               // weeks
    startCash: 1000,
    districtDemand: 620,        // $/wk a district absorbs (shared by EVERYONE in it) before saturation
    overflowKeep: 0.30,         // fraction kept on income above demand
    synergyPerNbr: 0.25,        // +income per adjacent DIFFERENT-type lot you own
    synergyMaxNbr: 2,           // cap (Frostpunk-style)
    buyCostGrowth: 1.35,        // each owned-of-type multiplies next buy
    upgT2Mult: 0.70,            // upgrade cost = baseCost * this (tier1->2)
    upgT3Mult: 1.40,            // tier2->3
    tierIncome: [0, 1.0, 1.8, 3.0],
    leaseLen: 14,
    renewFrac: 0.35,            // renewal = baseCost * this
    rampWeeks: 1,               // weeks a new/upgraded biz earns 0
    ltvNormal: 0.70, ltvCrunch: 0.40,   // how much you may BORROW against your worth
    marginLtvNormal: 0.92, marginLtvCrunch: 0.55, // the line that triggers FORCED sales (buffer above borrow limit)
    intNormal: 0.03, intCrunch: 0.08,   // weekly interest
    crunchAssetHaircut: 0.42,           // asset value drop during crunch
    distressDiscount: 0.50,             // distressed lot price multiplier
    forcedSaleFrac: 0.40,               // you recover this fraction on a foreclosure
    resaleFrac: 0.55,                   // resale/networth value of a biz vs its rebuild cost
    foreclosureCapFrac: 0.40,           // a crunch forecloses at most this share of your holdings — never a wipeout
    crunchLen: 3,
    // Vane: a scripted rival who actively contests the board
    vaneCashStart: 1200,
    vaneIncomeFactor: 0.96,    // fraction of his lots' income he banks each week
    // NOTE: Vane fully reinvests, so his strength compounds and is sensitive to these
    // knobs. Tuned so imperfect human play can win; leverage is a strong edge, not mandatory.
    vaneMaxLots: 12,           // how much of the board he claims
    vaneDumpInCrunch: 2        // lots he fire-sells (distressed) when a crunch hits
  };

  var TYPES = [
    { key: 'cafe',    name: 'Cafe',       cost: 300,  income: 55 },
    { key: 'grocer',  name: 'Grocer',     cost: 550,  income: 95 },
    { key: 'apoth',   name: 'Apothecary', cost: 750,  income: 135 },
    { key: 'theater', name: 'Theater',    cost: 1300, income: 230 }
  ];
  function typeOf(k) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === k) return TYPES[i]; return null; }

  // ---- district character & shop-type affinity ----
  // Each district has a dominant clientele; a shop earns more where it FITS (and less where it
  // doesn't). A small, capped table — the spatial decision is "put the right shop in the right
  // neighbourhood", not just "spread out". Affinity multiplies a shop's raw draw.
  var DISTRICT_CHAR = ['working', 'commercial', 'transient', 'wealthy']; // by district id 0..3
  var CHAR_LABEL = { working: 'Working-class', commercial: 'Commercial', transient: 'Dockside', wealthy: 'Old money' };
  var AFFINITY = {
    //          working  commercial  transient  wealthy
    cafe:    { working: 1.30, commercial: 1.00, transient: 1.25, wealthy: 0.72 },
    grocer:  { working: 1.22, commercial: 1.10, transient: 0.95, wealthy: 0.88 },
    apoth:   { working: 0.92, commercial: 1.22, transient: 0.82, wealthy: 1.26 },
    theater: { working: 0.68, commercial: 1.16, transient: 0.90, wealthy: 1.42 }
  };
  function affinity(type, district) { var a = AFFINITY[type]; return a ? a[DISTRICT_CHAR[district]] : 1; }

  // seeded LCG so credit cycle & sim are reproducible
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function lotIdx(x, y) { return y * CFG.W + x; }
  function districtOf(x, y) { var dx = x < 3 ? 0 : 1, dy = y < 2 ? 0 : 1; return dy * 2 + dx; }
  function neighborsOf(id) {
    var x = id % CFG.W, y = (id / CFG.W) | 0, a = [];
    if (x > 0) a.push(id - 1);
    if (x < CFG.W - 1) a.push(id + 1);
    if (y > 0) a.push(id - CFG.W);
    if (y < CFG.H - 1) a.push(id + CFG.W);
    return a;
  }

  function newGame(seed) {
    var rng = makeRng(seed || 12345);
    var lots = [];
    for (var y = 0; y < CFG.H; y++) for (var x = 0; x < CFG.W; x++) {
      lots.push({ id: lotIdx(x, y), x: x, y: y, district: districtOf(x, y), biz: null, distressed: false });
    }
    var s = {
      seed: seed || 12345, _rng: rng,
      week: 1, cash: CFG.startCash, debt: 0,
      froth: 45,            // credit-market heat 0..100
      crunch: 0,            // weeks of crunch remaining (0 = normal)
      nextCrunch: 6 + ((rng() * 4) | 0),  // scheduled market cycle (week 6-9)
      lots: lots,
      vaneCash: CFG.vaneCashStart,
      ownedTypeCount: { cafe: 0, grocer: 0, apoth: 0, theater: 0 },
      over: false, won: false, lost: false, reason: '',
      log: [], lastReport: null
    };
    // starting position: you own a cafe; Vane holds 3 lots (greyed pressure + saturation)
    placeBiz(s, lotIdx(1, 1), 'cafe', 'you', true);
    placeBiz(s, lotIdx(4, 0), 'grocer', 'vane', false);
    placeBiz(s, lotIdx(5, 3), 'cafe', 'vane', false);
    placeBiz(s, lotIdx(0, 3), 'apoth', 'vane', false);
    s.cash = CFG.startCash; // placeBiz(you) above shouldn't charge the freebie
    s.ownedTypeCount.cafe = 1;
    return s;
  }

  function placeBiz(s, id, type, owner, freeRamp) {
    s.lots[id].biz = {
      type: type, owner: owner, tier: 1,
      lease: CFG.leaseLen, ramp: freeRamp ? 0 : CFG.rampWeeks
    };
    s.lots[id].distressed = false;
  }

  // ---- pricing / valuation ----
  function costToBuy(s, type, lotId) {
    var t = typeOf(type);
    var n = s.ownedTypeCount[type] || 0;
    var c = t.cost * Math.pow(CFG.buyCostGrowth, n);
    if (s.crunch > 0) c *= (1 - CFG.crunchAssetHaircut);            // prices crash in a crunch
    if (lotId != null && s.lots[lotId] && s.lots[lotId].distressed) c *= CFG.distressDiscount;
    return Math.round(c);
  }
  function upgradeCost(s, lotId) {
    var b = s.lots[lotId].biz; if (!b || b.owner !== 'you' || b.tier >= 3) return null;
    var base = typeOf(b.type).cost;
    return Math.round(base * (b.tier === 1 ? CFG.upgT2Mult : CFG.upgT3Mult));
  }
  function renewCost(s, lotId) {
    var b = s.lots[lotId].biz; if (!b || b.owner !== 'you') return null;
    return Math.round(typeOf(b.type).cost * CFG.renewFrac);
  }
  function resaleValue(s, lotId) {
    var b = s.lots[lotId].biz; if (!b) return 0;
    var v = typeOf(b.type).cost * CFG.resaleFrac * CFG.tierIncome[b.tier];
    if (s.crunch > 0) v *= (1 - CFG.crunchAssetHaircut);
    return Math.round(v);
  }
  function assetValue(s) {
    var v = 0;
    for (var i = 0; i < s.lots.length; i++) if (s.lots[i].biz && s.lots[i].biz.owner === 'you') v += resaleValue(s, i);
    return v;
  }
  function netWorth(s) { return Math.round(s.cash + assetValue(s) - s.debt); }
  function ltv(s) { return s.crunch > 0 ? CFG.ltvCrunch : CFG.ltvNormal; }
  function marginLtv(s) { return s.crunch > 0 ? CFG.marginLtvCrunch : CFG.marginLtvNormal; }
  function borrowCapacity(s) { return Math.max(0, Math.round(ltv(s) * (s.cash + assetValue(s)) - s.debt)); }
  function interestRate(s) { return s.crunch > 0 ? CFG.intCrunch : CFG.intNormal; }

  // ---- demand: SHARED across every owner in a district (you, Vane, future rivals) ----
  // The "draw" a single occupied lot pulls from its district's customers, for its owner.
  function lotDraw(s, lotId, useRamp) {
    var b = s.lots[lotId].biz; if (!b) return 0;
    var aff = affinity(b.type, s.lots[lotId].district);   // does this shop fit this neighbourhood?
    if (b.owner === 'you') {
      if (useRamp && b.ramp > 0) return 0;            // not open yet -> draws nothing
      var base = typeOf(b.type).income * CFG.tierIncome[b.tier];
      var nbrs = neighborsOf(lotId), diff = 0;
      for (var i = 0; i < nbrs.length; i++) {
        var nb = s.lots[nbrs[i]].biz;
        if (nb && nb.owner === 'you' && nb.type !== b.type) diff++;
      }
      if (diff > CFG.synergyMaxNbr) diff = CFG.synergyMaxNbr;
      return base * (1 + diff * CFG.synergyPerNbr) * aff;
    }
    return typeOf(b.type).income * CFG.tierIncome[b.tier] * aff;  // rivals: flat draw, always open
  }
  // total demand drawn in a district by EVERYONE — generalises to any number of owners
  function districtRaw(s, district, useRamp) {
    var sum = 0;
    for (var i = 0; i < s.lots.length; i++) {
      if (s.lots[i].district === district) sum += lotDraw(s, i, useRamp);
    }
    return sum;
  }
  function saturate(raw) {
    if (raw <= CFG.districtDemand) return raw;
    return CFG.districtDemand + (raw - CFG.districtDemand) * CFG.overflowKeep;
  }
  // fraction of raw draw that converts to income — the SAME for everyone in the district
  function districtEfficiency(s, district, useRamp) {
    var raw = districtRaw(s, district, useRamp);
    if (raw <= 0) return 1;
    return saturate(raw) / raw;
  }
  // a player lot's GROSS draw (UI helpers; net = draw x shared efficiency)
  function rawBizIncome(s, lotId) {  // ramp-aware
    var b = s.lots[lotId].biz; if (!b || b.owner !== 'you') return 0;
    return lotDraw(s, lotId, true);
  }
  function projBizIncome(s, lotId) { // ignores ramp
    var b = s.lots[lotId].biz; if (!b || b.owner !== 'you') return 0;
    return lotDraw(s, lotId, false);
  }
  function weeklyIncome(s, useRamp) {
    var total = 0;
    for (var i = 0; i < s.lots.length; i++) {
      var b = s.lots[i].biz;
      if (b && b.owner === 'you') total += lotDraw(s, i, useRamp) * districtEfficiency(s, s.lots[i].district, useRamp);
    }
    return Math.round(total);
  }

  // ---- player actions (return true on success) ----
  function canBuy(s, lotId, type) {
    if (s.over) return false;
    var lot = s.lots[lotId]; if (!lot || lot.biz) return false;
    return s.cash >= costToBuy(s, type, lotId);
  }
  function buy(s, lotId, type) {
    if (!canBuy(s, lotId, type)) return false;
    s.cash -= costToBuy(s, type, lotId);
    placeBiz(s, lotId, type, 'you', false);
    s.ownedTypeCount[type] = (s.ownedTypeCount[type] || 0) + 1;
    return true;
  }
  function upgrade(s, lotId) {
    if (s.over) return false;
    var c = upgradeCost(s, lotId); if (c == null || s.cash < c) return false;
    s.cash -= c; var b = s.lots[lotId].biz; b.tier += 1; b.ramp = CFG.rampWeeks;
    return true;
  }
  function renew(s, lotId) {
    if (s.over) return false;
    var c = renewCost(s, lotId); if (c == null || s.cash < c) return false;
    s.cash -= c; s.lots[lotId].biz.lease = CFG.leaseLen;
    return true;
  }
  function sell(s, lotId) {
    if (s.over) return false;
    var b = s.lots[lotId].biz; if (!b || b.owner !== 'you') return false;
    s.cash += resaleValue(s, lotId);
    s.ownedTypeCount[b.type] = Math.max(0, (s.ownedTypeCount[b.type] || 1) - 1);
    s.lots[lotId].biz = null;
    return true;
  }
  function borrow(s, amt) {
    if (s.over) return false;
    amt = Math.min(amt, borrowCapacity(s)); if (amt <= 0) return false;
    s.debt += amt; s.cash += amt; return true;
  }
  function repay(s, amt) {
    if (s.over) return false;
    amt = Math.min(amt, s.cash, s.debt); if (amt <= 0) return false;
    s.debt -= amt; s.cash -= amt; return true;
  }

  // ---- the week tick ----
  function endWeek(s) {
    if (s.over) return s.lastReport;
    var rep = { week: s.week, income: 0, interest: 0, lapsed: [], marginSold: [], events: [] };

    // 1) income (with ramp), then decay ramps
    rep.income = weeklyIncome(s, true);
    s.cash += rep.income;
    for (var i = 0; i < s.lots.length; i++) {
      var b = s.lots[i].biz; if (b && b.owner === 'you' && b.ramp > 0) b.ramp--;
    }

    // 2) interest; shortfall capitalizes into debt
    rep.interest = Math.round(s.debt * interestRate(s));
    if (rep.interest > 0) {
      if (s.cash >= rep.interest) s.cash -= rep.interest;
      else { s.debt += (rep.interest - s.cash); s.cash = 0; }
    }

    // 3) leases tick; lapse unrenewed
    for (i = 0; i < s.lots.length; i++) {
      var lb = s.lots[i].biz;
      if (lb && lb.owner === 'you') {
        lb.lease--;
        if (lb.lease <= 0) {
          rep.lapsed.push(i);
          s.ownedTypeCount[lb.type] = Math.max(0, (s.ownedTypeCount[lb.type] || 1) - 1);
          s.lots[i].biz = null; // back to market
        }
      }
    }

    // 4) credit cycle
    updateCredit(s, rep);

    // 5) margin call
    marginCall(s, rep);

    // 6) rival contests the board
    vaneTurn(s, rep);

    // 7) advance / resolve
    s.week++;
    s.log.push(rep);
    s.lastReport = rep;
    // No mid-game game-over: a crunch sets you back, it doesn't end your run. Only the deadline decides.
    if (s.week > CFG.deadline) {
      s.over = true;
      if (netWorth(s) > vaneNetWorth(s)) { s.won = true; s.reason = 'You out-built Cornelius Vane.'; }
      else { s.lost = true; s.reason = 'Vane ended richer. The city is his.'; }
    }
    return rep;
  }
  function updateCredit(s, rep) {
    // The credit market runs on a visible rhythm: froth climbs toward a scheduled
    // crunch, and your own leverage adds heat (and risk). The schedule guarantees the
    // player lives through the cycle; froth is the early-warning gauge.
    if (s.crunch > 0) {
      s.crunch--;
      s.froth = 28 + 8 * s._rng();
      if (s.crunch === 0) { rep.events.push('recover'); clearDistress(s); }
      return;
    }
    var wto = s.nextCrunch - s.week;                         // weeks until scheduled crunch
    var base = wto <= 0 ? 96 : Math.max(40, 92 - wto * 9);   // steeper ~3-week warning ramp
    var lev = Math.min(18, (s.debt / Math.max(500, s.cash + assetValue(s))) * 30);
    var target = Math.min(100, base + lev);
    s.froth = s.froth * 0.35 + target * 0.65;                // smoothed
    if (s.week >= s.nextCrunch || s.froth >= 96) {
      s.crunch = CFG.crunchLen;
      rep.events.push('crunch');
      s.nextCrunch = s.week + 6 + ((s._rng() * 4) | 0);
      spawnDistress(s, 3);                                   // failed operators' lots go cheap — dry powder buys them
    }
  }
  function clearDistress(s) { for (var i = 0; i < s.lots.length; i++) s.lots[i].distressed = false; }
  function spawnDistress(s, n) {
    var empties = [];
    for (var j = 0; j < s.lots.length; j++) if (!s.lots[j].biz) empties.push(j);
    n = Math.min(n, empties.length);
    for (var k = 0; k < n; k++) {
      var pick = empties[(s._rng() * empties.length) | 0];
      s.lots[pick].distressed = true;
    }
  }

  // ---- the rival ----
  function vaneLots(s) { var a = []; for (var i = 0; i < s.lots.length; i++) { var b = s.lots[i].biz; if (b && b.owner === 'vane') a.push(i); } return a; }
  function vaneNetWorth(s) {
    var v = s.vaneCash, lots = vaneLots(s);
    for (var i = 0; i < lots.length; i++) v += resaleValue(s, lots[i]);
    return Math.round(v);
  }
  function vaneTurn(s, rep) {
    var lots = vaneLots(s), i;
    // income from holdings — subject to the SAME shared district demand the player faces
    var inc = 0;
    for (i = 0; i < lots.length; i++) { inc += lotDraw(s, lots[i], false) * districtEfficiency(s, s.lots[lots[i]].district, false); }
    s.vaneCash += Math.round(inc * CFG.vaneIncomeFactor);
    // Vane is all-equity: a credit crunch doesn't margin-call him. He simply holds
    // through the storm — a steady bar. The squeeze falls on whoever borrowed.
    if (s.crunch > 0) return;
    // otherwise Vane keeps buying, racing you for the board
    var cap = s.week < 6 ? 2 : (s.week < 14 ? 3 : 4), bought = 0;
    while (bought < cap && vaneLots(s).length < CFG.vaneMaxLots) {
      var empties = emptyLots(s); if (!empties.length) break;
      var pick = pickVaneLot(s, empties);
      // Vane builds the best-FITTING affordable type for that district (he knows neighbourhoods too)
      var ty = null, bestScore = -1, dc = s.lots[pick].district;
      for (var t = 0; t < TYPES.length; t++) {
        if (s.vaneCash < TYPES[t].cost) continue;
        var score = TYPES[t].income * affinity(TYPES[t].key, dc);
        if (score > bestScore) { bestScore = score; ty = TYPES[t].key; }
      }
      if (!ty) break;
      s.vaneCash -= typeOf(ty).cost;
      placeBiz(s, pick, ty, 'vane', false);
      bought++;
    }
  }
  function pickVaneLot(s, empties) {
    // Vane spreads into the least-crowded district so shared demand doesn't choke his own shops.
    var best = -1, bestRaw = Infinity;
    for (var i = 0; i < empties.length; i++) {
      var raw = districtRaw(s, s.lots[empties[i]].district, false);
      if (raw < bestRaw) { bestRaw = raw; best = empties[i]; }
    }
    return best >= 0 ? best : empties[(s._rng() * empties.length) | 0];
  }
  // When credit contracts and you're over-extended, the bank forecloses SOME of your
  // weakest properties — a real setback, but capped so it's never a wipeout / game over.
  // Any debt still left over simply persists: a hole you have to climb out of.
  function marginCall(s, rep) {
    var owned = ownedLots(s).length;
    if (owned === 0) return;
    var cap = Math.max(1, Math.ceil(owned * CFG.foreclosureCapFrac));
    var guard = 0;
    while (s.debt > marginLtv(s) * (s.cash + assetValue(s)) && guard++ < 40) {
      // pay down with spare cash first (costs you no property)
      if (s.cash > 0) {
        var pay = Math.min(s.cash, s.debt - marginLtv(s) * (s.cash + assetValue(s)));
        if (pay > 0) { s.debt -= pay; s.cash -= pay; continue; }
      }
      if (rep.marginSold.length >= cap) break;   // capped — keep the core of your empire, eat the residual debt
      // foreclose your WEAKEST property (you keep your moneymakers)
      var worst = -1, worstV = Infinity;
      for (var i = 0; i < s.lots.length; i++) {
        var b = s.lots[i].biz; if (!b || b.owner !== 'you') continue;
        var v = resaleValue(s, i); if (v < worstV) { worstV = v; worst = i; }
      }
      if (worst < 0) break;
      var got = Math.round(worstV * CFG.forcedSaleFrac);
      s.cash += got; s.debt = Math.max(0, s.debt - got);
      s.ownedTypeCount[s.lots[worst].biz.type] = Math.max(0, (s.ownedTypeCount[s.lots[worst].biz.type] || 1) - 1);
      s.lots[worst].biz = null;
      rep.marginSold.push(worst);
    }
  }

  // ---- helpers for UI / bots ----
  function ownedLots(s) { var a = []; for (var i = 0; i < s.lots.length; i++) if (s.lots[i].biz && s.lots[i].biz.owner === 'you') a.push(i); return a; }
  function emptyLots(s) { var a = []; for (var i = 0; i < s.lots.length; i++) if (!s.lots[i].biz) a.push(i); return a; }
  function creditLabel(s) { return s.crunch > 0 ? 'CRUNCH' : (s.froth >= 70 ? 'FROTHY' : (s.froth <= 35 ? 'TIGHT' : 'STEADY')); }

  return {
    CFG: CFG, TYPES: TYPES, typeOf: typeOf,
    DISTRICT_CHAR: DISTRICT_CHAR, CHAR_LABEL: CHAR_LABEL, affinity: affinity,
    newGame: newGame, neighborsOf: neighborsOf, districtOf: districtOf,
    costToBuy: costToBuy, upgradeCost: upgradeCost, renewCost: renewCost,
    resaleValue: resaleValue, assetValue: assetValue, netWorth: netWorth,
    borrowCapacity: borrowCapacity, interestRate: interestRate, ltv: ltv,
    rawBizIncome: rawBizIncome, projBizIncome: projBizIncome,
    districtRaw: districtRaw, districtEfficiency: districtEfficiency, weeklyIncome: weeklyIncome,
    canBuy: canBuy, buy: buy, upgrade: upgrade, renew: renew, sell: sell,
    borrow: borrow, repay: repay, endWeek: endWeek,
    ownedLots: ownedLots, emptyLots: emptyLots, creditLabel: creditLabel,
    vaneLots: vaneLots, vaneNetWorth: vaneNetWorth
  };
});
