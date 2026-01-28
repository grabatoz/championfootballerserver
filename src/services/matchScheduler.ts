import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import Match from '../models/Match';
import { MatchAvailability } from '../models/MatchAvailability';
import Notification from '../models/Notification';
import User from '../models/User';

// Track which matches have already been notified to avoid duplicate notifications
const notifiedMatches = new Set<string>();

/**
 * Check for matches that have ended and update their status + send notifications
 * Runs periodically to:
 * 1. Update match status from SCHEDULED to RESULT_UPLOADED when match time ends
 * 2. Notify players when match time is over
 */
export async function checkEndedMatches() {
  try {
    const now = new Date();
    console.log('🔍 Checking for ended matches at:', now.toISOString());
    
    // Find SCHEDULED matches that have ended (end time has passed)
    // These need status update to RESULT_UPLOADED
    const scheduledEndedMatches = await Match.findAll({
      where: {
        end: {
          [Op.lte]: now, // Match end time is less than or equal to current time
        },
        status: 'SCHEDULED', // Only SCHEDULED matches
        archived: false, // Only non-archived matches
      },
      attributes: ['id', 'homeTeamName', 'awayTeamName', 'end', 'location', 'leagueId', 'archived', 'status'],
    });

    // Update status for SCHEDULED matches that have ended
    if (scheduledEndedMatches.length > 0) {
      console.log(`📝 Found ${scheduledEndedMatches.length} SCHEDULED match(es) that have ended - updating status to RESULT_UPLOADED`);
      
      for (const match of scheduledEndedMatches) {
        try {
          await Match.update(
            { status: 'RESULT_UPLOADED' },
            { where: { id: match.id } }
          );
          console.log(`✓ Updated match ${match.id} status to RESULT_UPLOADED`);
        } catch (updateError) {
          console.error(`✗ Failed to update match ${match.id} status:`, updateError);
        }
      }
    }
    
    // Find all ended matches for notification (both newly updated and already RESULT_UPLOADED)
    const endedMatches = await Match.findAll({
      where: {
        end: {
          [Op.lte]: now, // Match end time is less than or equal to current time
        },
        status: {
          [Op.in]: ['RESULT_UPLOADED', 'RESULT_PUBLISHED'], // Check RESULT_UPLOADED and RESULT_PUBLISHED
        },
        archived: false, // Only non-archived matches
      },
      attributes: ['id', 'homeTeamName', 'awayTeamName', 'end', 'location', 'leagueId', 'archived', 'status'],
    });

    console.log(`📊 Total ended matches for notification: ${endedMatches.length}`);

    if (endedMatches.length === 0) {
      console.log('✓ No ended matches found for notification');
      return;
    }

    console.log(`📢 Found ${endedMatches.length} ended match(es) to process`);
    
    // Log each match details
    endedMatches.forEach(match => {
      console.log(`  Match ID: ${match.id}, Status: ${match.status}, Archived: ${match.archived}, End: ${match.end}`);
    });

    for (const match of endedMatches) {
      // Skip archived matches
      if (match.archived) {
        console.log(`⏭️  Skipping archived match ${match.id}`);
        continue;
      }
      
      // Skip if we've already notified for this match
      if (notifiedMatches.has(match.id)) {
        console.log(`⏭️  Already notified for match ${match.id}`);
        continue;
      }

      console.log(`🔔 Processing match ${match.id}: ${match.homeTeamName} vs ${match.awayTeamName}`);

      // Check if we've already sent notifications for this match (check database)
      const existingNotification = await Notification.findOne({
        where: {
          type: 'MATCH_ENDED',
          meta: {
            matchId: match.id,
          } as any,
        },
      });

      if (existingNotification) {
        console.log(`⏭️  Already sent notifications for match ${match.id} (found in database)`);
        notifiedMatches.add(match.id);
        continue;
      }

      // Get all players from both teams (home and away)
      const homeTeamPlayers = await sequelize.query(
        `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
        {
          replacements: { matchId: match.id },
          type: QueryTypes.SELECT,
        }
      ) as Array<{ userId: string }>;

      const awayTeamPlayers = await sequelize.query(
        `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
        {
          replacements: { matchId: match.id },
          type: QueryTypes.SELECT,
        }
      ) as Array<{ userId: string }>;

      // Combine both teams
      const allPlayerIds = [
        ...homeTeamPlayers.map(p => p.userId),
        ...awayTeamPlayers.map(p => p.userId),
      ];

      if (allPlayerIds.length === 0) {
        console.log(`⚠️  No players found in teams for match ${match.id}`);
        notifiedMatches.add(match.id);
        continue;
      }

      console.log(`📤 Sending notifications to ${allPlayerIds.length} player(s) for match: ${match.homeTeamName} vs ${match.awayTeamName}`);

      // Send notification to each player
      for (const userId of allPlayerIds) {
        if (!userId) continue;

        try {
          await (Notification as any).create({
            user_id: userId,
            type: 'MATCH_ENDED',
            title: '⏰ Match Has Ended!',
            body: `The match "${match.homeTeamName} vs ${match.awayTeamName}" at ${match.location} has ended. Thank you for participating!`,
            meta: {
              matchId: match.id,
              leagueId: match.leagueId,
              matchEndTime: match.end.toISOString(),
            },
            read: false,
            created_at: new Date(),
          });
          
          console.log(`✓ Notification sent to user ${userId}`);
        } catch (notifError) {
          console.error(`✗ Failed to send notification to user ${userId}:`, notifError);
        }
      }

      // Mark this match as notified
      notifiedMatches.add(match.id);
      console.log(`✓ Completed notifications for match ${match.id}`);
    }

  } catch (error) {
    console.error('❌ Error in checkEndedMatches scheduler:', error);
  }
}

/**
 * Start the match end notification scheduler
 * Checks every minute for matches that have ended
 */
export function startMatchEndScheduler() {
  console.log('🚀 Starting Match End Notification Scheduler...');
  
  // Run immediately on startup
  checkEndedMatches();
  
  // Then run every 1 minute (60000ms)
  const intervalId = setInterval(() => {
    checkEndedMatches();
  }, 60000); // Check every minute

  // Return the interval ID so it can be cleared if needed
  return intervalId;
}

/**
 * Clear the notified matches cache (useful for testing or manual reset)
 */
export function clearNotifiedMatchesCache() {
  notifiedMatches.clear();
  console.log('🔄 Notified matches cache cleared');
}
