import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import models from '../src/models';
import { Op } from 'sequelize';
import sequelize from '../src/config/database';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

async function main() {
  const id = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'; // sample playerId
  const leagueId = 'all';
  const year = 'all';

  console.log('Profiling queries inside getPlayerProfile...');

  // 1. Get player basic info
  let t = Date.now();
  const player = await UserModel.findByPk(id, {
    attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType', 'shirtNumber', 'email'],
    include: [{
      model: LeagueModel,
      as: 'leagues',
      attributes: ['id', 'name', 'image']
    }]
  });
  console.log(`- Query 1 (User info & leagues): ${Date.now() - t}ms`);

  // 2. Get MatchStatistics
  t = Date.now();
  const statRows = await MatchStatistics.findAll({
    where: { user_id: id },
    attributes: ['id', 'goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact', 'rating', 'xpAwarded', 'match_id'],
    raw: true,
  });
  console.log(`- Query 2 (MatchStatistics): ${Date.now() - t}ms (rows: ${statRows.length})`);

  const uniqueMatchIds = Array.from(new Set((statRows as any[]).map((stat) => String(stat.match_id)).filter(Boolean)));
  console.log(`Unique matches: ${uniqueMatchIds.length}`);

  if (uniqueMatchIds.length === 0) {
    console.log('No matches found for player.');
    return;
  }

  // 3. Get all published match rows (date only)
  t = Date.now();
  const allPublishedMatchRows = await MatchModel.findAll({
    where: {
      id: { [Op.in]: uniqueMatchIds },
      status: 'RESULT_PUBLISHED',
    },
    attributes: ['date'],
    raw: true,
  });
  console.log(`- Query 3 (All published match rows): ${Date.now() - t}ms`);

  const selectedLeagueId = typeof leagueId === 'string' && leagueId.trim() && leagueId !== 'all' ? leagueId.trim() : '';
  const selectedYear = typeof year === 'string' && year.trim() && year !== 'all' ? Number(year) : null;

  const matchWhere: any = {
    id: { [Op.in]: uniqueMatchIds },
    status: 'RESULT_PUBLISHED',
  };
  if (selectedLeagueId) {
    matchWhere.leagueId = selectedLeagueId;
  }

  // 4. Get detailed match rows
  t = Date.now();
  let matchRows = await MatchModel.findAll({
    where: matchWhere,
    attributes: [
      'id',
      'date',
      'seasonId',
      'homeTeamName',
      'awayTeamName',
      'location',
      'leagueId',
      'end',
      'homeDefensiveImpactId',
      'awayDefensiveImpactId',
      'homeMentalityId',
      'awayMentalityId',
      'homeTeamGoals',
      'awayTeamGoals',
    ],
    raw: true,
  });
  console.log(`- Query 4 (Detailed match rows): ${Date.now() - t}ms (rows: ${matchRows.length})`);

  if (selectedYear && Number.isFinite(selectedYear)) {
    matchRows = matchRows.filter((match) => new Date(match.date).getFullYear() === selectedYear);
  }

  const visibleMatchIds = matchRows.map((match) => String(match.id));

  if (visibleMatchIds.length === 0) {
    console.log('No visible matches.');
    return;
  }

  // 5. Vote query
  t = Date.now();
  const voteRows = await Vote.findAll({
    where: { matchId: { [Op.in]: visibleMatchIds } },
    attributes: ['voterId', 'votedForId', 'matchId'],
    raw: true,
  });
  console.log(`- Query 5 (Votes): ${Date.now() - t}ms (rows: ${voteRows.length})`);

  // 6. UserHomeMatches query
  t = Date.now();
  const homeRows = await sequelize.query(
    `SELECT "matchId" FROM "UserHomeMatches" WHERE "userId" = :playerId AND "matchId" IN (:matchIds)`,
    { replacements: { playerId: id, matchIds: visibleMatchIds }, type: 'SELECT' as any }
  );
  console.log(`- Query 6 (UserHomeMatches): ${Date.now() - t}ms (rows: ${homeRows.length})`);

  // 7. UserAwayMatches query
  t = Date.now();
  const awayRows = await sequelize.query(
    `SELECT "matchId" FROM "UserAwayMatches" WHERE "userId" = :playerId AND "matchId" IN (:matchIds)`,
    { replacements: { playerId: id, matchIds: visibleMatchIds }, type: 'SELECT' as any }
  );
  console.log(`- Query 7 (UserAwayMatches): ${Date.now() - t}ms (rows: ${awayRows.length})`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
