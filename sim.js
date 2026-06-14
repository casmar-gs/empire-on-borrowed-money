/* Balance sim for Empire on Borrowed Money.
 * Runs 7 bot strategies x many seeds. Gates:
 *  (1) every game completes, no NaN / infinite loop
 *  (2) no single pure strategy beats Vane in a runaway way (none ~solved)
 *  (3) "smart" balanced play wins clearly more than pure strategies, but not 100%
 *  (4) outcomes spread -> decisions matter
 */
var EOB = require('./game.js');
var CFG = EOB.CFG;

// ---- shared bot helpers ----
function affordableTypes(s, allowBorrow) {
  var budget = s.cash + (allowBorrow ? EOB.borrowCapacity(s) : 0);
  var out = [];
  for (var i = 0; i < EOB.TYPES.length; i++) {
    var t = EOB.TYPES[i];
    if (EOB.costToBuy(s, t.key, null) <= budget) out.push(t.key);
  }
  return out;
}
function evalPlacement(s, lotId, type) {
  var before = EOB.weeklyIncome(s, false);
  s.lots[lotId].biz = { type: type, owner: 'you', tier: 1, lease: CFG.leaseLen, ramp: 0 };
  var after = EOB.weeklyIncome(s, false);
  s.lots[lotId].biz = null;
  return after - before;
}
function bestPlacement(s, types) {
  var empties = EOB.emptyLots(s), best = null;
  for (var i = 0; i < empties.length; i++) {
    for (var j = 0; j < types.length; j++) {
      var lot = empties[i], ty = types[j];
      var gain = evalPlacement(s, lot, ty);
      var cost = EOB.costToBuy(s, ty, lot);
      var roi = gain / Math.max(1, cost);
      if (!best || roi > best.roi) best = { lot: lot, type: ty, roi: roi, cost: cost, gain: gain };
    }
  }
  return best;
}
function renewExpiring(s, thresh) {
  var owned = EOB.ownedLots(s);
  for (var i = 0; i < owned.length; i++) {
    var b = s.lots[owned[i]].biz;
    if (b.lease <= thresh) EOB.renew(s, owned[i]);
  }
}
function buyDistressed(s, allowBorrow) {
  var any = false;
  for (var i = 0; i < s.lots.length; i++) {
    if (s.lots[i].distressed && !s.lots[i].biz) {
      var types = affordableTypes(s, allowBorrow);
      if (!types.length) break;
      var best = bestPlacement(s, []); // unused
      // pick best type for this distressed lot
      var pickT = null, pickG = -1;
      for (var j = 0; j < types.length; j++) { var g = evalPlacement(s, i, types[j]); if (g > pickG) { pickG = g; pickT = types[j]; } }
      if (pickT) {
        if (allowBorrow && s.cash < EOB.costToBuy(s, pickT, i)) EOB.borrow(s, EOB.costToBuy(s, pickT, i) - s.cash);
        if (EOB.buy(s, i, pickT)) any = true;
      }
    }
  }
  return any;
}

// ---- strategies ----
var STRAT = {
  naive: function (s) {                                           // ignores synergy / saturation / cycle
    renewExpiring(s, 2);
    var guard = 0;
    while (guard++ < 30) {
      var empties = EOB.emptyLots(s); if (!empties.length) break;
      var types = affordableTypes(s, true); if (!types.length) break;
      var ty = types[0], lot = empties[0], cost = EOB.costToBuy(s, ty, lot); // cheapest type, first lot
      if (s.cash < cost) EOB.borrow(s, cost - s.cash);
      if (!EOB.buy(s, lot, ty)) break;
    }
  },
  turtle: function (s) {
    renewExpiring(s, 2);
    var guard = 0;
    while (guard++ < 30) {
      var best = bestPlacement(s, affordableTypes(s, false));   // cash only
      if (!best || best.gain <= 0) break;
      if (!EOB.buy(s, best.lot, best.type)) break;
    }
  },
  blitz: function (s) {                                           // RECKLESS: always maxed, ignores the cycle
    renewExpiring(s, 2);
    EOB.borrow(s, Math.round(EOB.borrowCapacity(s) * 0.9));       // lever to the hilt every week
    var guard = 0;
    while (guard++ < 30) {
      var best = bestPlacement(s, affordableTypes(s, true));
      if (!best || best.gain <= 0) break;
      if (s.cash < best.cost) EOB.borrow(s, best.cost - s.cash);
      if (!EOB.buy(s, best.lot, best.type)) break;
    }
  },
  monoculture: function (s) {                                     // cafes only, cluster them
    renewExpiring(s, 2);
    var guard = 0;
    while (guard++ < 30) {
      var types = affordableTypes(s, true);
      if (types.indexOf('cafe') < 0) break;
      var best = bestPlacement(s, ['cafe']);
      if (!best) break;
      if (s.cash < best.cost) EOB.borrow(s, best.cost - s.cash);
      if (!EOB.buy(s, best.lot, 'cafe')) break;
    }
  },
  diversify: function (s) {                                       // many types, no leverage discipline
    renewExpiring(s, 2);
    var guard = 0;
    while (guard++ < 30) {
      var best = bestPlacement(s, affordableTypes(s, true));
      if (!best || best.gain <= 0) break;
      if (s.cash < best.cost) EOB.borrow(s, best.cost - s.cash);
      if (!EOB.buy(s, best.lot, best.type)) break;
    }
  },
  upgrader: function (s) {                                        // few lots, pump tiers
    renewExpiring(s, 2);
    var owned = EOB.ownedLots(s), did = true, guard = 0;
    while (did && guard++ < 30) {
      did = false;
      for (var i = 0; i < owned.length; i++) { if (EOB.upgrade(s, owned[i])) { did = true; } }
    }
    if (EOB.ownedLots(s).length < 3) {
      var best = bestPlacement(s, affordableTypes(s, false));
      if (best) EOB.buy(s, best.lot, best.type);
    }
  },
  vulture: function (s) {                                         // hoard cash, pounce in crunch
    renewExpiring(s, 2);
    if (s.crunch > 0) { buyDistressed(s, true); }
    // small steady cash buys when credit not frothy
    if (s.froth < 55) {
      var best = bestPlacement(s, affordableTypes(s, false));
      if (best && best.gain > 0) EOB.buy(s, best.lot, best.type);
    }
  },
  casual: function (s) {                                          // a thoughtful first-time HUMAN, not optimal
    renewExpiring(s, 2);                                          // renews only when reminded
    var buys = 0;
    while (buys < 3) {                                            // humans don't buy 8 lots a week
      var e = EOB.emptyLots(s), picks = [];
      for (var i = 0; i < e.length; i++) for (var t = 0; t < EOB.TYPES.length; t++) {
        var lot = e[i], ty = EOB.TYPES[t].key, gain = evalPlacement(s, lot, ty), cost = EOB.costToBuy(s, ty, lot);
        if (gain > 0) picks.push({ lot: lot, type: ty, cost: cost, roi: gain / Math.max(1, cost) });
      }
      if (!picks.length) break;
      picks.sort(function (a, b) { return b.roi - a.roi; });
      var pick = picks[Math.min(picks.length - 1, (s._rng() * 3) | 0)]; // picks among top few, not the best
      var budget = s.cash + Math.round(EOB.borrowCapacity(s) * 0.4);    // cautious with debt
      if (budget < pick.cost) break;
      if (s.cash < pick.cost) EOB.borrow(s, pick.cost - s.cash);
      if (!EOB.buy(s, pick.lot, pick.type)) break;
      buys++;
    }
  },
  smart: function (s) {                                           // leverage to claim territory, stop when demand thins
    renewExpiring(s, 3);
    if (s.crunch > 0) { buyDistressed(s, false); return; }        // crunch: hunt dips with cash on hand
    var calm = s.froth < 68;                                      // borrow only while credit is calm
    var guard = 0;
    while (guard++ < 30) {
      var best = bestPlacement(s, affordableTypes(s, calm));
      if (!best || best.roi < 0.025) break;                       // stop when the next lot's return goes thin (saturated)
      if (s.cash < best.cost) {
        if (!calm) break;                                         // no fresh debt when a crunch is near
        if (s.debt + (best.cost - s.cash) > 0.80 * (s.debt + EOB.borrowCapacity(s))) break; // keep a margin buffer
        EOB.borrow(s, best.cost - s.cash);
      }
      if (!EOB.buy(s, best.lot, best.type)) break;
    }
  }
};

// ---- runner ----
function runGame(seed, strat) {
  var s = EOB.newGame(seed);
  var guard = 0, nanHit = false, foreclosed = 0;
  while (!s.over && guard++ < 200) {
    strat(s);
    var rep = EOB.endWeek(s);
    if (rep && rep.marginSold) foreclosed += rep.marginSold.length;
    if (isNaN(EOB.netWorth(s)) || isNaN(s.cash) || isNaN(s.debt)) { nanHit = true; break; }
  }
  return {
    won: s.won, lost: s.lost, gotForeclosed: foreclosed > 0,
    weeks: s.week, nw: EOB.netWorth(s), vane: EOB.vaneNetWorth(s), nan: nanHit, hung: guard >= 200
  };
}

function pct(x) { return (x * 100).toFixed(0) + '%'; }
function avg(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return Math.round(t / a.length); }

var N = parseInt(process.argv[2] || '300', 10);
var names = Object.keys(STRAT);
console.log('seeds/strategy:', N);
console.log('strategy     win%   foreclosed%  avgNW    avgVane   nan/hung');
var anyBad = false, results = {};
for (var n = 0; n < names.length; n++) {
  var name = names[n], wins = 0, fc = 0, nws = [], vanes = [], bad = 0;
  for (var seed = 1; seed <= N; seed++) {
    var r = runGame(seed * 7 + n, STRAT[name]);
    if (r.won) wins++;
    if (r.gotForeclosed) fc++;
    if (r.nan || r.hung) { bad++; anyBad = true; }
    nws.push(r.nw); vanes.push(r.vane);
  }
  results[name] = { win: wins / N, fc: fc / N, nw: avg(nws), vane: avg(vanes), bad: bad };
  var pad = (name + '            ').slice(0, 12);
  console.log(pad + ' ' + pct(wins / N) + '   ' + pct(fc / N) + '      $' + avg(nws) + '   $' + avg(vanes) + '    ' + bad);
}

// ---- gates: winnable for a HUMAN, leverage an edge (not mandatory), nothing solved ----
console.log('\n--- gates ---');
function gate(ok, msg) { console.log((ok ? 'PASS ' : 'FAIL ') + msg); return ok; }
var degenerate = ['naive', 'monoculture', 'upgrader'];           // ignore the systems -> must lose
var worstDegen = 0, wdName = '';
for (var i = 0; i < degenerate.length; i++) { if (results[degenerate[i]].win > worstDegen) { worstDegen = results[degenerate[i]].win; wdName = degenerate[i]; } }
var g1 = gate(!anyBad, 'no NaN / infinite loops');
var g2 = gate(worstDegen <= 0.35, 'naive/degenerate play loses (worst = ' + wdName + ' ' + pct(worstDegen) + ', want <=35%)');
var g3 = gate(results.casual.win >= 0.60 && results.casual.win <= 0.92, 'a thoughtful human (casual) wins comfortably but not always (' + pct(results.casual.win) + ', want 60-92%)');
var g4 = gate(results.turtle.win >= 0.25 && results.turtle.win <= 0.65, 'cautious no-leverage play is viable (turtle ' + pct(results.turtle.win) + ', want 25-65%)');
var g5 = gate((results.casual.win - results.turtle.win) >= 0.15, 'leverage is a real edge (leveraged play beats no-leverage turtle by ' + pct(results.casual.win - results.turtle.win) + ', want >=15pts)');
var g6 = gate(results.blitz.win <= 0.25, 'reckless over-leverage loses the race (blitz ' + pct(results.blitz.win) + ' win, ' + pct(results.blitz.fc) + ' foreclosed)');
var g7 = gate(results.diversify.win <= 0.75, 'greedy over-expansion is punished by shared demand (diversify ' + pct(results.diversify.win) + ')');
console.log('\nALL GATES: ' + (g1 && g2 && g3 && g4 && g5 && g6 && g7 ? 'PASS' : 'FAIL'));
