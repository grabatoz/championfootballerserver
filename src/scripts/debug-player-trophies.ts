import models from '../models';
import { Op } from 'sequelize';

async function testTrophies() {
  const playerId = '3a7d8367-e42e-41b2-8037-dd4d492a963f';
  console.log('--- STARTING PLAYER TROPHIES TEST ---');
  
  const start = Date.now();

  try {
    const sequelize = models.User.sequelize!;
    
    console.log('Step 1: Fetching league IDs...');
    const memberRows: any[] = await sequelize.query(
      `SELECT "leagueId" FROM "LeagueMember" WHERE "userId" = :uid`,
      { replacements: { uid: playerId }, type: 'SELECT' as any }
    );
    const userLeagueIds = memberRows.map((r: any) => r.leagueId);
    console.log(`User is in ${userLeagueIds.length} leagues:`, userLeagueIds);
    if (!userLeagueIds.length) {
      console.log('No leagues found.');
      return;
    }

    console.log('Step 2: Fetching leagues with members...');
    const fetchedLeagues = await models.League.findAll({
      where: { id: { [Op.in]: userLeagueIds } },
      attributes: ['id', 'name', 'maxGames'],
      include: [
        { model: models.User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'xp'] },
      ],
    });
    console.log(`Loaded leagues: ${fetchedLeagues.length}`);

    console.log('Step 3: Fetching matches...');
    const leagueIds = fetchedLeagues.map((l: any) => String(l.id));
    const leagueMatches = await models.Match.findAll({
      where: {
        leagueId: { [Op.in]: leagueIds },
        status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] },
      },
      attributes: ['id', 'leagueId', 'seasonId', 'status', 'date', 'homeTeamGoals', 'awayTeamGoals'],
      raw: true,
    });
    console.log(`Loaded matches: ${leagueMatches.length}`);

    const allMatchIds = (leagueMatches as any[]).map((m: any) => String(m.id));
    console.log('Step 4: Fetching home/away user relations...');
    const homeByMatch = new Map<string, Array<{ id: string }>>();
    const awayByMatch = new Map<string, Array<{ id: string }>>();

    if (allMatchIds.length > 0) {
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

      (homeRows as any[]).forEach((row) => {
        const matchId = String(row.matchId);
        if (!homeByMatch.has(matchId)) homeByMatch.set(matchId, []);
        homeByMatch.get(matchId)!.push({ id: String(row.userId) });
      });
      (awayRows as any[]).forEach((row) => {
        const matchId = String(row.matchId);
        if (!awayByMatch.has(matchId)) awayByMatch.set(matchId, []);
        awayByMatch.get(matchId)!.push({ id: String(row.userId) });
      });
      console.log(`Mapped teams for ${allMatchIds.length} matches.`);
    }

    console.log(`Trophies test completed in ${Date.now() - start}ms`);
    process.exit(0);
  } catch (err: any) {
    console.error('Error occurred:', err);
    process.exit(1);
  }
}

testTrophies();
