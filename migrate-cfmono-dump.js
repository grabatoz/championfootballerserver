#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_FILE = path.join(process.env.USERPROFILE || '', 'Documents', 'cfmono repo');

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === '--file' || token === '-f') && argv[i + 1]) {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
  }
  return args;
}

function printHelp() {
  console.log('Usage: node migrate-cfmono-dump.js --file "C:\\path\\to\\dump"');
  console.log('Options:');
  console.log('  -f, --file     PGDMP dump file path');
  console.log('  --dry-run      Parse and map data without writing to DB');
  console.log('  -h, --help     Show help');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

function calculateMigrationXP(sourceUsers, sourceMatches, sourceMatchStats, sourceVotes, sourceHomeUsers, sourceAwayUsers) {
  const xpPointsTable = {
    winningTeam: 30,
    draw: 15,
    losingTeam: 10,
    motm: { win: 10, lose: 5 },
    cleanSheet: 5,
    goal: { win: 3, lose: 2 },
    assist: { win: 2, lose: 1 },
    motmVote: { win: 2, lose: 1 },
    defensiveImpact: { win: 2, lose: 1 },
    mentality: { win: 2, lose: 2 },
  };

  const userXPMap = new Map(); // userId -> totalXP
  const statXPMap = new Map(); // key -> xp_awarded

  const matchHomePlayers = new Map(); // matchId -> Set of userIds
  const matchAwayPlayers = new Map(); // matchId -> Set of userIds

  for (const r of sourceHomeUsers) {
    const matchId = String(r.A || '');
    const userId = String(r.B || '');
    if (!matchHomePlayers.has(matchId)) {
      matchHomePlayers.set(matchId, new Set());
    }
    matchHomePlayers.get(matchId).add(userId);
  }

  for (const r of sourceAwayUsers) {
    const matchId = String(r.A || '');
    const userId = String(r.B || '');
    if (!matchAwayPlayers.has(matchId)) {
      matchAwayPlayers.set(matchId, new Set());
    }
    matchAwayPlayers.get(matchId).add(userId);
  }

  const matchVotes = new Map(); // matchId -> array of votes
  for (const v of sourceVotes) {
    const matchId = String(v.matchId || '');
    if (!matchVotes.has(matchId)) {
      matchVotes.set(matchId, []);
    }
    matchVotes.get(matchId).push(v);
  }

  const matchStatsGrouped = new Map(); // matchId -> Map of userId -> stats object
  for (const s of sourceMatchStats) {
    const matchId = String(s.matchId || '');
    const userId = String(s.userId || '');
    if (!matchStatsGrouped.has(matchId)) {
      matchStatsGrouped.set(matchId, new Map());
    }
    const playerStatsMap = matchStatsGrouped.get(matchId);
    if (!playerStatsMap.has(userId)) {
      playerStatsMap.set(userId, {
        goals: 0,
        assists: 0,
        clean_sheets: 0,
      });
    }
    const ps = playerStatsMap.get(userId);
    const value = toNullableInt(s.value) || 0;
    const statType = String(s.type || '');
    if (statType === 'GoalsScored') ps.goals += value;
    else if (statType === 'GoalsAssisted') ps.assists += value;
    else if (statType === 'CleanSheets') ps.clean_sheets += value;
  }

  for (const m of sourceMatches) {
    const matchId = String(m.id || '');
    
    const homeGoals = toNullableInt(m.homeTeamGoals);
    const awayGoals = toNullableInt(m.awayTeamGoals);
    const hasScore = homeGoals !== null && awayGoals !== null;
    if (!hasScore) continue;

    const homePlayersSet = matchHomePlayers.get(matchId) || new Set();
    const awayPlayersSet = matchAwayPlayers.get(matchId) || new Set();
    const allPlayersInMatch = new Set([...homePlayersSet, ...awayPlayersSet]);

    const votesList = matchVotes.get(matchId) || [];
    const voteCounts = {};
    for (const v of votesList) {
      const votedForId = String(v.forUserId || '');
      voteCounts[votedForId] = (voteCounts[votedForId] || 0) + 1;
    }

    let motmId = null;
    let maxVotes = 0;
    for (const [id, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        motmId = id;
        maxVotes = count;
      }
    }

    const playerStatsMap = matchStatsGrouped.get(matchId) || new Map();

    for (const userId of allPlayersInMatch) {
      let xp = 0;
      const isHome = homePlayersSet.has(userId);

      let teamResult = 'lose';
      if (isHome && homeGoals > awayGoals) teamResult = 'win';
      else if (!isHome && awayGoals > homeGoals) teamResult = 'win';
      else if (homeGoals === awayGoals) teamResult = 'draw';

      if (teamResult === 'win') {
        xp += xpPointsTable.winningTeam;
      } else if (teamResult === 'draw') {
        xp += xpPointsTable.draw;
      } else {
        xp += xpPointsTable.losingTeam;
      }

      const ps = playerStatsMap.get(userId);
      if (ps) {
        if (ps.goals > 0) {
          xp += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * ps.goals;
        }
        if (ps.assists > 0) {
          xp += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * ps.assists;
        }
        if (ps.clean_sheets > 0) {
          xp += xpPointsTable.cleanSheet * ps.clean_sheets;
        }
      }

      if (motmId === userId) {
        xp += teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose;
      }

      const votesReceived = voteCounts[userId] || 0;
      if (votesReceived > 0) {
        xp += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * votesReceived;
      }

      if (String(m.homeDefensiveImpactId || '') === userId || String(m.awayDefensiveImpactId || '') === userId) {
        xp += teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
      }

      if (String(m.homeMentalityId || '') === userId || String(m.awayMentalityId || '') === userId) {
        xp += teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
      }

      const currentTotal = userXPMap.get(userId) || 0;
      userXPMap.set(userId, currentTotal + xp);

      statXPMap.set(`${matchId}|${userId}`, xp);
    }
  }

  return { userXPMap, statXPMap };
}

function toBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 't' || v === 'true' || v === '1') return true;
    if (v === 'f' || v === 'false' || v === '0') return false;
  }
  return fallback;
}

function normalizeSkills(rawAttributes) {
  const defaults = {
    dribbling: 50,
    shooting: 50,
    passing: 50,
    pace: 50,
    defending: 50,
    physical: 50,
  };

  if (!rawAttributes || typeof rawAttributes !== 'string') {
    return defaults;
  }

  try {
    const parsed = JSON.parse(rawAttributes);
    return {
      dribbling: toNullableInt(parsed.Dribbling ?? parsed.dribbling) ?? 50,
      shooting: toNullableInt(parsed.Shooting ?? parsed.shooting) ?? 50,
      passing: toNullableInt(parsed.Passing ?? parsed.passing) ?? 50,
      pace: toNullableInt(parsed.Pace ?? parsed.pace) ?? 50,
      defending: toNullableInt(parsed.Defending ?? parsed.defending) ?? 50,
      physical: toNullableInt(parsed.Physical ?? parsed.physical) ?? 50,
    };
  } catch {
    return defaults;
  }
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function uniqueBy(rows, keyBuilder) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = keyBuilder(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function readDumpMagic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(5);
  fs.readSync(fd, buf, 0, 5, 0);
  fs.closeSync(fd);
  return buf.toString('ascii');
}

function extractDumpJson(dumpPath) {
  const extractor = path.join(__dirname, 'extract-pgdump.py');
  if (!fs.existsSync(extractor)) {
    throw new Error(`Extractor not found: ${extractor}`);
  }

  const result = spawnSync(
    'python',
    [extractor, '--file', dumpPath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }
  );

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    if (details.includes('ModuleNotFoundError') && details.includes('pgdumplib')) {
      throw new Error('PGDMP extract failed: Python package "pgdumplib" is missing. Install with: python -m pip install pgdumplib');
    }
    throw new Error(`PGDMP extract failed.\n${details}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Failed parsing extractor output JSON: ${err.message}`);
  }
}

async function bulkInsert(client, tableName, columns, rows, chunkSize = 500) {
  if (!rows.length) return 0;
  let inserted = 0;

  for (const part of chunk(rows, chunkSize)) {
    const values = [];
    const tupleSql = part.map((row, rowIndex) => {
      const place = columns.map((_, colIndex) => {
        const paramPos = rowIndex * columns.length + colIndex + 1;
        values.push(row[colIndex]);
        return `$${paramPos}`;
      });
      return `(${place.join(', ')})`;
    });

    const sql = `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(', ')})
                 VALUES ${tupleSql.join(', ')}
                 ON CONFLICT DO NOTHING`;
    const res = await client.query(sql, values);
    inserted += Number(res.rowCount || 0);
  }
  return inserted;
}

function prepareUsers(sourceUsers, userXPMap) {
  const now = new Date().toISOString();
  return sourceUsers
    .filter((u) => isUuid(u.id))
    .map((u) => {
      const email = (u.email && String(u.email).trim()) || `migrated+${u.id}@local.invalid`;
      const firstName = (u.firstName && String(u.firstName).trim())
        || (u.displayName && String(u.displayName).trim())
        || 'Unknown';
      const lastName = (u.lastName && String(u.lastName).trim()) || 'User';
      const xp = userXPMap ? (userXPMap.get(String(u.id)) || 0) : 0;
      return [
        u.id,
        firstName,
        lastName,
        email,
        u.password || null,
        toNullableInt(u.age),
        u.gender || null,
        null,
        null,
        null,
        u.position || null,
        null,
        u.chemistryStyle || null,
        u.preferredFoot || null,
        u.shirtNumber || null,
        u.pictureKey || null,
        normalizeSkills(u.attributes),
        xp,
        [],
        null,
        null,
        u.createdAt || now,
        u.updatedAt || u.createdAt || now,
        false,
        null,
        null,
        null,
        null,
      ];
    });
}

function prepareLeagues(sourceLeagues) {
  const now = new Date().toISOString();
  const seenInviteCodes = new Set();
  const seenNames = new Set();
  return sourceLeagues
    .filter((l) => isUuid(l.id))
    .map((l) => {
      let inviteCode = (l.inviteCode && String(l.inviteCode).trim())
        || String(l.id).replace(/-/g, '').slice(0, 6).toUpperCase();
      
      let baseCode = inviteCode;
      let counter = 1;
      while (seenInviteCodes.has(inviteCode)) {
        inviteCode = `${baseCode.slice(0, 15 - String(counter).length)}${counter}`;
        counter += 1;
      }
      seenInviteCodes.add(inviteCode);

      let name = (l.name && String(l.name).trim()) || `League-${String(l.id).slice(0, 8)}`;
      let baseName = name;
      let nameCounter = 1;
      while (seenNames.has(name)) {
        name = `${baseName} ${nameCounter}`;
        nameCounter += 1;
      }
      seenNames.add(name);

      return [
        l.id,
        name,
        inviteCode,
        toNullableInt(l.maxGames),
        toBoolean(l.active, true),
        toBoolean(l.showPoints, true),
        null,
        l.createdAt || now,
        l.updatedAt || l.createdAt || now,
        false,
      ];
    });
}

function buildUserIdMap(sourceUsers, dbUsers) {
  const byId = new Map();
  const byEmail = new Map();
  for (const row of dbUsers) {
    if (row.id) byId.set(String(row.id), String(row.id));
    if (row.email) byEmail.set(String(row.email), String(row.id));
  }

  const map = new Map();
  for (const source of sourceUsers) {
    const sourceId = String(source.id || '');
    const email = source.email ? String(source.email) : null;
    if (byId.has(sourceId)) {
      map.set(sourceId, byId.get(sourceId));
      continue;
    }
    if (email && byEmail.has(email)) {
      map.set(sourceId, byEmail.get(email));
    }
  }
  return map;
}

function buildLeagueIdMap(sourceLeagues, dbLeagues) {
  const byId = new Map();
  const byInvite = new Map();
  const byName = new Map();

  for (const row of dbLeagues) {
    if (row.id) byId.set(String(row.id), String(row.id));
    if (row.inviteCode) byInvite.set(String(row.inviteCode), String(row.id));
    if (row.name) byName.set(String(row.name), String(row.id));
  }

  const map = new Map();
  for (const source of sourceLeagues) {
    const sourceId = String(source.id || '');
    const inviteCode = source.inviteCode ? String(source.inviteCode) : null;
    const name = source.name ? String(source.name) : null;
    if (byId.has(sourceId)) {
      map.set(sourceId, byId.get(sourceId));
      continue;
    }
    if (inviteCode && byInvite.has(inviteCode)) {
      map.set(sourceId, byInvite.get(inviteCode));
      continue;
    }
    if (name && byName.has(name)) {
      map.set(sourceId, byName.get(name));
    }
  }
  return map;
}

function prepareMatches(sourceMatches, leagueIdMap, leagueToSeasonMap) {
  const now = new Date().toISOString();
  const rows = [];
  for (const m of sourceMatches) {
    if (!isUuid(m.id)) continue;
    const mappedLeagueId = leagueIdMap.get(String(m.leagueId || ''));
    if (!mappedLeagueId) continue;

    const homeGoals = toNullableInt(m.homeTeamGoals);
    const awayGoals = toNullableInt(m.awayTeamGoals);
    const hasScore = homeGoals !== null && awayGoals !== null;
    const matchStart = m.start || m.createdAt || now;
    const matchEnd = m.end || m.start || m.createdAt || now;
    const status = hasScore ? 'RESULT_PUBLISHED' : 'SCHEDULED';
    const seasonId = leagueToSeasonMap ? leagueToSeasonMap.get(mappedLeagueId) : null;

    rows.push([
      m.id,
      matchStart,
      (m.location && String(m.location).trim()) || 'Unknown',
      status,
      hasScore ? { home: homeGoals, away: awayGoals } : null,
      mappedLeagueId,
      m.homeTeamName || null,
      m.awayTeamName || null,
      homeGoals,
      awayGoals,
      matchStart,
      matchEnd,
      m.notes || null,
      null,
      null,
      null,
      null,
      false,
      false,
      false,
      hasScore ? (m.updatedAt || m.createdAt || now) : null,
      hasScore ? (m.updatedAt || m.createdAt || now) : null,
      null,
      null,
      null,
      { home: [], away: [] },
      null,
      null,
      m.createdAt || now,
      m.updatedAt || m.createdAt || now,
      seasonId || null,
      null,
      null,
      null,
      null,
      false,
    ]);
  }
  return rows;
}

function prepareSessions(sourceSessions, userIdMap) {
  const now = new Date().toISOString();
  return sourceSessions
    .filter((s) => isUuid(s.id))
    .map((s) => {
      const mappedUserId = userIdMap.get(String(s.userId || ''));
      if (!mappedUserId) return null;
      return [
        s.id,
        mappedUserId,
        s.ipAddress || null,
        s.createdAt || now,
        s.updatedAt || s.createdAt || now,
        null,
        null,
        null,
      ];
    })
    .filter(Boolean);
}

function prepareVotes(sourceVotes, userIdMap, matchIdSet) {
  const now = new Date().toISOString();
  return sourceVotes
    .filter((v) => isUuid(v.id))
    .map((v) => {
      const mappedMatchId = String(v.matchId || '');
      const voterId = userIdMap.get(String(v.byUserId || ''));
      const votedForId = userIdMap.get(String(v.forUserId || ''));
      if (!matchIdSet.has(mappedMatchId) || !voterId || !votedForId) return null;
      return [
        v.id,
        mappedMatchId,
        voterId,
        votedForId,
        v.createdAt || now,
        v.createdAt || now,
      ];
    })
    .filter(Boolean);
}

function aggregateMatchStatistics(sourceStats, userIdMap, matchIdSet, statXPMap) {
  const grouped = new Map();
  const now = new Date().toISOString();

  for (const row of sourceStats) {
    const sourceMatchId = String(row.matchId || '');
    if (!matchIdSet.has(sourceMatchId)) continue;

    const mappedUserId = userIdMap.get(String(row.userId || ''));
    if (!mappedUserId) continue;
    const key = `${sourceMatchId}|${mappedUserId}`;
    const sourceUserId = String(row.userId || '');

    if (!grouped.has(key)) {
      const xpAwarded = statXPMap ? (statXPMap.get(`${sourceMatchId}|${sourceUserId}`) || 0) : 0;
      grouped.set(key, {
        id: isUuid(row.id) ? row.id : crypto.randomUUID(),
        user_id: mappedUserId,
        match_id: sourceMatchId,
        goals: 0,
        assists: 0,
        clean_sheets: 0,
        penalties: 0,
        free_kicks: 0,
        yellow_cards: 0,
        red_cards: 0,
        impact: 0,
        defence: 0,
        minutes_played: 0,
        rating: 0,
        type: null,
        value: null,
        xp_awarded: xpAwarded,
        created_at: row.createdAt || now,
        updated_at: row.createdAt || now,
      });
    }

    const stat = grouped.get(key);
    const value = toNullableInt(row.value) || 0;
    const statType = String(row.type || '');
    if (statType === 'GoalsScored') stat.goals += value;
    else if (statType === 'GoalsAssisted') stat.assists += value;
    else if (statType === 'CleanSheets') stat.clean_sheets += value;
    else if (statType === 'Penalties') stat.penalties += value;
    else if (statType === 'FreeKicks') stat.free_kicks += value;
  }

  return Array.from(grouped.values()).map((s) => ([
    s.id,
    s.user_id,
    s.match_id,
    s.goals,
    s.assists,
    s.clean_sheets,
    s.penalties,
    s.free_kicks,
    s.yellow_cards,
    s.red_cards,
    s.impact,
    s.defence,
    s.minutes_played,
    s.rating,
    s.type,
    s.value,
    s.xp_awarded,
    s.created_at,
    s.updated_at,
  ]));
}

function mapJoinRows(sourceRows, leftMap, rightMap, leftField = 'A', rightField = 'B') {
  const now = new Date().toISOString();
  const rows = sourceRows
    .map((r) => {
      const left = leftMap.get(String(r[leftField] || ''));
      const right = rightMap.get(String(r[rightField] || ''));
      if (!left || !right) return null;
      return [now, now, right, left];
    })
    .filter(Boolean);

  return uniqueBy(rows, (r) => `${r[2]}|${r[3]}`);
}

function mapUserMatchRows(sourceRows, userIdMap, matchIdSet) {
  const now = new Date().toISOString();
  const rows = sourceRows
    .map((r) => {
      const matchId = String(r.A || '');
      const userId = userIdMap.get(String(r.B || ''));
      if (!userId || !matchIdSet.has(matchId)) return null;
      return [now, now, userId, matchId];
    })
    .filter(Boolean);

  return uniqueBy(rows, (r) => `${r[2]}|${r[3]}`);
}

async function fetchUsersForResolution(client, sourceUsers) {
  const ids = Array.from(new Set(sourceUsers.map((u) => String(u.id || '')).filter(isUuid)));
  const emails = Array.from(new Set(sourceUsers.map((u) => u.email).filter((e) => typeof e === 'string' && e.trim())));

  if (!ids.length && !emails.length) return [];
  if (ids.length && emails.length) {
    const res = await client.query(
      'SELECT id::text AS id, email FROM users WHERE id = ANY($1::uuid[]) OR email = ANY($2::text[])',
      [ids, emails]
    );
    return res.rows;
  }
  if (ids.length) {
    const res = await client.query(
      'SELECT id::text AS id, email FROM users WHERE id = ANY($1::uuid[])',
      [ids]
    );
    return res.rows;
  }
  const res = await client.query(
    'SELECT id::text AS id, email FROM users WHERE email = ANY($1::text[])',
    [emails]
  );
  return res.rows;
}

async function fetchLeaguesForResolution(client, sourceLeagues) {
  const ids = Array.from(new Set(sourceLeagues.map((l) => String(l.id || '')).filter(isUuid)));
  const names = Array.from(new Set(sourceLeagues.map((l) => l.name).filter((n) => typeof n === 'string' && n.trim())));
  const inviteCodes = Array.from(new Set(sourceLeagues.map((l) => l.inviteCode).filter((c) => typeof c === 'string' && c.trim())));

  const clauses = [];
  const params = [];

  if (ids.length) {
    params.push(ids);
    clauses.push(`id = ANY($${params.length}::uuid[])`);
  }
  if (names.length) {
    params.push(names);
    clauses.push(`name = ANY($${params.length}::text[])`);
  }
  if (inviteCodes.length) {
    params.push(inviteCodes);
    clauses.push(`"inviteCode" = ANY($${params.length}::text[])`);
  }

  if (!clauses.length) return [];
  const sql = `SELECT id::text AS id, name, "inviteCode" FROM "Leagues" WHERE ${clauses.join(' OR ')}`;
  const res = await client.query(sql, params);
  return res.rows;
}

async function fetchMatchIdSet(client, sourceMatches) {
  const ids = Array.from(new Set(sourceMatches.map((m) => String(m.id || '')).filter(isUuid)));
  if (!ids.length) return new Set();
  const res = await client.query('SELECT id::text AS id FROM "Matches" WHERE id = ANY($1::uuid[])', [ids]);
  return new Set(res.rows.map((r) => String(r.id)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL in environment');
  }

  let dumpFile = path.resolve(args.file);
  if (!fs.existsSync(dumpFile)) {
    if (fs.existsSync(dumpFile + '.txt')) {
      dumpFile = dumpFile + '.txt';
    } else {
      throw new Error(`Dump file not found: ${dumpFile}`);
    }
  }

  const magic = readDumpMagic(dumpFile);
  if (magic !== 'PGDMP') {
    throw new Error(`Unsupported file format for "${dumpFile}". Expected PostgreSQL custom dump (PGDMP).`);
  }

  console.log(`Reading dump: ${dumpFile}`);
  const payload = extractDumpJson(dumpFile);
  const tables = payload.tables || {};

  const sourceUsers = tables.User || [];
  const sourceLeagues = tables.League || [];
  const sourceMatches = tables.Match || [];
  const sourceMatchStats = tables.MatchStatistic || [];
  const sourceVotes = tables.Vote || [];
  const sourceSessions = tables.Session || [];
  const sourceLeagueMembers = tables._users || [];
  const sourceLeagueAdmins = tables._admins || [];
  const sourceHomeUsers = tables._homeTeamUsers || [];
  const sourceAwayUsers = tables._awayTeamUsers || [];
  const sourceAvailableUsers = tables._availableUsers || [];

  console.log('Source row counts:', {
    users: sourceUsers.length,
    leagues: sourceLeagues.length,
    matches: sourceMatches.length,
    matchStats: sourceMatchStats.length,
    votes: sourceVotes.length,
    sessions: sourceSessions.length,
    leagueMembers: sourceLeagueMembers.length,
    leagueAdmins: sourceLeagueAdmins.length,
    homeUsers: sourceHomeUsers.length,
    awayUsers: sourceAwayUsers.length,
    availableUsers: sourceAvailableUsers.length,
  });

  if (args.dryRun) {
    console.log('Dry run enabled. Parsed source successfully. No DB writes were performed.');
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });

  client.on('error', (err) => {
    console.error('[DB client error]', err.message);
  });

  await client.connect();
  const summary = {};
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const { userXPMap, statXPMap } = calculateMigrationXP(
      sourceUsers,
      sourceMatches,
      sourceMatchStats,
      sourceVotes,
      sourceHomeUsers,
      sourceAwayUsers
    );

    const userCols = [
      'id', 'firstName', 'lastName', 'email', 'password', 'age', 'gender',
      'country', 'state', 'city', 'position', 'positionType', 'style',
      'preferredFoot', 'shirtNumber', 'profilePicture', 'skills', 'xp',
      'achievements', 'provider', 'providerId', 'createdAt', 'updatedAt',
      'isVerified', 'phone', 'resetCode', 'resetCodeExpiry', 'phoneCountryCode',
    ];
    const usersPrepared = prepareUsers(sourceUsers, userXPMap);
    summary.usersInserted = await bulkInsert(client, 'users', userCols, usersPrepared);

    const userRowsResolved = await fetchUsersForResolution(client, sourceUsers);
    const userIdMap = buildUserIdMap(sourceUsers, userRowsResolved);

    const leagueCols = [
      'id', 'name', 'inviteCode', 'maxGames', 'active', 'showPoints',
      'image', 'createdAt', 'updatedAt', 'archived',
    ];
    const leaguesPrepared = prepareLeagues(sourceLeagues);
    summary.leaguesInserted = await bulkInsert(client, 'Leagues', leagueCols, leaguesPrepared);

    const leagueRowsResolved = await fetchLeaguesForResolution(client, sourceLeagues);
    const leagueIdMap = buildLeagueIdMap(sourceLeagues, leagueRowsResolved);

    // Automatically create Season 1 for each resolved league
    const seasonCols = [
      'id', 'leagueId', 'seasonNumber', 'name', 'inviteCode', 'isActive',
      'archived', 'deleted', 'startDate', 'endDate', 'maxGames', 'showPoints',
      'trophyAwardSnapshot', 'createdAt', 'updatedAt',
    ];
    const seasonsPrepared = [];
    const leagueToSeasonMap = new Map();
    const nowStr = new Date().toISOString();

    // Fetch existing Season 1 for the resolved leagues to be idempotent
    const existingSeasonsRes = await client.query(
      'SELECT id::text AS id, "leagueId"::text AS "leagueId" FROM "Seasons" WHERE "seasonNumber" = 1 AND deleted = false'
    );
    for (const row of existingSeasonsRes.rows) {
      leagueToSeasonMap.set(row.leagueId, row.id);
    }

    const uniqueDbLeagueIds = Array.from(new Set(leagueIdMap.values()));
    for (const dbLeagueId of uniqueDbLeagueIds) {
      if (leagueToSeasonMap.has(dbLeagueId)) {
        continue;
      }
      
      const seasonId = crypto.randomUUID();
      const seasonInviteCode = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      
      leagueToSeasonMap.set(dbLeagueId, seasonId);
      
      seasonsPrepared.push([
        seasonId,
        dbLeagueId,
        1,
        'Season 1',
        seasonInviteCode,
        true,
        false,
        false,
        nowStr,
        null, // endDate
        null, // maxGames
        true, // showPoints
        {}, // trophyAwardSnapshot
        nowStr,
        nowStr,
      ]);
    }
    
    summary.seasonsInserted = await bulkInsert(client, 'Seasons', seasonCols, seasonsPrepared);

    const matchCols = [
      'id', 'date', 'location', 'status', 'score', 'leagueId', 'homeTeamName',
      'awayTeamName', 'homeTeamGoals', 'awayTeamGoals', 'start', 'end', 'notes',
      'homeCaptainId', 'awayCaptainId', 'homeTeamImage', 'awayTeamImage',
      'archived', 'homeCaptainConfirmed', 'awayCaptainConfirmed', 'resultUploadedAt',
      'resultPublishedAt', 'suggestedHomeGoals', 'suggestedAwayGoals', 'suggestedByCaptainId',
      'removed', 'homeWinPct', 'awayWinPct', 'createdAt', 'updatedAt', 'seasonId',
      'homeDefensiveImpactId', 'homeMentalityId', 'awayDefensiveImpactId', 'awayMentalityId',
      'deleted',
    ];
    const matchesPrepared = prepareMatches(sourceMatches, leagueIdMap, leagueToSeasonMap);
    summary.matchesInserted = await bulkInsert(client, 'Matches', matchCols, matchesPrepared);

    const matchIdSet = await fetchMatchIdSet(client, sourceMatches);

    const sessionCols = ['id', 'userId', 'ipAddress', 'createdAt', 'updatedAt', 'refreshTokenHash', 'expiresAt', 'revokedAt'];
    const sessionsPrepared = prepareSessions(sourceSessions, userIdMap);
    summary.sessionsInserted = await bulkInsert(client, 'Sessions', sessionCols, sessionsPrepared);

    const voteCols = ['id', 'matchId', 'voterId', 'votedForId', 'createdAt', 'updatedAt'];
    const votesPrepared = prepareVotes(sourceVotes, userIdMap, matchIdSet);
    summary.votesInserted = await bulkInsert(client, 'Votes', voteCols, votesPrepared);

    const statsCols = [
      'id', 'user_id', 'match_id', 'goals', 'assists', 'clean_sheets', 'penalties',
      'free_kicks', 'yellow_cards', 'red_cards', 'impact', 'defence', 'minutes_played',
      'rating', 'type', 'value', 'xp_awarded', 'created_at', 'updated_at',
    ];
    const statsPrepared = aggregateMatchStatistics(sourceMatchStats, userIdMap, matchIdSet, statXPMap);
    summary.matchStatsInserted = await bulkInsert(client, 'match_statistics', statsCols, statsPrepared);

    const leagueMemberCols = ['createdAt', 'updatedAt', 'userId', 'leagueId'];
    const leagueMembersPrepared = mapJoinRows(sourceLeagueMembers, leagueIdMap, userIdMap);
    summary.leagueMembersInserted = await bulkInsert(client, 'LeagueMember', leagueMemberCols, leagueMembersPrepared);

    const leagueAdminsPrepared = mapJoinRows(sourceLeagueAdmins, leagueIdMap, userIdMap);
    summary.leagueAdminsInserted = await bulkInsert(client, 'LeagueAdmin', leagueMemberCols, leagueAdminsPrepared);

    // Enroll members and admins into SeasonPlayers for Season 1
    const seasonPlayersCols = ['seasonId', 'userId', 'createdAt', 'updatedAt'];
    const seasonPlayersPrepared = [];
    const seenSeasonPlayers = new Set();

    for (const row of leagueMembersPrepared) {
      const userId = row[2];
      const leagueId = row[3];
      const seasonId = leagueToSeasonMap.get(leagueId);
      if (seasonId) {
        const key = `${seasonId}|${userId}`;
        if (!seenSeasonPlayers.has(key)) {
          seenSeasonPlayers.add(key);
          seasonPlayersPrepared.push([seasonId, userId, nowStr, nowStr]);
        }
      }
    }

    for (const row of leagueAdminsPrepared) {
      const userId = row[2];
      const leagueId = row[3];
      const seasonId = leagueToSeasonMap.get(leagueId);
      if (seasonId) {
        const key = `${seasonId}|${userId}`;
        if (!seenSeasonPlayers.has(key)) {
          seenSeasonPlayers.add(key);
          seasonPlayersPrepared.push([seasonId, userId, nowStr, nowStr]);
        }
      }
    }

    summary.seasonPlayersInserted = await bulkInsert(client, 'SeasonPlayers', seasonPlayersCols, seasonPlayersPrepared);

    const matchJoinCols = ['createdAt', 'updatedAt', 'userId', 'matchId'];
    const homeUsersPrepared = mapUserMatchRows(sourceHomeUsers, userIdMap, matchIdSet);
    const awayUsersPrepared = mapUserMatchRows(sourceAwayUsers, userIdMap, matchIdSet);
    const availableUsersPrepared = mapUserMatchRows(sourceAvailableUsers, userIdMap, matchIdSet);

    summary.homeUsersInserted = await bulkInsert(client, 'UserHomeMatches', matchJoinCols, homeUsersPrepared);
    summary.awayUsersInserted = await bulkInsert(client, 'UserAwayMatches', matchJoinCols, awayUsersPrepared);
    summary.userMatchAvailabilityInserted = await bulkInsert(client, 'UserMatchAvailability', matchJoinCols, availableUsersPrepared);

    const existingAvailability = await client.query('SELECT match_id::text AS match_id, user_id::text AS user_id FROM match_availabilities');
    const existingPairs = new Set(existingAvailability.rows.map((r) => `${r.match_id}|${r.user_id}`));
    const now = new Date().toISOString();
    const matchAvailRows = [];

    for (const row of availableUsersPrepared) {
      const userId = row[2];
      const matchId = row[3];
      const key = `${matchId}|${userId}`;
      if (existingPairs.has(key)) continue;
      existingPairs.add(key);
      matchAvailRows.push([crypto.randomUUID(), matchId, userId, 'available', null, now, now]);
    }

    const matchAvailCols = ['id', 'match_id', 'user_id', 'status', 'last_reminder_at', 'created_at', 'updated_at'];
    summary.matchAvailabilitiesInserted = await bulkInsert(client, 'match_availabilities', matchAvailCols, matchAvailRows);

    await client.query('COMMIT');
    transactionOpen = false;

    console.log('\nMigration completed.');
    console.log(summary);
  } catch (err) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[ROLLBACK failed]', rollbackErr.message);
      }
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
