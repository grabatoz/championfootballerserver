import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import models from '../src/models';
import sequelize from '../src/config/database';
import { Op } from 'sequelize';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

async function main() {
  const id = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';
  console.log(`Profiling queries for player ID: ${id}\n`);

  // Query 1
  let start = Date.now();
  const player = await UserModel.findByPk(id, {
    attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType', 'shirtNumber', 'email'],
    include: [{
      model: LeagueModel,
      as: 'leagues',
      attributes: ['id', 'name', 'image']
    }]
  });
  console.log(`Query 1 (User + leagues) took: ${Date.now() - start}ms`);

  // Query 2
  start = Date.now();
  const statRows = await MatchStatistics.findAll({
    where: { user_id: id },
    attributes: ['id', 'goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact', 'rating', 'xpAwarded', 'match_id'],
    raw: true,
  });
  console.log(`Query 2 (MatchStatistics) took: ${Date.now() - start}ms`);

  // Query 3
  start = Date.now();
  const [homeMatches, awayMatches] = await Promise.all([
    sequelize.query(
      `SELECT "matchId" FROM "UserHomeMatches" WHERE "userId" = :playerId`,
      { replacements: { playerId: id }, type: 'SELECT' as any }
    ),
    sequelize.query(
      `SELECT "matchId" FROM "UserAwayMatches" WHERE "userId" = :playerId`,
      { replacements: { playerId: id }, type: 'SELECT' as any }
    )
  ]);
  console.log(`Query 3 (UserHome/Away Matches IDs) took: ${Date.now() - start}ms`);

  const uniqueMatchIdsFromStats = Array.from(new Set((statRows as any[]).map((stat) => String(stat.match_id)).filter(Boolean)));
  const userHomeMatchIds = new Set((homeMatches as any[]).map((row) => String(row.matchId)));
  const userAwayMatchIds = new Set((awayMatches as any[]).map((row) => String(row.matchId)));
  const playedMatchIds = Array.from(new Set([
    ...userHomeMatchIds,
    ...userAwayMatchIds
  ])).filter(Boolean);
  const uniqueMatchIds = Array.from(new Set([
    ...uniqueMatchIdsFromStats,
    ...playedMatchIds
  ])).filter(Boolean);

  console.log(`Total unique match IDs: ${uniqueMatchIds.length}`);

  // Query 4
  start = Date.now();
  const allMatches = uniqueMatchIds.length
    ? await MatchModel.findAll({
        where: {
          id: { [Op.in]: uniqueMatchIds },
          status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED'] },
        },
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
      })
    : [];
  console.log(`Query 4 (All player matches) took: ${Date.now() - start}ms`);

  const visibleMatchIds = allMatches.map((match: any) => String(match.id));

  // Query 5
  start = Date.now();
  const voteRows = visibleMatchIds.length
    ? await Vote.findAll({
        where: { matchId: { [Op.in]: visibleMatchIds } },
        attributes: ['voterId', 'votedForId', 'matchId'],
        raw: true,
      })
    : [];
  console.log(`Query 5 (Votes) took: ${Date.now() - start}ms`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
