import models from '../models';
import { xpAchievements } from './xpAchievements';

/**
 * Recalculate and persist the user's total XP as:
 *   sum(MatchStatistics.xpAwarded) + sum(achievement.xp for user.achievements)
 */
export async function recalcUserTotalXP(userId: string): Promise<number | null> {
  try {
    const MatchStatistics = (models as any).MatchStatistics;
    const User = (models as any).User;

    const statsRows = await MatchStatistics.findAll({ where: { user_id: userId }, attributes: ['xpAwarded'], raw: true });
    const matchXP = (statsRows as any[]).reduce((sum, r) => sum + (Number(r.xpAwarded) || 0), 0);

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
