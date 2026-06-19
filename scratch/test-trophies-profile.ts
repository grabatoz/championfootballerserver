import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import models from '../src/models';
import sequelize from '../src/config/database';
import { Op } from 'sequelize';

const { League: LeagueModel, Match: MatchModel, MatchStatistics, Vote } = models;

async function main() {
  const playerId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';

  console.log('Profiling queries inside /players/:id/trophies...');
  
  // Warm up connections
  await sequelize.query('SELECT 1');

  // Step 1: get league IDs
  let t = Date.now();
  const queryType = (sequelize as any).constructor.QueryTypes.SELECT;
  const [memberRows, adminRows, playedStatRows]: any[] = await Promise.all([
    sequelize.query(
      `SELECT "leagueId" FROM "LeagueMember" WHERE "userId" = :uid`,
      { replacements: { uid: playerId }, type: queryType }
    ),
    sequelize.query(
      `SELECT "leagueId" FROM "LeagueAdmin" WHERE "userId" = :uid`,
      { replacements: { uid: playerId }, type: queryType }
    ),
    MatchStatistics.findAll({
      where: { user_id: playerId },
      attributes: ['match_id'],
      raw: true,
    }),
  ]);
  console.log(`- Query Step 1 (League IDs info): ${Date.now() - t}ms`);

  const playedMatchIds: string[] = Array.from(new Set<string>((playedStatRows || [])
    .map((row: any) => String(row.match_id || '').trim())
    .filter((id: string) => Boolean(id))));
  
  t = Date.now();
  const playedLeagueRows = playedMatchIds.length > 0
    ? await MatchModel.findAll({
        where: { id: { [Op.in]: playedMatchIds } },
        attributes: ['leagueId'],
        raw: true,
      })
    : [];
  console.log(`- Query Step 1b (Played matches -> leagues): ${Date.now() - t}ms`);

  const userLeagueIds = Array.from(new Set([
    ...(memberRows || []),
    ...(adminRows || []),
    ...(playedLeagueRows || []),
  ]
    .map((r: any) => String(r.leagueId || '').trim())
    .filter(Boolean)));
  console.log(`User League IDs (${userLeagueIds.length}):`, userLeagueIds);

  if (!userLeagueIds.length) return;

  // Step 2: fetch leagues with members
  t = Date.now();
  const fetchedLeagues = await LeagueModel.findAll({
    where: { id: { [Op.in]: userLeagueIds } },
    attributes: ['id', 'name', 'maxGames', 'active', 'archived', 'createdAt', 'updatedAt'],
    include: [
      { model: models.User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'xp'] },
    ],
  });
  console.log(`- Query Step 2 (Leagues with members): ${Date.now() - t}ms`);

  // Step 3: fetch all matches in these leagues
  t = Date.now();
  const leagueIds = fetchedLeagues.map((l: any) => String(l.id));
  const leagueMatches = await MatchModel.findAll({
    where: {
      leagueId: { [Op.in]: leagueIds },
      status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] },
    },
    attributes: ['id', 'leagueId', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId'],
    raw: true,
  });
  console.log(`- Query Step 3 (All matches in leagues): ${Date.now() - t}ms (matches: ${leagueMatches.length})`);

  const allMatchIds = (leagueMatches as any[]).map((m: any) => String(m.id));

  if (allMatchIds.length === 0) return;

  // Step 4: Home/Away matches player association
  t = Date.now();
  const [homeRows, awayRows] = await Promise.all([
    sequelize.query(
      `SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds: allMatchIds }, type: 'SELECT' as any }
    ),
    sequelize.query(
      `SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds)`,
      { replacements: { matchIds: allMatchIds }, type: 'SELECT' as any }
    ),
  ]);
  console.log(`- Query Step 4 (Home/Away matches association): ${Date.now() - t}ms (home: ${homeRows.length}, away: ${awayRows.length})`);

  // Step 5: Seasons info
  t = Date.now();
  const allSeasons = await models.Season.findAll({
    where: { leagueId: { [Op.in]: leagueIds }, deleted: false },
    attributes: ['id', 'leagueId', 'seasonNumber', 'name', 'isActive', 'archived', 'startDate', 'endDate', 'maxGames', 'trophyAwardSnapshot', 'createdAt', 'updatedAt'],
    raw: true,
  });
  console.log(`- Query Step 5 (Seasons query): ${Date.now() - t}ms (seasons: ${allSeasons.length})`);

  // Step 6: MatchStatistics and Votes
  t = Date.now();
  const [matchStatRows, voteRows] = await Promise.all([
    MatchStatistics.findAll({
      where: { match_id: { [Op.in]: allMatchIds } },
      attributes: ['match_id', 'user_id', 'goals', 'assists'],
      raw: true,
    }),
    Vote.findAll({
      where: { matchId: { [Op.in]: allMatchIds } },
      attributes: ['matchId', 'voterId', 'votedForId'],
      raw: true,
    }),
  ]);
  console.log(`- Query Step 6 (MatchStatistics & Votes): ${Date.now() - t}ms (stats: ${matchStatRows.length}, votes: ${voteRows.length})`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
