// Pulls the NFL schedule + spreads from ESPN's free public scoreboard feed
// (no API key needed) and writes them into the same Firestore collections
// the site reads from. Also grades the week that just finished, using final
// scores from the same feed.
//
// Run by .github/workflows/nfl-sync.yml on a schedule, or manually with:
//   FIREBASE_SERVICE_ACCOUNT='<service account json>' node scripts/sync-nfl.js

const admin = require('firebase-admin');

// Flip to false if you'd rather review a newly-imported week in Admin
// before it goes live for your friends.
const AUTO_PUBLISH = true;

// ESPN numbers rounds the same way every season type — Wild Card is
// "week 1" just like the regular season's Week 1 is "week 1" — so the
// week id has to fold in season type, or the Super Bowl would silently
// overwrite Week 1's document.
const ROUND_LABELS = {
  1: 'Wild Card',
  2: 'Divisional Round',
  3: 'Conference Championship',
  4: 'Pro Bowl',
  5: 'Super Bowl',
};
function weekIdAndLabel(season, seasonType, weekNumber) {
  if (seasonType === 3) {
    return {
      weekId: `${season}-post-wk${weekNumber}`,
      label: ROUND_LABELS[weekNumber] || `Postseason Week ${weekNumber}`,
    };
  }
  if (seasonType === 1) {
    return { weekId: `${season}-pre-wk${weekNumber}`, label: `Preseason Week ${weekNumber}` };
  }
  return { weekId: `${season}-wk${weekNumber}`, label: `Week ${weekNumber}` };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function fetchScoreboard(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard${qs ? '?' + qs : ''}`;
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`ESPN scoreboard request failed: ${r.status}`);
    return r.json();
  });
}

// Same "who covers" logic the site itself uses.
function gradeGame(favorite, spread, homeScore, awayScore) {
  if (favorite === 'home') {
    const diff = homeScore - awayScore;
    if (diff > spread) return 'home';
    if (diff < spread) return 'away';
    return 'push';
  }
  if (favorite === 'away') {
    const diff = awayScore - homeScore;
    if (diff > spread) return 'away';
    if (diff < spread) return 'home';
    return 'push';
  }
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return 'push';
}

async function gradePreviousWeek(db) {
  const currentSnap = await db.doc('meta/current').get();
  if (!currentSnap.exists) {
    console.log('No live week set yet — nothing to grade.');
    return;
  }
  const weekId = currentSnap.data().weekId;
  const weekSnap = await db.doc('weeks/' + weekId).get();
  if (!weekSnap.exists) {
    console.log('Live week doc is missing — skipping grading.');
    return;
  }
  const week = weekSnap.data();
  if (week.espnSeason == null || week.espnWeek == null) {
    console.log('Live week has no ESPN season/week reference (added manually) — skipping auto-grading.');
    return;
  }

  const gamesSnap = await db.collection('games').where('weekId', '==', weekId).get();
  const openGames = gamesSnap.docs.filter((d) => !d.data().final && d.data().espnEventId);
  if (openGames.length === 0) {
    console.log('No ungraded auto-imported games for the live week.');
    return;
  }

  const data = await fetchScoreboard({
    dates: String(week.espnSeason),
    seasontype: String(week.espnSeasonType ?? 2),
    week: String(week.espnWeek),
  });
  const byId = {};
  (data.events || []).forEach((ev) => {
    byId[ev.id] = ev;
  });

  let graded = 0;
  for (const doc of openGames) {
    const g = doc.data();
    const ev = byId[g.espnEventId];
    const comp = ev && ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const completed = comp.status && comp.status.type && comp.status.type.completed;
    if (!completed) continue;
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

    const atsResult = gradeGame(g.favorite, g.spread || 0, homeScore, awayScore);
    await doc.ref.update({ atsResult, final: true, homeScore, awayScore });
    graded++;
  }
  console.log(`Graded ${graded} game(s) for ${weekId}.`);
}

async function importCurrentWeek(db) {
  const data = await fetchScoreboard({});
  const season = data.season && data.season.year;
  const seasonType = data.season && data.season.type;
  const weekNumber = data.week && data.week.number;
  if (!season || !weekNumber) {
    console.log('Could not read season/week from ESPN response — aborting import.');
    return;
  }
  const { weekId, label } = weekIdAndLabel(season, seasonType, weekNumber);
  const events = data.events || [];

  const weekRef = db.doc('weeks/' + weekId);
  const weekSnap = await weekRef.get();
  if (!weekSnap.exists) {
    await weekRef.set({
      label,
      locked: false,
      createdAt: new Date().toISOString(),
      deadline: null, // per-game kickoff locks handle this instead
      espnSeason: season,
      espnSeasonType: seasonType,
      espnWeek: weekNumber,
    });
    console.log(`Created ${weekId} (${label}).`);
  }

  // ESPN drops the odds field once a game goes final, so a mid-week rerun
  // (e.g. refreshing Sunday's lines after Thursday's game already finished)
  // must not stomp a game that already has a good spread stored. Only
  // write favorite/spread when this fetch actually has odds, or the game
  // is brand new to us.
  const existingSnap = await db.collection('games').where('weekId', '==', weekId).get();
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));

  let count = 0;
  for (const ev of events) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const payload = {
      weekId,
      order: count,
      espnEventId: ev.id,
      away: away.team.displayName,
      home: home.team.displayName,
      awayLogo: away.team.logo || null,
      homeLogo: home.team.logo || null,
      kickoff: ev.date || comp.date || null,
    };

    const oddsEntry = comp.odds && comp.odds[0];
    if (oddsEntry && typeof oddsEntry.spread === 'number') {
      payload.favorite = oddsEntry.spread < 0 ? 'home' : oddsEntry.spread > 0 ? 'away' : null;
      payload.spread = Math.abs(oddsEntry.spread);
    } else if (!existingIds.has(ev.id)) {
      // Brand new game with no line yet (rare) — set sane defaults rather
      // than leaving the fields undefined.
      payload.favorite = null;
      payload.spread = 0;
    }

    await db.doc('games/' + ev.id).set(payload, { merge: true });
    count++;
  }
  console.log(`Imported ${count} game(s) into ${weekId}.`);

  if (AUTO_PUBLISH) {
    await db.doc('meta/current').set({ weekId });
    console.log(`Set ${weekId} as the live week.`);
  } else {
    console.log(`AUTO_PUBLISH is off — go set ${weekId} live from Admin once you've checked it.`);
  }
}

async function main() {
  const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  await gradePreviousWeek(db);
  await importCurrentWeek(db);
}

main()
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
