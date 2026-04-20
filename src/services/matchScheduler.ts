import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import Match from '../models/Match';
import Notification from '../models/Notification';

// Track which matches have already been notified to avoid duplicate notifications
const notifiedMatches = new Set<string>();
let schedulerRunInProgress = false;

const isConnectionTerminatedError = (error: unknown): boolean => {
  const err = error as {
    message?: string;
    code?: string;
    original?: { message?: string; code?: string };
    parent?: { message?: string; code?: string };
  };

  const code = String(err?.code || err?.original?.code || err?.parent?.code || '').toUpperCase();
  const message = `${err?.message || ''} ${err?.original?.message || ''} ${err?.parent?.message || ''}`.toLowerCase();

  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(code)) {
    return true;
  }

  return (
    message.includes('connection terminated unexpectedly') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('connection reset by peer') ||
    message.includes('connection refused') ||
    message.includes('connection is closed')
  );
};

const withDbReconnectRetry = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (!isConnectionTerminatedError(error)) throw error;

    console.warn(`[Scheduler] DB connection dropped during "${label}". Reconnecting and retrying once...`);
    await sequelize.authenticate();
    return await operation();
  }
};

/**
 * Check for matches that have ended and update their status + send notifications
 * Runs periodically to:
 * 1. Update match status from SCHEDULED to RESULT_UPLOADED when match time ends
 * 2. Notify players when match time is over
 */
export async function checkEndedMatches() {
  if (schedulerRunInProgress) {
    console.log('[Scheduler] Skipping checkEndedMatches: previous run still in progress');
    return;
  }

  schedulerRunInProgress = true;

  try {
    const now = new Date();
    console.log('[Scheduler] Checking for ended matches at:', now.toISOString());

    // Find SCHEDULED matches that have ended (end time has passed)
    const scheduledEndedMatches = await withDbReconnectRetry('load scheduled-ended matches', () =>
      Match.findAll({
        where: {
          end: {
            [Op.lte]: now,
          },
          status: 'SCHEDULED',
          archived: false,
        },
        attributes: ['id', 'homeTeamName', 'awayTeamName', 'end', 'location', 'leagueId', 'archived', 'status'],
      })
    );

    if (scheduledEndedMatches.length > 0) {
      console.log(`[Scheduler] Found ${scheduledEndedMatches.length} ended scheduled match(es). Updating to RESULT_UPLOADED...`);

      for (const match of scheduledEndedMatches) {
        try {
          await withDbReconnectRetry(`update match status for ${match.id}`, () =>
            Match.update(
              { status: 'RESULT_UPLOADED' },
              { where: { id: match.id } }
            )
          );
          console.log(`[Scheduler] Updated match ${match.id} => RESULT_UPLOADED`);
        } catch (updateError) {
          console.error(`[Scheduler] Failed to update match ${match.id}:`, updateError);
        }
      }
    }

    // Find all ended matches for notification (both newly updated and already RESULT_UPLOADED/RESULT_PUBLISHED)
    const endedMatches = await withDbReconnectRetry('load ended matches for notifications', () =>
      Match.findAll({
        where: {
          end: {
            [Op.lte]: now,
          },
          status: {
            [Op.in]: ['RESULT_UPLOADED', 'RESULT_PUBLISHED'],
          },
          archived: false,
        },
        attributes: ['id', 'homeTeamName', 'awayTeamName', 'end', 'location', 'leagueId', 'archived', 'status'],
      })
    );

    if (endedMatches.length === 0) {
      console.log('[Scheduler] No ended matches found for notification');
      return;
    }

    console.log(`[Scheduler] Processing ${endedMatches.length} ended match(es) for notifications`);

    for (const match of endedMatches) {
      if (match.archived) {
        continue;
      }

      if (notifiedMatches.has(match.id)) {
        continue;
      }

      // Check if we already sent notifications for this match
      const existingNotification = await withDbReconnectRetry(
        `check existing MATCH_ENDED notifications for ${match.id}`,
        () =>
          Notification.findOne({
            where: {
              type: 'MATCH_ENDED',
              meta: {
                matchId: match.id,
              } as any,
            },
          })
      );

      if (existingNotification) {
        notifiedMatches.add(match.id);
        continue;
      }

      // Get all players from both teams (home and away)
      const homeTeamPlayers = await withDbReconnectRetry(
        `load home players for ${match.id}`,
        async () =>
          (await sequelize.query(
            `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
            {
              replacements: { matchId: match.id },
              type: QueryTypes.SELECT,
            }
          )) as Array<{ userId: string }>
      );

      const awayTeamPlayers = await withDbReconnectRetry(
        `load away players for ${match.id}`,
        async () =>
          (await sequelize.query(
            `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
            {
              replacements: { matchId: match.id },
              type: QueryTypes.SELECT,
            }
          )) as Array<{ userId: string }>
      );

      const allPlayerIds = [
        ...homeTeamPlayers.map((p) => p.userId),
        ...awayTeamPlayers.map((p) => p.userId),
      ].filter(Boolean);

      if (allPlayerIds.length === 0) {
        notifiedMatches.add(match.id);
        continue;
      }

      for (const userId of allPlayerIds) {
        try {
          await withDbReconnectRetry(`create MATCH_ENDED notification for user ${userId}`, () =>
            (Notification as any).create({
              user_id: userId,
              type: 'MATCH_ENDED',
              title: 'Match Has Ended!',
              body: `The match "${match.homeTeamName} vs ${match.awayTeamName}" at ${match.location} has ended. Thank you for participating!`,
              meta: {
                matchId: match.id,
                leagueId: match.leagueId,
                matchEndTime: match.end ? new Date(match.end as unknown as string | Date).toISOString() : null,
              },
              read: false,
              created_at: new Date(),
            })
          );
        } catch (notifError) {
          console.error(`[Scheduler] Failed to send notification to user ${userId}:`, notifError);
        }
      }

      notifiedMatches.add(match.id);
    }
  } catch (error) {
    console.error('Error in checkEndedMatches scheduler:', error);
  } finally {
    schedulerRunInProgress = false;
  }
}

/**
 * Start the match end notification scheduler
 * Checks every minute for matches that have ended
 */
export function startMatchEndScheduler() {
  console.log('Starting Match End Notification Scheduler...');

  // Run immediately on startup
  void checkEndedMatches();

  // Then run every 1 minute (60000ms)
  const intervalId = setInterval(() => {
    void checkEndedMatches();
  }, 60000);

  return intervalId;
}

/**
 * Clear the notified matches cache (useful for testing or manual reset)
 */
export function clearNotifiedMatchesCache() {
  notifiedMatches.clear();
  console.log('Notified matches cache cleared');
}

