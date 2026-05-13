import models from '../models';
import { xpAchievements } from './xpAchievements';
import { QueryTypes } from 'sequelize';

/**
 * Recalculate and persist the user's total XP as:
 *   sum(MatchStatistics.xpAwarded for RESULT_PUBLISHED matches)
 *   + sum(achievement.xp for user.achievements)
 */
export async function recalcUserTotalXP(userId: string): Promise<number | null> {
  try {
    const MatchStatistics = (models as any).MatchStatistics;
    const Match = (models as any).Match;
    const User = (models as any).User;

    const getTableName = (model: any): string => {
      const tn = model.getTableName?.() ?? model.tableName;
      return typeof tn === 'object' ? `"${tn.schema}"."${tn.tableName}"` : `"${tn}"`;
    };

    const matchStatsTable = getTableName(MatchStatistics);
    const matchesTable = getTableName(Match);
    const xpRowsRaw = await MatchStatistics.sequelize.query(
      `
        SELECT COALESCE(SUM(ms.xp_awarded), 0)::int AS "matchXP"
        FROM ${matchStatsTable} ms
        INNER JOIN ${matchesTable} m ON m."id" = ms."match_id"
        WHERE ms."user_id" = :userId
          AND m."status" = 'RESULT_PUBLISHED'
      `,
      {
        replacements: { userId },
        type: QueryTypes.SELECT,
      }
    );
    const xpRows = xpRowsRaw as Array<{ matchXP: number }>;
    const matchXP = Number(xpRows[0]?.matchXP || 0);

    const user = await User.findByPk(userId, { attributes: ['id', 'xp', 'achievements'] });
    if (!user) return null;
    const achIds: string[] = Array.isArray(user.achievements) ? user.achievements : [];
    const achXP = achIds.reduce((sum, id) => {
      const a = xpAchievements.find(x => x.id === id);
      return sum + (a?.xp || 0);
    }, 0);

    const total = matchXP + achXP;
    user.xp = total;
    await user.save();
    return total;
  } catch (e) {
    console.warn('recalcUserTotalXP failed', e);
    return null;
  }
}
